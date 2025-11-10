
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
// FUNÇÕES AUXILIARES
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
        console.log(`📤 Enviado para ${to}: ${text}`);
        
        // Registrar envio no banco
        db.get("SELECT id FROM leads WHERE phone = ?", [to], (err, row) => {
            if (row) {
                db.run("INSERT INTO messages (lead_id, type, body) VALUES (?, 'sent', ?)", [row.id, text]);
            }
        });

    } catch (error) {
        console.error('❌ Erro ao enviar:', error.response ? error.response.data : error.message);
    }
}

// Chatbot Básico
async function handleChatbot(from, msgBody, leadName) {
    msgBody = msgBody.toLowerCase().trim();
    let response = "";

    if (['oi', 'olá', 'ola', 'menu'].includes(msgBody)) {
        response = `Olá ${leadName || ''}! 👋 Bem-vindo.\n\nEscolha uma opção:\n1️⃣ - Planos\n2️⃣ - Suporte\n3️⃣ - Falar com Humano`;
    } else if (msgBody === '1') {
        response = "Temos planos a partir de R$99/mês. Quer saber mais detalhes?";
    } else if (msgBody === '2') {
        response = "Para suporte técnico, envie um e-mail para suporte@empresa.com.";
    } else if (msgBody === '3') {
        response = "Aguarde um momento, um atendente irá falar com você em breve.";
    } else {
        response = "Desculpe, não entendi. Digite 'menu' para ver as opções.";
    }

    await sendMessage(from, response);
}

// =========================================
// ROTAS DA API (DASHBOARD)
// =========================================
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

app.post('/api/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Telefone e mensagem necessários' });
    
    await sendMessage(phone, message);
    res.json({ status: 'success' });
});

// =========================================
// WEBHOOK (META)
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
                
                const from = messageData.from;
                const msgBody = messageData.text ? messageData.text.body : '[Mídia/Outros]';
                const name = contactData ? contactData.profile.name : 'Desconhecido';

                console.log(`📩 De ${name} (${from}): ${msgBody}`);

                // Upsert Lead
                db.run(`INSERT INTO leads (phone, name, last_interaction) VALUES (?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(phone) DO UPDATE SET last_interaction=CURRENT_TIMESTAMP, name=excluded.name`, 
                        [from, name], function(err) {
                            if (!err) {
                                db.get("SELECT id FROM leads WHERE phone = ?", [from], (e, row) => {
                                    if (row) {
                                        db.run("INSERT INTO messages (lead_id, type, body) VALUES (?, 'received', ?)", [row.id, msgBody]);
                                        // Só responde se for mensagem de texto
                                        if (messageData.type === 'text') {
                                            handleChatbot(from, msgBody, name);
                                        }
                                    }
                                });
                            }
                        });
            }
        } catch (e) {
            console.error('Erro no processamento do webhook:', e);
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});