const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Здоровье-проверка для Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Храним сообщения в памяти
let messages = { main: [] };
let callRooms = {};

io.on('connection', (socket) => {
    console.log('🟢 Подключен:', socket.id);

    socket.on('register', (data) => {
        socket.data.nick = data.nick || 'Гость';
        socket.data.peerId = data.peerId;
        socket.data.avatar = data.avatar || '👤';
        console.log(`👤 ${socket.data.nick} зарегистрирован`);
        io.emit('onlineUsers', getOnlineUsers());
    });

    socket.on('joinChat', (chatId) => {
        socket.join(chatId);
        socket.data.currentChat = chatId;
        console.log(`📌 ${socket.data.nick} присоединился к чату ${chatId}`);
        
        if (messages[chatId]) {
            socket.emit('chatHistory', messages[chatId]);
        } else {
            messages[chatId] = [];
            socket.emit('chatHistory', []);
        }
    });

    socket.on('sendMessage', (data) => {
        try {
            const { chatId, message, nick, avatar, media } = data;
            console.log(`📨 ${nick}: ${message}`);
            
            const msgData = {
                id: Date.now(),
                nick: nick || 'Гость',
                message: message || '',
                avatar: avatar || '👤',
                media_url: media?.url || null,
                media_type: media?.type || null,
                created_at: new Date().toISOString()
            };
            
            if (!messages[chatId]) messages[chatId] = [];
            messages[chatId].push(msgData);
            
            io.to(chatId).emit('newMessage', msgData);
        } catch (err) {
            console.error('Ошибка отправки:', err);
            socket.emit('error', 'Не удалось отправить сообщение');
        }
    });

    // ============ ЗВОНКИ ============
    socket.on('startCall', (data) => {
        const { chatId, peerId } = data;
        const nick = socket.data.nick || 'Гость';
        
        if (callRooms[chatId] && callRooms[chatId].participants.length > 0) {
            socket.emit('error', 'Звонок уже активен');
            return;
        }
        
        callRooms[chatId] = {
            participants: [socket.id],
            peerId: peerId,
            startedBy: socket.id,
            startedByNick: nick
        };
        
        io.to(chatId).emit('callStarted', {
            chatId: chatId,
            peerId: peerId,
            startedBy: socket.id,
            startedByNick: nick,
            participants: callRooms[chatId].participants
        });
        
        console.log(`📞 ${nick} начал звонок в ${chatId}`);
    });

    socket.on('joinCall', (data) => {
        const { chatId, peerId } = data;
        const nick = socket.data.nick || 'Гость';
        
        if (callRooms[chatId]) {
            if (!callRooms[chatId].participants.includes(socket.id)) {
                callRooms[chatId].participants.push(socket.id);
            }
            if (peerId) callRooms[chatId].peerId = peerId;
            
            io.to(chatId).emit('callParticipantJoined', {
                chatId: chatId,
                participantId: socket.id,
                nick: nick,
                peerId: peerId,
                participants: callRooms[chatId].participants
            });
            
            socket.emit('callState', {
                chatId: chatId,
                peerId: callRooms[chatId].peerId,
                participants: callRooms[chatId].participants,
                startedBy: callRooms[chatId].startedBy,
                startedByNick: callRooms[chatId].startedByNick
            });
            
            console.log(`👤 ${nick} присоединился к звонку в ${chatId}`);
        }
    });

    socket.on('leaveCall', (data) => {
        const { chatId } = data;
        const nick = socket.data.nick || 'Гость';
        
        if (callRooms[chatId]) {
            callRooms[chatId].participants = callRooms[chatId].participants.filter(id => id !== socket.id);
            
            io.to(chatId).emit('callParticipantLeft', {
                chatId: chatId,
                participantId: socket.id,
                nick: nick,
                participants: callRooms[chatId].participants
            });
            
            if (callRooms[chatId].participants.length === 0) {
                io.to(chatId).emit('callEnded', { chatId: chatId });
                delete callRooms[chatId];
                console.log(`📞 Звонок в ${chatId} завершен`);
            } else {
                console.log(`👤 ${nick} покинул звонок в ${chatId}`);
            }
        }
    });

    socket.on('endCall', (data) => {
        const { chatId } = data;
        if (callRooms[chatId] && callRooms[chatId].startedBy === socket.id) {
            io.to(chatId).emit('callEnded', { chatId: chatId });
            delete callRooms[chatId];
            console.log(`📞 Звонок в ${chatId} завершен инициатором`);
        } else {
            socket.emit('error', 'Только инициатор может завершить звонок');
        }
    });

    socket.on('disconnect', () => {
        console.log('🔴 Отключен:', socket.id);
        for (const chatId in callRooms) {
            if (callRooms[chatId].participants.includes(socket.id)) {
                callRooms[chatId].participants = callRooms[chatId].participants.filter(id => id !== socket.id);
                if (callRooms[chatId].participants.length === 0) {
                    io.to(chatId).emit('callEnded', { chatId: chatId });
                    delete callRooms[chatId];
                } else {
                    io.to(chatId).emit('callParticipantLeft', {
                        chatId: chatId,
                        participantId: socket.id,
                        nick: socket.data.nick || 'Гость',
                        participants: callRooms[chatId].participants
                    });
                }
            }
        }
        io.emit('onlineUsers', getOnlineUsers());
    });
});

function getOnlineUsers() {
    const users = {};
    const sockets = io.sockets.sockets;
    for (const [id, socket] of sockets) {
        if (socket.data && socket.data.nick) {
            users[id] = {
                socketId: id,
                nick: socket.data.nick,
                peerId: socket.data.peerId,
                avatar: socket.data.avatar || '👤'
            };
        }
    }
    return users;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`🌐 Открой http://localhost:${PORT}`);
});
