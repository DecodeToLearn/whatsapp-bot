// ✨ WhatsApp Web.js Client App (Optimized)
// 🎯 Designed with KG08 Rules

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
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

// Medya dosyalarını statik olarak sun
app.use('/media', express.static(path.join(__dirname, 'media')));
app.use(cors(corsOptions));
app.use(bodyParser.json());

let qrCodes = {};  // Kullanıcı bazlı QR kodlarını saklamak için
const clients = {};  // Kullanıcı clientlarını saklamak için
const SESSION_DIR = './sessions';

if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR);
}
// Kullanıcı bağlılık kontrolü
app.get('/check-user/:userId', async (req, res) => {
    const { userId } = req.params;

    if (clients[userId]) {
        res.json({ connected: true });
    } else {
        res.json({ connected: false });
    }
});
function createClient(userId) {
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: userId,
            dataPath: path.join(SESSION_DIR, userId),
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
            ],
            defaultViewport: null,
            timeout: 30000,
        },
    });

    client.on('qr', async (qr) => {
        try {
            const qrCodeUrl = await qrcode.toDataURL(qr);
            qrCodes[userId] = qrCodeUrl;
            console.log(`QR kodu (${userId}) oluşturuldu.`);
            broadcast({ type: 'qr', qrCode: qrCodeUrl, userId });
        } catch (error) {
            console.error('QR kodu oluşturulurken hata:', error);
        }
    });

    client.on('ready', async () => {
        console.log(`${userId} WhatsApp botu hazır.`);
        delete qrCodes[userId]; // QR kodunu temizle
        try {
            const contacts = (await client.getContacts()).map(contact => ({
                id: contact.id._serialized,
                name: contact.name || contact.pushname || contact.id.user,
            }));
            broadcast({ type: 'contacts', contacts, userId });
        } catch (error) {
            console.error('Kontaklar alınırken hata:', error);
        }
    });

 


   /* client.on('message', async (message) => {
        console.log(`Mesaj Alındı: ${message.body}`);
        try {
            const chatId = message.from;
    
            if (message.hasMedia) {
                const media = await message.downloadMedia();
                const msgData = {
                    type: 'messages',
                    chatId: chatId,
                    messages: [{
                        from: message.from,
                        body: message.caption || '',
                        media: {
                            mimetype: media.mimetype,
                            url: saveMediaToFile(media),
                        },
                        timestamp: message.timestamp,
                    }]
                };
                broadcast(msgData);
            } else if (message.location) {
                const msgData = {
                    type: 'messages',
                    chatId: chatId,
                    messages: [{
                        from: message.from,
                        location: {
                            latitude: message.location.latitude,
                            longitude: message.location.longitude,
                            description: message.location.description || '',
                        },
                        timestamp: message.timestamp,
                    }]
                };
                broadcast(msgData);
            } else if (message.type === 'contact_card') {
                const msgData = {
                    type: 'messages',
                    chatId: chatId,
                    messages: [{
                        from: message.from,
                        contact: message.vCard,
                        timestamp: message.timestamp,
                    }]
                };
                broadcast(msgData);
            } else {
                const msgData = {
                    type: 'messages',
                    chatId: chatId,
                    messages: [{
                        from: message.from,
                        body: message.body,
                        timestamp: message.timestamp,
                    }]
                };
                broadcast(msgData);
            }
        } catch (error) {
            console.error('Mesaj işlenirken hata:', error);
        }
    });*/
    // Medyaları dosya sistemine kaydetme
    const saveMediaToFile = async (media) => {
        const extension = media.mimetype.split('/')[1];
        const fileName = `${Date.now()}.${extension}`;
        const filePath = path.join(__dirname, 'media', fileName);
    
        try {
            await fs.promises.writeFile(filePath, media.data, 'base64');
            return `/media/${fileName}`;
        } catch (error) {
            console.error('Medya dosyası kaydedilirken hata:', error);
            return null;
        }
    };
    

    // Mesajları belirli bir Chat ID için getir

// Mesajları belirli bir Chat ID için getir (Son 20 mesaj)
app.get('/messages/:chatId', async (req, res) => {
    try {
        const activeClient = Object.values(clients)[0];
        if (!activeClient) {
            return res.status(404).json({ error: 'Aktif bir WhatsApp oturumu yok.' });
        }

        const chat = await activeClient.getChatById(req.params.chatId);
        const messages = await chat.fetchMessages({ limit: 20 });

        const formattedMessages = await Promise.all(
            messages.map(async (msg) => {
                const formattedMsg = {
                    from: msg.from,
                    body: msg.body || '',
                    media: null,
                    timestamp: msg.timestamp,
                };

                if (msg.hasMedia) {
                    const media = await msg.downloadMedia();
                    formattedMsg.media = {
                        mimetype: media.mimetype,
                        url: await saveMediaToFile(media),
                    };
                }

                return formattedMsg;
            })
        );

        res.status(200).json({ messages: formattedMessages });
    } catch (error) {
        console.error('Mesajlar alınırken hata:', error);
        res.status(500).json({ error: 'Mesajlar alınırken hata oluştu.' });
    }
});


    
    client.on('disconnected', (reason) => {
        console.log(`${userId} bağlantısı kesildi: ${reason}`);
        setTimeout(() => createClient(userId), 5000);
    });

    client.initialize();
    clients[userId] = client;
}

app.post('/register', (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'User ID gereklidir.' });
    }

    if (clients[userId]) {
        return res.json({ status: 'already_registered' });
    }

    createClient(userId);
    res.json({ status: 'registered' });
});

app.get('/qr/:userId', (req, res) => {
    const userId = req.params.userId;

    if (qrCodes[userId]) {
        const base64Data = qrCodes[userId].replace(/^data:image\/png;base64,/, '');
        const imgBuffer = Buffer.from(base64Data, 'base64');

        res.set('Content-Type', 'image/png');
        res.send(imgBuffer);
    } else {
        res.status(404).send('QR kodu bulunamadı.');
    }
});

wss.on('connection', (ws) => {
    console.log('Yeni bir WebSocket bağlantısı kuruldu.');
    Object.keys(qrCodes).forEach((userId) => {
        ws.send(JSON.stringify({ type: 'qr', qrCode: qrCodes[userId], userId }));
    });
});

app.post('/send', async (req, res) => {
    const { number, caption, media } = req.body;

    if (!number || (!caption && !media)) {
        return res.status(400).json({ error: 'Numara ve mesaj veya medya gereklidir.' });
    }

    try {
        const formattedNumber = number.includes('@c.us') ? number : `${number}@c.us`;

        if (media && media.url) {
            const mediaPath = await downloadMedia(media.url);
            if (!mediaPath) {
                return res.status(500).json({ error: 'Medya indirilemedi.' });
            }

            const messageMedia = MessageMedia.fromFilePath(mediaPath);
            await clients[number].sendMessage(formattedNumber, messageMedia, { caption });

            fs.unlinkSync(mediaPath);
        } else if (caption) {
            await clients[number].sendMessage(formattedNumber, caption);
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Mesaj gönderilirken hata oluştu:', error.message);
        res.status(500).json({ error: error.message });
    }
});

function broadcast(data) {
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
