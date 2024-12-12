const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });
const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    preflightContinue: false,
    optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

// Loglama middleware'i
app.use((req, res, next) => {
    console.log('Gelen istek:', req.method, req.url);
    console.log('Başlıklar:', req.headers);
    next();
});

app.use(bodyParser.json());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    next();
});

app.options('*', cors(corsOptions));

// WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(),
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
    },
});

// Global değişkenler
let qrCodeUrl = '';
let contacts = [];

// QR kodu oluşturma ve yayınlama
client.on('qr', async (qr) => {
    try {
        qrCodeUrl = await qrcode.toDataURL(qr);
        console.log('QR kodu oluşturuldu.');
        broadcast({ type: 'qr', qrCode: qrCodeUrl });
    } catch (error) {
        console.error('QR kodu oluşturulurken hata:', error);
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
        broadcast({ type: 'contacts', contacts });
    } catch (error) {
        console.error('Kontaklar alınırken hata:', error);
    }
});

// WhatsApp bağlantısı kesildiğinde yeniden başlatma
client.on('disconnected', async (reason) => {
    console.log(`WhatsApp bağlantısı kesildi: ${reason}`);
    try {
        await client.destroy();
        setTimeout(() => client.initialize(), 5000);
    } catch (error) {
        console.error('Bağlantı yeniden başlatılamadı:', error);
    }
});

// Gelen mesajları işleme
client.on('message', async (message) => {
    try {
        if (message.hasMedia) {
            const media = await message.downloadMedia();
            if (media) {
                const filePath = saveMediaToFile(media);
                broadcast({
                    type: 'mediaMessage',
                    from: message.from,
                    caption: message.caption || '',
                    media: {
                        mimetype: media.mimetype,
                        url: filePath,
                    },
                });
            }
        } else if (message.type === 'location') {
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
        console.error('Mesaj işlenirken hata:', error);
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

// Mesaj gönderme API'si

app.post('/send', async (req, res) => {
    const { number, caption, media } = req.body;

    if (!number || (!caption && !media)) {
        return res.status(400).json({ error: 'Numara ve mesaj veya medya gereklidir.' });
    }

    try {
        const formattedNumber = number.includes('@c.us') ? number : `${number}@c.us`;

        if (media && media.path) {
            const mediaPath = path.resolve(media.path);
            if (media.type === 'image' || media.type === 'video') {
                await client.sendMessage(formattedNumber, {
                    media: fs.readFileSync(mediaPath), 
                    caption,
                });
            } else {
                return res.status(400).json({ error: 'Desteklenmeyen medya türü.' });
            }
        } else if (caption) {
            await client.sendMessage(formattedNumber, caption);
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Mesaj gönderilirken hata oluştu:', error);
        res.status(500).json({ error: error.message });
    }
});


// Medya dosyasını geçici bir dizine kaydetme
const saveMediaToFile = (media) => {
    if (!media || !media.data) {
        console.error('Medya verisi eksik.');
        return null;
    }
    const dir = path.join(__dirname, 'temp');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const fileExtension = media.mimetype.split('/')[1] || 'bin';
    const filePath = path.join(dir, `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExtension}`);
    fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
    return filePath;
};

// QR Kod EndPoint
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
            ws.send(JSON.stringify(data));
        }
    });
}

// Sunucuyu başlat
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});

client.initialize();
