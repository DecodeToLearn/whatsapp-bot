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
            timeout: 60000,
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

    function updateContactList(contacts) {
        // 🔄 Kontakları okunmamış mesajlara ve son mesaj zamanına göre sırala
        contacts.sort((a, b) => {
            const unreadDiff = b.unreadCount - a.unreadCount;
            if (unreadDiff !== 0) return unreadDiff;
            return new Date(b.lastMessageTime) - new Date(a.lastMessageTime);
        });
    
        contactListDiv.innerHTML = ''; // Eski kontakları temizle
    
        contacts.forEach(contact => {
            // 📋 Her bir kontak için div oluştur
            const contactItem = document.createElement('div');
            contactItem.classList.add('contact-item', 'p-2', 'border', 'mb-2', 'bg-light');
            contactItem.dataset.id = contact.id;
    
            // 🔔 Kontak ismi ve okunmamış mesaj sayısını göster
            const unreadBadge = contact.unreadCount > 0 ? `<span class="badge bg-danger ms-2">${contact.unreadCount}</span>` : '';
            contactItem.innerHTML = `<strong>${contact.name}</strong> ${unreadBadge}`;
    
            // 🖱️ Kontak tıklama olayı
            contactItem.onclick = () => {
                currentChatId = contact.id;
                chatHeader.innerText = contact.name;
                messageListDiv.innerHTML = '';
                messagePlaceholder.style.display = 'none';
    
                // 📩 Mesajları kontak ID'sine göre çek
                fetchMessages(currentChatId);
            };
    
            contactListDiv.appendChild(contactItem);
        });
    }
    


    client.on('message', async (message) => {
        console.log(`Mesaj Alındı: ${message.body}`);
        try {
            if (message.hasMedia) {
                const media = await message.downloadMedia();
                if (media) {
                    const filePath = saveMediaToFile(media);
    
                    // 🎥 Video mesajları için özel kontrol
                    if (media.mimetype.startsWith('video/')) {
                        broadcast({
                            type: 'videoMessage',
                            from: message.from,
                            caption: message.caption || '',
                            media: {
                                mimetype: media.mimetype,
                                url: filePath,
                            },
                        });
                    } else {
                        // 📷 Diğer medya mesajları için
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
                }
            } else if (message.location) {
                // 📍 Konum mesajları için
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
                // 👤 Kişi kartı mesajları için
                broadcast({
                    type: 'contactMessage',
                    from: message.from,
                    contact: message.vCard,
                });
            } else {
                // 📝 Metin mesajları için
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
    
    client.on('disconnected', (reason) => {
        console.log(`${userId} bağlantısı kesildi: ${reason}`);
        setTimeout(() => createClient(userId), 5000);
    });

    client.initialize();
    clients[userId] = client;
}

function updateMessageList(messages) {
    messageListDiv.innerHTML = ''; // Eski mesajları temizle

    messages.forEach(msg => {
        const msgElement = document.createElement('div');
        msgElement.classList.add('message-item', 'p-2', 'mb-2', 'border', 'rounded');

        if (msg.media) {
            if (msg.media.mimetype === 'video/mp4') {
                // 🎥 Video mesajları için
                msgElement.innerHTML = `
                    <p><strong>${msg.from}:</strong></p>
                    <video controls style="max-width: 100%; height: auto;">
                        <source src="${msg.media.url}" type="video/mp4">
                        Tarayıcınız video formatını desteklemiyor.
                    </video>
                    <p>${msg.body}</p>
                `;
            } else if (msg.media.mimetype.startsWith('image/')) {
                // 🖼 Görsel mesajlar için
                msgElement.innerHTML = `
                    <p><strong>${msg.from}:</strong></p>
                    <p>${msg.body}</p>
                    <a href="${msg.media.url}" target="_blank">
                        <img src="${msg.media.url}" alt="Media" style="max-width: 100%; height: auto;">
                    </a>
                `;
            } else {
                console.warn('Desteklenmeyen medya formatı:', msg.media.mimetype);
            }
        } else {
            // 📝 Metin mesajları için
            msgElement.innerHTML = `
                <p><strong>${msg.from}:</strong> ${msg.body}</p>
            `;
        }

        messageListDiv.appendChild(msgElement);
    });

    messagePlaceholder.style.display = 'none';
}



function updateUnreadCount(contactId, unreadCount) {
    const contactItem = document.querySelector(`[data-id="${contactId}"]`);
    if (!contactItem) return;

    // Badge güncelle
    const badge = contactItem.querySelector('.badge');
    if (unreadCount > 0) {
        if (badge) {
            badge.innerText = unreadCount; // Mevcut Badge'i güncelle
        } else {
            // Badge yoksa yeni ekle
            const unreadBadge = document.createElement('span');
            unreadBadge.classList.add('badge', 'bg-danger', 'ms-2');
            unreadBadge.innerText = unreadCount;
            contactItem.appendChild(unreadBadge);
        }
    } else {
        // Okunmamış mesaj yoksa Badge'i kaldır
        if (badge) {
            badge.remove();
        }
    }
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
