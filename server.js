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
// HELPERS
// =========================================
// Gera ID de 5 caracteres (Letras maiúsculas e números)
function generateShortId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 5; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Envia Texto Simples
async function sendText(to, text) {
    try {
        await axios.post(`https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: 'whatsapp', to: to, type: 'text', text: { body: text }
        }, { headers: { 'Authorization': `Bearer ${GRAPH_API_TOKEN}` }});
    } catch (e) { console.error('Erro sendText:', e.response ? e.response.data : e.message); }
}

// Envia Mensagem COM BOTÃO Interativo
async function sendInteractiveButton(to, bodyText, buttonLabel, buttonPayload) {
    try {
        await axios.post(`https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: 'whatsapp',
            to: to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: bodyText },
                action: {
                    buttons: [
                        {
                            type: 'reply',
                            reply: {
                                id: buttonPayload, // O ID escondido que o bot vai ler quando clicarem
                                title: buttonLabel // O texto que aparece no botão para o usuário
                            }
                        }
                    ]
                }
            }
        }, { headers: { 'Authorization': `Bearer ${GRAPH_API_TOKEN}` }});
    } catch (e) { console.error('Erro sendInteractiveButton:', e.response ? e.response.data : e.message); }
}

// =========================================
// 🧠 CÉREBRO DO BOT FINANCEIRO V2
// =========================================
async function handleChatbot(from, msgBody, isButton = false, buttonId = null, leadName = '') {
    if (!isButton) msgBody = msgBody.trim();
    const lowerMsg = msgBody.toLowerCase();

    db.get("SELECT id FROM leads WHERE phone = ?", [from], async (err, lead) => {
        if (err || !lead) return;

        // --- 1. CLICK NO BOTÃO "EXCLUIR" ---
        if (isButton && buttonId.startsWith('del_')) {
            const idParaExcluir = buttonId.split('_')[1]; // Pega o ID depois do "del_"
            db.run("DELETE FROM transactions WHERE short_id = ? AND lead_id = ?", [idParaExcluir, lead.id], function(err) {
                if (this.changes > 0) {
                    sendText(from, `🗑️ Lançamento *${idParaExcluir}* excluído para sempre.`);
                } else {
                    sendText(from, `⚠️ O lançamento *${idParaExcluir}* já foi excluído ou não existe mais.`);
                }
            });
            return;
        }

        // --- 2. DETECTA GASTO IMPLÍCITO (Ex: "50.90 mercado") ---
        // Regex: Começa com numero, pode ter virgula/ponto, espaço, e depois texto.
        const matchGasto = msgBody.match(/^(\d+([.,]\d+)?)\s+(.+)/);

        if (matchGasto && !isButton) {
            const valor = parseFloat(matchGasto[1].replace(',', '.'));
            const categoria = matchGasto[3];
            const novoId = generateShortId();

            if (!isNaN(valor) && valor > 0) {
                db.run(`INSERT INTO transactions (lead_id, short_id, amount, category) VALUES (?, ?, ?, ?)`, 
                    [lead.id, novoId, valor, categoria], (err) => {
                        if (!err) {
                            // ✨ A MÁGICA: Manda a confirmação JÁ com o botão de excluir
                            const msgConfirmacao = `✅ *Registrado!*\n🆔 ID: ${novoId}\n💰 R$${valor.toFixed(2)}\n📂 ${categoria}`;
                            sendInteractiveButton(from, msgConfirmacao, "Excluir ❌", `del_${novoId}`);
                        } else {
                            sendText(from, "❌ Erro ao salvar no banco de dados.");
                        }
                    });
                return;
            }
        }

        // --- 3. OUTROS COMANDOS ---
        if (['extrato', 'saldo', 'ver'].includes(lowerMsg)) {
            db.get("SELECT SUM(amount) as total FROM transactions WHERE lead_id = ?", [lead.id], (err, res) => {
                const total = res && res.total ? res.total : 0;
                db.all("SELECT short_id, amount, category, created_at FROM transactions WHERE lead_id = ? ORDER BY id DESC LIMIT 10", [lead.id], async (err, rows) => {
                    let msg = `🐷 *EXTRATO*\n💰 *TOTAL: R$${total.toFixed(2)}*\n────────────────\n`;
                    rows.forEach(t => {
                        // Formata data BR
                        let dataBR = t.created_at;
                        try {
                             dataBR = new Date(t.created_at.replace(' ', 'T') + 'Z')
                                .toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
                        } catch(e) {}
                        msg += `🆔 ${t.short_id} | R$${t.amount.toFixed(2)}\n📂 ${t.category} (${dataBR})\n\n`;
                    });
                    msg += `_Para excluir manualmente, use: excluir [ID]_`;
                    await sendText(from, msg);
                });
            });

        } else if (lowerMsg.startsWith('excluir ')) {
            // Exclusão manual pelo texto (caso não queira usar o botão)
            const idExcluir = msgBody.split(' ')[1];
            handleChatbot(from, '', true, `del_${idExcluir}`, leadName); // Reutiliza a lógica do botão

        } else if (!isButton) {
            // Menu padrão se não entendeu nada
            sendText(from, `🐷 *Bot Cofrinho*\n\nSimplesmente digite o valor e a descrição para salvar.\n\nExemplos:\n👉 *50 almoço*\n👉 *15.90 uber*\n👉 *100 cinema*\n\nOutros comandos:\n📊 *extrato*`);
        }
    });
}

// =========================================
// WEBHOOK
// =========================================
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WEBHOOK_VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account' && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
        const changes = body.entry[0].changes[0].value;
        const msgData = changes.messages[0];
        const contact = changes.contacts ? changes.contacts[0] : null;
        const from = msgData.from;
        const name = contact ? contact.profile.name : 'Usuário';

        // Garante que o lead existe
        db.run(`INSERT INTO leads (phone, name, last_interaction) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(phone) DO UPDATE SET last_interaction=CURRENT_TIMESTAMP, name=excluded.name`, [from, name], (err) => {
            if (!err) {
                // TIPO 1: Mensagem de texto normal
                if (msgData.type === 'text') {
                    console.log(`📩 Texto de ${name}: ${msgData.text.body}`);
                    handleChatbot(from, msgData.text.body, false, null, name);
                }
                // TIPO 2: Clique em botão (Interactive)
                else if (msgData.type === 'interactive' && msgData.interactive.type === 'button_reply') {
                    const buttonId = msgData.interactive.button_reply.id;
                    console.log(`🔘 Botão clicado por ${name}: ${buttonId}`);
                    handleChatbot(from, '', true, buttonId, name);
                }
            }
        });
        res.sendStatus(200);
    } else { res.sendStatus(404); }
});

app.listen(PORT, () => console.log(`🚀 Bot Financeiro V2 rodando na porta ${PORT}`));