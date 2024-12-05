const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode'); // QR kodu webde göstermek için
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const fs = require('fs'); // Dosya sistemi işlemleri için

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
        executablePath: process.env.CHROME_BIN || null
    }
});

// Global değişkenler
let qrCodeUrl = ''; // QR kod URL'si
let contacts = [];  // Kontak listesi

// QR kodu oluşturma ve WebSocket'e gönderme
client.on('qr', async (qr) => {
    try {
        qrCodeUrl = await qrcode.toDataURL(qr);
        console.log('Yeni QR kodu alındı.');
        broadcast({ type: 'qr', qrCode: qrCodeUrl }); // Tüm client'lara QR kodu gönder
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
            name: contact.name || contact.pushname || contact.id.user
        }));
        console.log('Kontaklar alındı.');
        broadcast({ type: 'contacts', contacts }); // Tüm client'lara kontakları gönder
    } catch (error) {
        console.error('Kontaklar alınırken hata oluştu:', error);
    }
});

// Mesaj alındığında WebSocket'e gönder
client.on('message', (message) => {
    console.log(`Mesaj alındı: ${message.body} - Gönderen: ${message.from}`);
    broadcast({
        type: 'message',
        from: message.from,
        message: message.body
    });
});

// WebSocket bağlantılarını yönetme
wss.on('connection', (ws) => {
    console.log('Yeni bir WebSocket bağlantısı kuruldu.');

    // QR kodu varsa hemen gönder
    if (qrCodeUrl) {
        ws.send(JSON.stringify({ type: 'qr', qrCode: qrCodeUrl }));
    }

    // Kontak listesi varsa hemen gönder
    if (contacts.length) {
        ws.send(JSON.stringify({ type: 'contacts', contacts }));
    }

    // İstemciden gelen özel mesaj isteklerini işleme
    ws.on('message', async (message) => {
        const data = JSON.parse(message);
        if (data.type === 'fetchMessages') {
            try {
                const chat = await client.getChatById(data.chatId);
                const messages = await chat.fetchMessages({ limit: 50 });
                ws.send(JSON.stringify({
                    type: 'chatMessages',
                    chatId: data.chatId,
                    messages: messages.map(msg => ({
                        fromMe: msg.fromMe,
                        body: msg.body,
                        timestamp: msg.timestamp
                    }))
                }));
            } catch (error) {
                console.error('Mesajlar alınırken hata oluştu:', error);
            }
        }
    });
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

// QR kodu yenileme hatasını önleme
setInterval(() => {
    if (client.pupPage && client.pupPage.evaluate) {
        client.pupPage.evaluate(() => {
            const store = window.Store;
            if (store && store.State && store.State.Socket) {
                store.State.Socket.disconnect();
            }
        }).catch((err) => console.error('QR kod yenileme sırasında hata:', err));
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
