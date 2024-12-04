const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode'); // QR kodu webde göstermek için
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const fs = require('fs'); // Dosya sistemi işlemleri için

const app = express();
app.use(bodyParser.json());

// WhatsApp istemcisi
const client = new Client({
    authStrategy: new LocalAuth()
});

// Bağlantı sonlandığında oturum bilgilerini temizle
client.on('disconnected', (reason) => {
    console.log('Bağlantı kesildi:', reason);
    try {
        fs.rmSync('.wwebjs_auth', { recursive: true, force: true }); // Tüm cache dosyalarını sil
        console.log('.wwebjs_auth klasörü temizlendi.');
    } catch (err) {
        console.error('Cache temizleme sırasında hata:', err);
    }
});

// WebSocket sunucusu
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', ws => {
    console.log('Yeni bir WebSocket bağlantısı kuruldu.');

    client.on('message', message => {
        console.log(`Mesaj alındı: ${message.body} - Gönderen: ${message.from}`);
        const payload = JSON.stringify({
            from: message.from,
            message: message.body
        });
        ws.send(payload); // Mesajı WebSocket istemcisine gönder
    });
});

// QR kodu HTML sayfasında göstermek için değişken
let qrCodeUrl = '';

client.on('qr', async (qr) => {
    try {
        console.log('Yeni QR kodu alındı...');
        qrCodeUrl = await qrcode.toDataURL(qr);
        console.log('QR kod URL oluşturuldu.');
    } catch (error) {
        console.error('QR kod oluşturulurken hata:', error);
    }
});

// Bot hazır olduğunda
client.on('ready', () => {
    console.log('WhatsApp botu hazır!');
});

// Mesaj gönderme API'si
app.post('/send', (req, res) => {
    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).send({ status: 'error', error: 'Number and message are required.' });
    }

    const formattedNumber = `${number}@c.us`;

    client.sendMessage(formattedNumber, message)
        .then(response => {
            res.send({ status: 'success', response });
        })
        .catch(error => {
            console.error('Mesaj gönderilirken hata oluştu:', error);
            res.status(500).send({ status: 'error', error: error.message });
        });
});

// QR kodu gösteren rota
app.get('/qr', (req, res) => {
    if (qrCodeUrl) {
        res.send(`
            <html>
            <head>
                <title>WhatsApp QR Kodu</title>
            </head>
            <body style="display: flex; justify-content: center; align-items: center; height: 100vh; font-family: Arial, sans-serif;">
                <div style="text-align: center;">
                    <h1>WhatsApp QR Kodu</h1>
                    <p>Telefonunuzdaki WhatsApp uygulamasını açarak bu QR kodu tarayın.</p>
                    <img src="${qrCodeUrl}" alt="WhatsApp QR Kodu" style="max-width: 100%; height: auto;" />
                </div>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
            <head>
                <meta http-equiv="refresh" content="2">
                <title>QR Kodu Oluşturuluyor...</title>
            </head>
            <body style="display: flex; justify-content: center; align-items: center; height: 100vh; font-family: Arial, sans-serif;">
                <div style="text-align: center;">
                    <h1>QR Kodu Oluşturuluyor</h1>
                    <p>Lütfen birkaç saniye bekleyin...</p>
                </div>
            </body>
            </html>
        `);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});

client.initialize();
