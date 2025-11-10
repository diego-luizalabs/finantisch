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

// --- HELPERS ---
function generateShortId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 5; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

async function sendText(to, text) {
    try {
        await axios.post(`https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: 'whatsapp', to, type: 'text', text: { body: text }
        }, { headers: { 'Authorization': `Bearer ${GRAPH_API_TOKEN}` }});
    } catch (e) { console.error('❌ Erro sendText:', e.message); }
}

async function sendInteractiveButton(to, text, btnText, btnId) {
    try {
        await axios.post(`https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: 'whatsapp', to, type: 'interactive',
            interactive: {
                type: 'button', body: { text: text },
                action: { buttons: [{ type: 'reply', reply: { id: btnId, title: btnText } }] }
            }
        }, { headers: { 'Authorization': `Bearer ${GRAPH_API_TOKEN}` }});
    } catch (e) { console.error('❌ Erro sendButton:', e.message); }
}

// --- CHATBOT ---
async function handleChatbot(from, msgBody, isButton, buttonId, leadName) {
    if (!isButton) msgBody = msgBody.trim();
    const lowerMsg = msgBody.toLowerCase();

    db.get("SELECT id FROM leads WHERE phone = ?", [from], (err, lead) => {
        if (err || !lead) return;

        // 1. CLIQUE NO BOTÃO EXCLUIR
        if (isButton && buttonId && buttonId.startsWith('del_')) {
            const idExcluir = buttonId.split('_')[1];
            db.run("DELETE FROM transactions WHERE short_id = ? AND lead_id = ?", [idExcluir, lead.id], function(err) {
                sendText(from, this.changes > 0 ? `🗑️ Lançamento ${idExcluir} apagado.` : `⚠️ ID ${idExcluir} não encontrado.`);
            });
            return;
        }

        // 2. COMANDO GASTO (ex: "50 pizza")
        const match = msgBody.match(/^(\d+([.,]\d+)?)\s+(.+)/);
        if (match && !isButton) {
            const valor = parseFloat(match[1].replace(',', '.'));
            const desc = match[3];
            const newId = generateShortId();
            if (!isNaN(valor) && valor > 0) {
                db.run(`INSERT INTO transactions (lead_id, short_id, amount, category) VALUES (?, ?, ?, ?)`, 
                    [lead.id, newId, valor, desc], (err) => {
                    if (!err) sendInteractiveButton(from, `✅ Registrado!\n🆔 ID: ${newId}\n💰 R$${valor.toFixed(2)}\n📂 ${desc}`, "Excluir ❌", `del_${newId}`);
                    else sendText(from, "❌ Erro ao salvar.");
                });
                return;
            }
        }

        // 3. EXTRATO
        if (['extrato', 'saldo', 'ver'].includes(lowerMsg)) {
            db.get("SELECT SUM(amount) as T FROM transactions WHERE lead_id=?", [lead.id], (e, r) => {
                const total = r && r.T ? r.T : 0;
                db.all("SELECT short_id, amount, category, created_at FROM transactions WHERE lead_id=? ORDER BY id DESC LIMIT 10", [lead.id], (e, rows) => {
                    let msg = `🐷 *EXTRATO*\n💰 Total: R$${total.toFixed(2)}\n──────────\n`;
                    rows.forEach(t => {
                       try {
                           const d = new Date(t.created_at.replace(' ','T')+'Z').toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
                           msg += `🆔 ${t.short_id} | R$${t.amount.toFixed(2)}\n📂 ${t.category} (${d})\n\n`;
                       } catch(e) { msg += `🆔 ${t.short_id} | R$${t.amount.toFixed(2)} - ${t.category}\n`; }
                    });
                    sendText(from, msg + "_Para excluir: excluir [ID]_");
                });
            });
            return;
        }

        // 4. EXCLUIR MANUAL
        if (lowerMsg.startsWith('excluir ')) {
            handleChatbot(from, '', true, `del_${msgBody.split(' ')[1]}`, leadName);
            return;
        }

        // 5. MENU PADRÃO
        if (!isButton) sendText(from, `🐷 *Bot Cofrinho*\n\nDigite o valor e o nome para salvar.\nEx: *50 almoço*\n\nOu digite *extrato* para ver o saldo.`);
    });
}

// --- WEBHOOK ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] == 'subscribe' && req.query['hub.verify_token'] == WEBHOOK_VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});
app.post('/webhook', (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages) {
        const msg = body.entry[0].changes[0].value.messages[0];
        const contact = body.entry[0].changes[0].value.contacts?.[0];
        const name = contact?.profile?.name || 'User';
        const from = msg.from;

        db.run("INSERT INTO leads (phone, name) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET name=excluded.name, last_interaction=CURRENT_TIMESTAMP", [from, name], () => {
            if (msg.type === 'text') handleChatbot(from, msg.text.body, false, null, name);
            else if (msg.type === 'interactive' && msg.interactive.type === 'button_reply') handleChatbot(from, '', true, msg.interactive.button_reply.id, name);
        });
        res.sendStatus(200);
    } else res.sendStatus(404);
});

app.listen(PORT, () => console.log(`🚀 Server ON port ${PORT}`));