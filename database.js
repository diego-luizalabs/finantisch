// database.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'whatsapp.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('❌ Erro ao conectar no SQLite:', err.message);
    else console.log('📦 Banco de dados conectado.');
});

db.serialize(() => {
    // Tabela de Leads
    db.run(`CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE,
        name TEXT,
        last_interaction DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabela de Mensagens
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER,
        type TEXT,
        body TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(lead_id) REFERENCES leads(id)
    )`);

    // NOVA TABELA: Transações (O Cofrinho 🐷)
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER,
        amount REAL,
        category TEXT,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(lead_id) REFERENCES leads(id)
    )`);
});

module.exports = db;