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
// FUNÇÃO AUXILIAR: ENVIO DE MENSAGEM
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
        // Log opcional no banco
        db.get("SELECT id FROM leads WHERE phone = ?", [to], (err, row) => {
            if (row) db.run("INSERT INTO messages (lead_id, type, body) VALUES (?, 'sent', ?)", [row.id, text]);
        });
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem:', error.response ? error.response.data : error.message);
    }
}

// =========================================
// 🐷 BOT FINANCEIRO (LÓGICA PRINCIPAL)
// =========================================
async function handleChatbot(from, msgBody, leadName) {
    msgBody = msgBody.trim();
    const lowerMsg = msgBody.toLowerCase();

    // 1. Identifica o usuário no banco
    db.get("SELECT id FROM leads WHERE phone = ?", [from], async (err, lead) => {
        if (err || !lead) return;

        let response = "";

        // --- COMANDO: CONTROLE (ADICIONAR) ---
        if (lowerMsg.startsWith('controle ')) {
            const parts = msgBody.split(' ');
            const valor = parseFloat(parts[1] ? parts[1].replace(',', '.') : '0');
            const categoria = parts.slice(2).join(' ') || 'geral';

            if (isNaN(valor) || valor <= 0) {
                response = "❌ *Valor inválido.*\nUse: _controle 50.00 mercado_";
            } else {
                db.run(`INSERT INTO transactions (lead_id, amount, category) VALUES (?, ?, ?)`, 
                    [lead.id, valor, categoria], function (err) {
                        if (!err) {
                            sendMessage(from, `✅ *Registrado!*\n🆔 ID: ${this.lastID}\n💰 R$${valor.toFixed(2)}\n📂 ${categoria}`);
                        } else {
                            sendMessage(from, "❌ Erro ao salvar. Tente novamente.");
                        }
                    });
                return;
            }

        // --- COMANDO: EXTRATO (SALDO) ---
        } else if (['extrato', 'saldo', 'ver', 'total'].includes(lowerMsg)) {
            // Calcula Total
            db.get("SELECT SUM(amount) as total FROM transactions WHERE lead_id = ?", [lead.id], (err, resTotal) => {
                const total = resTotal && resTotal.total ? resTotal.total : 0;
                
                // Busca últimos 10 lançamentos
                db.all("SELECT id, amount, category, created_at FROM transactions WHERE lead_id = ? ORDER BY id DESC LIMIT 10", [lead.id], async (err, rows) => {
                    let msg = `🐷 *EXTRATO FINANCEIRO*\n\n💰 *SALDO TOTAL: R$${total.toFixed(2)}*\n──────────────────\n`;
                    
                    if (rows.length > 0) {
                        rows.forEach(t => {
                            // Formatação de Data BR (Gambiarra funcional para SQLite UTC)
                            // Assume que o servidor salva em UTC. Adiciona 'Z' para o JS entender que é UTC.
                            let dataBR = '---';
                            try {
                                const dataUTC = new Date(t.created_at.replace(' ', 'T') + 'Z');
                                dataBR = dataUTC.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
                            } catch (e) { dataBR = t.created_at; } // Fallback se der erro na data

                            msg += `🆔*${t.id}* | R$${t.amount.toFixed(2)}\n📂 ${t.category} | 🕒 ${dataBR}\n\n`;
                        });
                    } else {
                        msg += "(Nenhum lançamento ainda)\n";
                    }
                    msg += `💡 _Para apagar: *excluir [ID]*_`;
                    await sendMessage(from, msg);
                });
            });
            return;

        // --- COMANDO: EXCLUIR ---
        } else if (lowerMsg.startsWith('excluir ')) {
            const idExcluir = parseInt(lowerMsg.split(' ')[1]);
            if (!isNaN(idExcluir)) {
                db.run("DELETE FROM transactions WHERE id = ? AND lead_id = ?", [idExcluir, lead.id], function(err) {
                    if (this.changes > 0) sendMessage(from, `🗑️ Lançamento *ID ${idExcluir}* apagado!`);
                    else sendMessage(from, `⚠️ ID ${idExcluir} não encontrado.`);
                });
                return;
            } else {
                response = "❌ Use: *excluir [NÚMERO DO ID]*";
            }

        // --- MENU PADRÃO ---
        } else {
            response = `🐷 *Bot Financeiro*\nOlá ${leadName}! Seus comandos:\n\n🆕 *controle [valor] [descrição]*\n_(Ex: controle 100 jantar fora)_\n\n📊 *extrato*\n_(Ver saldo e histórico)_\n\n❌ *excluir [ID]*\n_(Apagar um registro)_`;
        }

        if (response) await sendMessage(from, response);
    });
}

// =========================================
// SERVER & WEBHOOK
// =========================================
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WEBHOOK_VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account' && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
        const msgData = body.entry[0].changes[0].value.messages[0];
        if (msgData.type === 'text') {
            const from = msgData.from;
            const name = body.entry[0].changes[0].value.contacts[0].profile.name;
            const text = msgData.text.body;

            console.log(`📩 ${name}: ${text}`);

            // Garante que o lead existe antes de chamar o bot
            db.run(`INSERT INTO leads (phone, name, last_interaction) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(phone) DO UPDATE SET last_interaction=CURRENT_TIMESTAMP, name=excluded.name`, [from, name], (err) => {
                if (!err) handleChatbot(from, text, name);
            });
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// Rotas Dashboard (Opcionais)
app.get('/api/leads', (req, res) => db.all("SELECT * FROM leads ORDER BY last_interaction DESC", [], (e, r) => res.json(r)));
app.get('/api/messages/:id', (req, res) => db.all("SELECT * FROM messages WHERE lead_id = ?", [req.params.id], (e, r) => res.json(r)));

app.listen(PORT, () => console.log(`🚀 Bot Financeiro ON na porta ${PORT}`));