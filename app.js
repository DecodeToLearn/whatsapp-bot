require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const WebSocket = require('ws');
const path = require('path');
const app = express();
const axios = require('axios');

const { clientsInsta } = require('./instagram'); 
const { clients, createClient } = require('./whatsapp');
const { clientsTelegram } = require('./telegram');

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
//require('./instagram')(app, wss);

// Kullanıcı bağlantı durumunu kontrol eden endpoint
app.get('/check-user/:userId', (req, res) => {
    const { userId } = req.params;
    console.log(`📌 Kullanıcı kontrol ediliyor: ${userId}`);

    if (!clients[userId]) {
        console.log(`🔴 Kullanıcı ${userId} bağlı değil, istemci başlatılıyor...`);
        createClient(userId); // Eğer istemci yoksa başlat
        return res.status(202).json({ connected: false, message: 'İstemci başlatılıyor, lütfen tekrar deneyin.' });
    }

    const isConnected = checkUserConnection(userId);
    console.log(`📢 Kullanıcı durumu: ${isConnected ? 'Bağlı' : 'Bağlı değil'}`);

    res.json({ connected: isConnected });
});

app.get('/check-user-instagram/:instagramId', async (req, res) => {
    const { instagramId } = req.params;
    let accessToken = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null;

    // Eğer istemci zaten WebSocket'e bağlanmışsa, doğrudan döndür.
    if (clientsInsta[instagramId] && clientsInsta[instagramId].connected) {
        return res.json({ connected: true, username: clientsInsta[instagramId].username || "Bilinmeyen Kullanıcı" });
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
    console.log(`✅ checkUserConnection çağrıldı: ${userId}`);

    // clients nesnesinde kullanıcı var mı kontrol et
    if (!clients || !clients[userId]) {
        console.log(`🔴 Kullanıcı ${userId} için istemci bulunamadı.`);
        return false;
    }

    const whatsappClient = clients[userId];
    const telegramClient = clientsTelegram[userId];

    // WhatsApp veya Telegram bağlantısı varsa true döndür
    if (whatsappClient?.info || telegramClient?.connected) {
        console.log(`🟢 Kullanıcı ${userId} bağlı.`);
        return true;
    }

    console.log(`🔴 Kullanıcı ${userId} bağlı değil.`);
    return false;
}