const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Подключение к CockroachDB
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Инициализация таблиц
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                chat_id STRING NOT NULL,
                nick STRING NOT NULL,
                message TEXT NOT NULL,
                avatar STRING DEFAULT '👤',
                media_url TEXT,
                media_type STRING,
                created_at TIMESTAMP DEFAULT now()
            )
        `);
        console.log('✅ База данных готова');
    } catch (err) {
        console.error('❌ Ошибка БД:', err);
    }
}

// Сохранение сообщения
async function saveMessage(chatId, nick, message, avatar = '👤', media = null) {
    const result = await pool.query(
        `INSERT INTO messages (chat_id, nick, message, avatar, media_url, media_type) 
         VALUES ($1, $2, $3, $4, $5, $6) 
         RETURNING *`,
        [chatId, nick, message, avatar, media?.url || null, media?.type || null]
    );
    return result.rows[0];
}

// Получение истории
async function getHistory(chatId) {
    const result = await pool.query(
        `SELECT * FROM messages 
         WHERE chat_id = $1 
         ORDER BY created_at DESC 
         LIMIT 100`,
        [chatId]
    );
    return result.rows.reverse();
}

// WebSocket
io.on('connection', (socket) => {
    console.log('🟢 Подключен:', socket.id);

    socket.on('joinChat', async (chatId) => {
        socket.join(chatId);
        const history = await getHistory(chatId);
        socket.emit('chatHistory', history);
    });

    socket.on('sendMessage', async (data) => {
        const { chatId, message, nick, avatar, media } = data;
        const saved = await saveMessage(chatId, nick, message, avatar, media);
        io.to(chatId).emit('newMessage', saved);
    });

    socket.on('disconnect', () => {
        console.log('🔴 Отключен:', socket.id);
    });
});

// REST API
app.get('/api/history/:chatId', async (req, res) => {
    const history = await getHistory(req.params.chatId);
    res.json(history);
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
    server.listen(PORT, () => {
        console.log(`🚀 Сервер на http://localhost:${PORT}`);
    });
});