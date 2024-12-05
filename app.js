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

// QR kodu oluşturma ve dinamik yenileme
let qrCodeUrl = '';
client.on('qr', async (qr) => {
    try {
        console.log('Yeni QR kodu alındı...');
        qrCodeUrl = await qrcode.toDataURL(qr);
        console.log('QR kod URL oluşturuldu.');

        // WebSocket istemcilerine QR kodunu gönder
        wss.clients.forEach((ws) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'qr', qrCode: qrCodeUrl }));
            }
        });
    } catch (error) {
        console.error('QR kod oluşturulurken hata:', error);
    }
});

// Gelen mesajları WebSocket üzerinden ilet
wss.on('connection', (ws) => {
    console.log('Yeni bir WebSocket bağlantısı kuruldu.');

    // Mesaj alındığında istemcilere gönder
    client.on('message', (message) => {
        console.log(`Mesaj alındı: ${message.body} - Gönderen: ${message.from}`);
        const payload = JSON.stringify({
            type: 'message',
            from: message.from,
            message: message.body
        });
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    });

    // QR kod bağlantısı için ilk durumu gönder
    if (qrCodeUrl) {
        ws.send(JSON.stringify({ type: 'qr', qrCode: qrCodeUrl }));
    }
});

// QR kodunu her 30 saniyede bir yenile
setInterval(() => {
    client.pupPage.evaluate(() => {
        window.Store && window.Store.State && window.Store.State.Socket.disconnect();
    }).catch(err => console.error('QR kod yenileme sırasında hata:', err));
}, 30000);

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

// QR kodunu HTML olarak döndüren endpoint
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

// Bot hazır olduğunda
client.on('ready', () => {
    console.log('WhatsApp botu hazır!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});

client.initialize();
