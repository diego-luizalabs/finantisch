const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Caminho para salvar o banco de dados
const dbPath = path.resolve(__dirname, 'whatsapp.db');

// Cria (ou abre) o banco de dados em arquivo
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Erro ao conectar no SQLite:', err.message);
    } else {
        console.log('📦 Banco de dados SQLite conectado em:', dbPath);
    }
});

// Criação das tabelas iniciais
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE,
        name TEXT,
        status TEXT DEFAULT 'novo',
        last_interaction DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER,
        type TEXT,
        body TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(lead_id) REFERENCES leads(id)
    )`);
});

module.exports = db;