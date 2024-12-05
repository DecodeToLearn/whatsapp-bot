const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const fs = require('fs');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

app.use(bodyParser.json());

// WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: process.env.CHROME_BIN || null,
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
                    timestamp: message.timestamp,
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
                timestamp: message.timestamp,
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
                timestamp: message.timestamp,
                contact: message.vCard,
            });
        } else {
            broadcast({
                type: 'textMessage',
                from: message.from,
                timestamp: message.timestamp,
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

// QR kodu yenileme hatalarını önleme
setInterval(async () => {
    try {
        if (client.pupPage && client.pupPage.evaluate) {
            await client.pupPage.evaluate(() => {
                const store = window.Store;
                if (store && store.State && store.State.Socket) {
                    store.State.Socket.disconnect();
                }
            });
        }
    } catch (error) {
        console.error('QR kod yenileme sırasında hata:', error);
    }
}, 30000);

// Mesaj gönderme API'si
app.post('/send', async (req, res) => {
    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).send({ error: 'Numara ve mesaj gereklidir.' });
    }

    try {
        const formattedNumber = `${number}@c.us`;
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

// Sunucu başlatma
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});

client.initialize();
