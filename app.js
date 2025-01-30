require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const WebSocket = require('ws');
const path = require('path');
const app = express();

app.use('/media', express.static(path.join(__dirname, 'media')));
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(bodyParser.json());

// WhatsApp ve Telegram modüllerini içe aktarın
require('./whatsapp')(app, wss);
require('./telegram')(app, wss);
require('./instagram')(app, wss);
// Kullanıcı bağlantı durumunu kontrol eden endpoint
app.get('/check-user/:userId', (req, res) => {
    const { userId } = req.params;
    const isConnected = checkUserConnection(userId); // Bu fonksiyonu aşağıda tanımlayacağız

    res.json({ connected: isConnected });
});
const { registerUser } = require('./instagram');

app.post('/register-instagram', async (req, res) => {
    const { userId, instagramId, accessToken } = req.body;

    if (!userId || !instagramId || !accessToken) {
        return res.status(400).json({ error: 'User ID, Instagram ID ve access token zorunludur.' });
    }

    try {
        await registerUser(userId, instagramId, accessToken);
        res.json({ status: 'registered' });
    } catch (error) {
        console.error('Kullanıcı kaydedilirken hata oluştu:', error);
        res.status(500).json({ error: 'Kullanıcı kaydı başarısız.' });
    }
});


app.get('/check-user-instagram/:userId', (req, res) => {
    const { userId } = req.params;
    const isConnected = checkUserConnection(userId); // Bu fonksiyonu aşağıda tanımlayacağız

    res.json({ connected: isConnected });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
// Kullanıcı bağlantı durumunu kontrol eden fonksiyon
function checkUserConnection(userId) {
    // WhatsApp ve Telegram istemcilerini kontrol edin
    const whatsappClient = require('./whatsapp').clients[userId];
    const telegramClient = require('./telegram').clients[userId];
    const instagramClient = require('./instagram').clients[userId];
    return (whatsappClient && whatsappClient.info) || (telegramClient && telegramClient.connected) ||
    (instagramClient && instagramClient.connected);
}