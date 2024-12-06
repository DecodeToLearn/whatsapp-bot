const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// CORS ayarları
app.use(cors());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    next();
});

app.use(bodyParser.json());

// WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
});

// Global değişkenler
let qrCodeUrl = '';
let contacts = [];

// QR kodu oluşturma ve WebSocket'e gönderme
client.on('qr', async (qr) => {
    try {
        qrCodeUrl = await qrcode.toDataURL(qr);
        console.log('Yeni QR kodu alındı.');
        broadcast({ type: 'qr', qrCode: qrCodeUrl });
    } catch (error) {
        console.error('QR kod oluşturma hatası:', error);
    }
});

// WhatsApp bağlantısı kurulduğunda
client.on('ready', async () => {
    console.log('WhatsApp botu hazır.');
    try {
        contacts = (await client.getContacts()).map(contact => ({
            id: contact.id._serialized,
            name: contact.name || contact.pushname || contact.id.user,
        }));
        console.log('Kontaklar alındı.');
        broadcast({ type: 'contacts', contacts });
    } catch (error) {
        console.error('Kontaklar alınırken hata oluştu:', error);
    }
});

// WhatsApp bağlantısı kesildiğinde
client.on('disconnected', async (reason) => {
    console.log(`WhatsApp bağlantısı kesildi: ${reason}`);
    try {
        await client.destroy();
        await client.initialize();
    } catch (error) {
        console.error('Bağlantı yeniden başlatılamadı:', error);
    }
});

// Mesaj alındığında WebSocket'e gönder
client.on('message', async (message) => {
    try {
        if (message.hasMedia) {
            const media = await message.downloadMedia();
            if (media) {
                broadcast({
                    type: 'mediaMessage',
                    from: message.from,
                    caption: message.caption || '',
                    media: {
                        mimetype: media.mimetype,
                        data: media.data,
                    },
                });
            }
        } else if (message.location) {
            broadcast({
                type: 'locationMessage',
                from: message.from,
                location: {
                    latitude: message.location.latitude,
                    longitude: message.location.longitude,
                    description: message.location.description || '',
                },
            });
        } else if (message.type === 'contact_card') {
            broadcast({
                type: 'contactMessage',
                from: message.from,
                contact: message.vCard,
            });
        } else {
            broadcast({
                type: 'textMessage',
                from: message.from,
                body: message.body,
            });
        }
    } catch (error) {
        console.error('Mesaj işleme sırasında hata:', error);
    }
});

// WebSocket bağlantılarını yönetme
wss.on('connection', (ws) => {
    console.log('Yeni bir WebSocket bağlantısı kuruldu.');

    if (qrCodeUrl) {
        ws.send(JSON.stringify({ type: 'qr', qrCode: qrCodeUrl }));
    }

    if (contacts.length) {
        ws.send(JSON.stringify({ type: 'contacts', contacts }));
    }

    ws.on('message', async (message) => {
        const data = JSON.parse(message);

        if (data.type === 'fetchMessages') {
            try {
                const chat = await client.getChatById(data.chatId);
                const messages = await chat.fetchMessages({ limit: 50 });

                const formattedMessages = await Promise.all(
                    messages.map(async (msg) => {
                        if (msg.hasMedia) {
                            const media = await msg.downloadMedia();
                            return {
                                fromMe: msg.fromMe,
                                body: msg.body,
                                timestamp: msg.timestamp,
                                media: {
                                    mimetype: media.mimetype,
                                    data: media.data,
                                },
                            };
                        } else if (msg.location) {
                            return {
                                fromMe: msg.fromMe,
                                timestamp: msg.timestamp,
                                location: {
                                    latitude: msg.location.latitude,
                                    longitude: msg.location.longitude,
                                    description: msg.location.description || '',
                                },
                            };
                        } else if (msg.type === 'contact_card') {
                            return {
                                fromMe: msg.fromMe,
                                timestamp: msg.timestamp,
                                contact: msg.vCard,
                            };
                        } else {
                            return {
                                fromMe: msg.fromMe,
                                body: msg.body,
                                timestamp: msg.timestamp,
                            };
                        }
                    })
                );

                ws.send(JSON.stringify({
                    type: 'chatMessages',
                    chatId: data.chatId,
                    messages: formattedMessages,
                }));
            } catch (error) {
                console.error('Mesajlar alınırken hata oluştu:', error);
                ws.send(JSON.stringify({ type: 'error', error: error.message }));
            }
        }
    });
});

// Mesaj gönderme API'si
app.post('/send', async (req, res) => {
    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).send({ error: 'Numara ve mesaj gereklidir.' });
    }

    try {
        const formattedNumber = number.includes('@c.us') ? number : `${number}@c.us`;

        await client.sendMessage(formattedNumber, message);
        res.status(200).send({ success: true });
    } catch (error) {
        console.error('Mesaj gönderilirken hata oluştu:', error);
        res.status(500).send({ error: error.message });
    }
});

// QR kodu HTML olarak döndüren endpoint
app.get('/qr', (req, res) => {
    if (qrCodeUrl) {
        res.send(`
            <html>
            <head><title>WhatsApp QR Kodu</title></head>
            <body style="display: flex; justify-content: center; align-items: center; height: 100vh;">
                <div style="text-align: center;">
                    <h1>WhatsApp QR Kodu</h1>
                    <img src="${qrCodeUrl}" alt="WhatsApp QR" style="max-width: 100%; height: auto;" />
                </div>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
            <head><title>QR Kodu Oluşturuluyor...</title></head>
            <body style="display: flex; justify-content: center; align-items: center; height: 100vh;">
                <div style="text-align: center;">
                    <h1>QR Kodu Oluşturuluyor</h1>
                    <p>Lütfen bekleyin...</p>
                </div>
            </body>
            </html>
        `);
    }
});

// WebSocket yayın fonksiyonu
function broadcast(data) {
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(data));
            } catch (error) {
                console.error('WebSocket mesajı gönderilirken hata:', error);
            }
        }
    });
}

// Sunucu başlatma
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});

client.initialize();
