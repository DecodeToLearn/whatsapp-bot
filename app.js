require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const WebSocket = require('ws');
const path = require('path');
const app = express();
const axios = require('axios');

const { clients: instagramClients } = require('./instagram');
const { clients: telegramClients } = require('./telegram');
const { clients: whatsappClients } = require('./whatsapp');

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

app.get('/check-user-instagram/:instagramId', async (req, res) => {
    const { instagramId } = req.params;
    let accessToken = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null;

    // Eğer istemci zaten WebSocket'e bağlanmışsa, doğrudan döndür.
    if (clients[instagramId] && clients[instagramId].connected) {
        return res.json({ connected: true, username: clients[instagramId].username || "Bilinmeyen Kullanıcı" });
    }

    // Eğer WebSocket bağlantısı yoksa ve accessToken alınamamışsa hata ver.
    if (!accessToken) {
        return res.status(401).json({ connected: false, error: "Access Token eksik!" });
    }

    // Kullanıcı WebSocket'e bağlı değilse, Instagram API'den doğrula
    console.log('⚠️ Kullanıcı WebSocket bağlantısını açmamış, API ile kontrol ediliyor...');
    try {
        const response = await axios.get(`https://graph.instagram.com/me?fields=id,username&access_token=${accessToken}`);

        if (response.data.id) {
            return res.json({ connected: true, username: response.data.username });
        } else {
            return res.json({ connected: false, error: "Instagram ID doğrulanamadı." });
        }
    } catch (error) {
        console.error("Instagram API hatası:", error.response ? error.response.data : error.message);
        return res.status(500).json({ connected: false, error: "Instagram API doğrulaması başarısız." });
    }
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

    return (whatsappClient && whatsappClient.info) || (telegramClient && telegramClient.connected);
}