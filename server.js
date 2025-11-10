// server.js COMPLETO E CORRIGIDO 🐷
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const db = require('./database');

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const { GRAPH_API_TOKEN, PHONE_NUMBER_ID, GRAPH_API_VERSION, WEBHOOK_VERIFY_TOKEN } = process.env;

// =========================================
// FUNÇÃO DE ENVIO (META API)
// =========================================
async function sendMessage(to, text) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
            headers: {
                'Authorization': `Bearer ${GRAPH_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                text: { body: text }
            }
        });
        // Registrar envio no banco (opcional, mas bom para histórico)
        db.get("SELECT id FROM leads WHERE phone = ?", [to], (err, row) => {
            if (row) {
                db.run("INSERT INTO messages (lead_id, type, body) VALUES (?, 'sent', ?)", [row.id, text]);
            }
        });
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem:', error.response ? error.response.data : error.message);
    }
}

// =========================================
// 🤖 CHATBOT FINANCEIRO (O COFRINHO)
// =========================================
async function handleChatbot(from, msgBody, leadName) {
    msgBody = msgBody.trim();
    const lowerMsg = msgBody.toLowerCase();

    // 1. Primeiro, garante que temos o ID desse usuário no banco
    db.get("SELECT id FROM leads WHERE phone = ?", [from], async (err, lead) => {
        if (err || !lead) {
            console.error("Erro ao encontrar lead para o bot:", err);
            return;
        }

        let response = "";

        // --- COMANDO: CONTROLE (Adicionar gasto) ---
        // Ex: "controle 50 mercado"
        if (lowerMsg.startsWith('controle ')) {
            const parts = msgBody.split(' ');
            // Tenta pegar o valor (substitui vírgula por ponto se o usuário usar)
            const valorStr = parts[1] ? parts[1].replace(',', '.') : '0';
            const valor = parseFloat(valorStr);
            // Pega o resto da frase como categoria
            const categoria = parts.slice(2).join(' ') || 'geral';

            if (isNaN(valor) || valor <= 0) {
                response = "❌ Valor inválido.\n\nUse assim:\n*controle 50 mercado*\n*controle 10.50 padaria*";
            } else {
                // Salva no banco
                db.run(`INSERT INTO transactions (lead_id, amount, category) VALUES (?, ?, ?)`, 
                    [lead.id, valor, categoria], 
                    function (err) { // Usando 'function' normal para ter acesso ao 'this.lastID'
                        if (!err) {
                            const novoID = this.lastID;
                            sendMessage(from, `✅ *Salvo!* (ID: ${novoID})\n💰 R$${valor.toFixed(2)}\n📂 ${categoria}`);
                        } else {
                            sendMessage(from, "❌ Erro ao salvar no cofrinho. Tente de novo.");
                        }
                    }
                );
                return; // Retorna aqui para não enviar response duplicado
            }

        // --- COMANDO: EXTRATO ---
        } else if (['extrato', 'saldo', 'ver', 'total'].includes(lowerMsg)) {
            // 1. Pega o total
            db.get("SELECT SUM(amount) as total FROM transactions WHERE lead_id = ?", [lead.id], (err, resTotal) => {
                const total = resTotal && resTotal.total ? resTotal.total : 0;
                
                // 2. Pega os últimos 5 lançamentos
                db.all("SELECT id, amount, category, created_at FROM transactions WHERE lead_id = ? ORDER BY id DESC LIMIT 5", [lead.id], async (err, rows) => {
                    let msg = `🐷 *SEU COFRINHO*\n\n💰 *TOTAL: R$${total.toFixed(2)}*\n\n📋 *Últimos lançamentos:*\n`;
                    
                    if (rows.length > 0) {
                        rows.forEach(t => {
                             // Formata a data rapidinho (dd/mm hh:mm)
                             const data = new Date(t.created_at);
                             const dataFormatada = `${data.getDate()}/${data.getMonth()+1} ${data.getHours()}:${String(data.getMinutes()).padStart(2, '0')}`;
                             msg += `🆔${t.id} | R$${t.amount.toFixed(2)} - ${t.category}\n`; // \nAdd data se quiser: (${dataFormatada})
                        });
                    } else {
                        msg += "(Nenhum lançamento ainda)";
                    }

                    msg += `\n\n💡 _Para apagar algo, use: *excluir [ID]*_`;
                    await sendMessage(from, msg);
                });
            });
            return;

        // --- COMANDO: EXCLUIR ---
        // Ex: "excluir 32"
        } else if (lowerMsg.startsWith('excluir ')) {
            const idParaExcluir = parseInt(lowerMsg.split(' ')[1]);

            if (!isNaN(idParaExcluir)) {
                db.run("DELETE FROM transactions WHERE id = ? AND lead_id = ?", [idParaExcluir, lead.id], function(err) {
                    if (this.changes > 0) {
                        sendMessage(from, `🗑️ Transação *ID ${idParaExcluir}* excluída.`);
                    } else {
                        sendMessage(from, `⚠️ Não encontrei a transação *ID ${idParaExcluir}* ou ela não é sua.`);
                    }
                });
            } else {
                 response = "❌ Use: *excluir [número do ID]*\nEx: _excluir 15_";
            }
            if (response) await sendMessage(from, response);
            return;

        // --- MENU INICIAL / BOAS VINDAS ---
        } else {
            response = `Olá ${leadName || ''}! 👋\nEu sou seu Bot Financeiro 🐷.\n\n*Comandos que entendo:*\n\n🆕 *controle [valor] [categoria]*\n_(Ex: controle 50 pizza)_\n\n📊 *extrato*\n_(Ver seu saldo e últimos gastos)_\n\n❌ *excluir [ID]*\n_(Apaga um lançamento errado)_`;
        }

        // Envia a resposta padrão se não caiu nos returns acima
        if (response) {
            await sendMessage(from, response);
        }
    });
}

// =========================================
// ROTAS DA API (WEBHOOK)
// =========================================
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
        console.log('✅ Webhook verificado!');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
        try {
            if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
                const value = body.entry[0].changes[0].value;
                const messageData = value.messages[0];
                const contactData = value.contacts ? value.contacts[0] : null;
                
                // Só processa se for mensagem de texto por enquanto
                if (messageData.type === 'text') {
                    const from = messageData.from;
                    const msgBody = messageData.text.body;
                    const name = contactData ? contactData.profile.name : 'Usuário';

                    console.log(`📩 ${name} (${from}) disse: ${msgBody}`);

                    // 1. Salva/Atualiza o Lead no banco primeiro
                    db.run(`INSERT INTO leads (phone, name, last_interaction) VALUES (?, ?, CURRENT_TIMESTAMP)
                            ON CONFLICT(phone) DO UPDATE SET last_interaction=CURRENT_TIMESTAMP, name=excluded.name`, 
                            [from, name], 
                            (err) => {
                                if (!err) {
                                    // 2. Chama o Chatbot Financeiro
                                    handleChatbot(from, msgBody, name);
                                    
                                    // 3. (Opcional) Salva o histórico da msg recebida
                                    db.get("SELECT id FROM leads WHERE phone = ?", [from], (e, row) => {
                                        if (row) db.run("INSERT INTO messages (lead_id, type, body) VALUES (?, 'received', ?)", [row.id, msgBody]);
                                    });
                                }
                            });
                }
            }
        } catch (e) {
            console.error('Erro no webhook:', e);
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// Rotas extras para o Dashboard (se ainda estiver usando)
app.get('/api/leads', (req, res) => {
    db.all("SELECT * FROM leads ORDER BY last_interaction DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
app.get('/api/messages/:leadId', (req, res) => {
    db.all("SELECT * FROM messages WHERE lead_id = ? ORDER BY timestamp ASC", [req.params.leadId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor Financeiro rodando na porta ${PORT}`);
});