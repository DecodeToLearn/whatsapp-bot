// ✨ WhatsApp Web.js Client App (Optimized)
// 🎯 Designed with KG08 Rules
require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Readable, Writable } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const FormData = require('form-data');

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
let cachedHtmlTable = null;
let cachedPdf = null;
// Medya dosyalarını statik olarak sun
app.use('/media', express.static(path.join(__dirname, 'media'), {
    maxAge: '1d', // Tarayıcı cache'te 7 gün saklar
}));
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
let isInitialCheckDone = false; // Bayrak tanımlama

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
            timeout: 1200000,
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
            // Okunmamış mesajları kontrol et
            broadcast({ type: 'contacts', contacts, userId });
            checkUnreadMessages(client);
            isInitialCheckDone = true; // İlk kontrol tamamlandı
        } catch (error) {
            console.error('Kontaklar alınırken hata:', error);
        }
    });
    client.on('message', async (msg) => {
        if (msg.fromMe || msg.hasMedia) return;

        const isReplied = await checkIfReplied(msg);
        if (!isReplied) {
            const response = await getChatGPTResponse(msg);
            if (response) {
                await msg.reply(response);
            }
        }
    });

    // Kontakları döndüren endpoint
    app.get('/contacts', async (req, res) => {
        try {
            const activeClient = Object.values(clients)[0];
            if (!activeClient) {
                return res.status(404).json({ error: 'Aktif bir WhatsApp oturumu yok.' });
            }

            const contacts = await activeClient.getContacts();
            const formattedContacts = contacts.map(contact => ({
                id: contact.id._serialized,
                name: contact.name || contact.pushname || contact.id.user,
            }));

            res.status(200).json({ contacts: formattedContacts });
        } catch (error) {
            console.error('Kontaklar alınırken hata:', error);
            res.status(500).json({ error: 'Kontaklar alınırken hata oluştu.' });
        }
    });

    const saveMediaToFile = async (media, msgId, timestamp) => {
        if (!media || !media.mimetype || !media.data) {
            console.error('Geçersiz medya dosyası.');
            return null;
        }
    
        const mediaDir = path.join(__dirname, 'media');
    
        // 📁 Klasör yoksa oluştur
        if (!fs.existsSync(mediaDir)) {
            fs.mkdirSync(mediaDir);
        }
    
        // ✅ Dosya adı belirleme: timestamp + messageId
        const extension = media.mimetype.split('/')[1] || 'unknown';
        const fileName = `${timestamp}_${msgId}.${extension}`;
        const filePath = path.join(mediaDir, fileName);
    
        // ✅ Eğer dosya varsa, URL'yi döndür
        if (fs.existsSync(filePath)) {
            console.log('Medya dosyası zaten mevcut:', filePath);
            return `https://whatsapp-bot-ie3t.onrender.com/media/${fileName}`;
        }
    
        // ✅ Dosya yoksa indir ve kaydet
        try {
            await fs.promises.writeFile(filePath, media.data, 'base64');
            console.log('Medya dosyası kaydedildi:', filePath);
            return `https://whatsapp-bot-ie3t.onrender.com/media/${fileName}`;
        } catch (error) {
            console.error('Medya dosyası kaydedilirken hata:', error);
            return null;
        }
    };
    
    
    
    const downloadedMedia = new Set();
    app.get('/messages/:chatId', async (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 20;
            const activeClient = Object.values(clients)[0];
    
            if (!activeClient) {
                return res.status(404).json({ error: 'Aktif bir WhatsApp oturumu yok.' });
            }
    
            const chat = await activeClient.getChatById(req.params.chatId);
            const messages = await chat.fetchMessages({ limit });
    
            const formattedMessages = await Promise.all(
                messages.map(async (msg) => {
                    const formattedMsg = {
                        from: msg.from,
                        body: msg.body || '',
                        media: null,
                        timestamp: msg.timestamp,
                    };
    
                    // 📝 **Log mesaj ID ve medya durumu**
                    console.log(`Mesaj ID: ${msg.id?._serialized || 'ID Yok'}`);
                    console.log(`Medya Var mı: ${msg.hasMedia ? 'Evet' : 'Hayır'}`);
    
                    // ✅ Eğer mesajın medyası varsa işle
                    if (msg.hasMedia) {
                        const media = await msg.downloadMedia();
                        if (media) {
                            const extension = media.mimetype?.split('/')[1] || 'unknown';
                            const mediaFileName = `${msg.timestamp}_${msg.id?._serialized}.${extension}`;
                            const mediaFilePath = path.join(__dirname, 'media', mediaFileName);
    
                            // ✅ Medya dosyasını önceden kaydedildiyse URL döndür
                            if (fs.existsSync(mediaFilePath)) {
                                console.log('Medya dosyası zaten mevcut:', mediaFilePath);
                                formattedMsg.media = {
                                    mimetype: media.mimetype,
                                    url: `https://whatsapp-bot-ie3t.onrender.com/media/${mediaFileName}`,
                                };
                            } else {
                                // ✅ Dosya yoksa indir ve kaydet
                                const savedMediaUrl = await saveMediaToFile(media, msg.id?._serialized, msg.timestamp);
                                if (savedMediaUrl) {
                                    formattedMsg.media = {
                                        mimetype: media.mimetype,
                                        url: savedMediaUrl,
                                    };
                                }
                            }
                        } else {
                            console.warn('Medya indirme başarısız:', msg.id?._serialized || 'ID Yok');
                        }
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
async function checkIfReplied(msg) {
    return msg.hasQuotedMsg;
}

async function checkUnreadMessages(client) {
    const chats = await client.getChats();
    for (const chat of chats) {
        if (chat.unreadCount > 0) {
            console.log(`Okunmamış mesaj sayısı: ${chat.unreadCount}, Chat ID: ${chat.id._serialized}`);
            const unreadMessages = await chat.fetchMessages({ limit: chat.unreadCount });
            for (const msg of unreadMessages) {
                if (!msg.isRead) {
                    const isReplied = await checkIfReplied(msg);
                    if (!isReplied) {
                        const response = await getChatGPTResponse(msg);
                        if (response) {
                            await msg.reply(response);
                        }
                    }
                }
            }
        }
    }
}

// checkUnreadMessages fonksiyonunu her 5 dakikada bir tetikleyin
setInterval(async () => {
    if (isInitialCheckDone) {
        for (const client of Object.values(clients)) {
            await checkUnreadMessages(client);
        }
    }
}, 5 * 60 * 1000); // 5 dakika

async function getChatGPTResponse(msg) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error('OpenAI API anahtarı tanımlanmamış.');
        return null;
    }

    const questionsFilePath = path.join(__dirname, 'questions.json');
    const questionsFileUrl = 'https://drive.google.com/uc?export=download&id=1kfUA2QYRu6wt8SibOPiz6jo21_hzJTTu';

    // JSON dosyasını kontrol et ve indir
    let downloadFile = false;
    if (fs.existsSync(questionsFilePath)) {
        // Sunucudaki dosyanın hash değerini hesapla
        const localFileHash = await calculateFileHash(questionsFilePath);

        // Linkteki dosyanın hash değerini hesapla
        const response = await axios.get(questionsFileUrl, { responseType: 'arraybuffer' });
        const remoteFileHash = crypto.createHash('md5').update(response.data).digest('hex');

        if (localFileHash !== remoteFileHash) {
            downloadFile = true;
        }
    } else {
        downloadFile = true;
    }

    if (downloadFile) {
        console.log('JSON dosyası indiriliyor...');
        const response = await axios.get(questionsFileUrl, { responseType: 'stream' });
        const writer = fs.createWriteStream(questionsFilePath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        console.log('JSON dosyası indirildi.');
    }

    // JSON dosyasını yükle
    const questionsData = JSON.parse(fs.readFileSync(questionsFilePath, 'utf8'));

    let text = msg.body;

    // Eğer mesaj sesli mesaj ise, metne dönüştür
    console.log('Mesaj içeriği:', msg);

    if (msg.hasMedia) {
        console.log('Mesajda medya var.');
        console.log('Mesaj türü:', msg.type);
        if (msg.type === 'ptt') {
            console.log('Mesaj türü: ptt (voice message).');
            const media = await msg.downloadMedia();
            const audioBuffer = Buffer.from(media.data, 'base64');
            text = await transcribeAudio(audioBuffer);
            console.log(`Sesli mesaj metne dönüştürüldü: ${text}`);
        } else {
            console.log(`Mesaj türü: ${msg.type}. Sesli mesaj değil.`);
        }
    } else {
        console.log('Mesajda medya yok.');
    }

    // Gelen sorunun embedding'ini oluştur
    const userQuestionEmbedding = await getEmbedding(text, apiKey);

    // JSON'daki soruların embedding'lerini oluştur ve en benzerini bul
    let bestMatch = null;
    let highestSimilarity = 0;

    for (const [question, answer] of Object.entries(questionsData)) {
        const questionEmbedding = await getEmbedding(question, apiKey);
        const similarity = cosineSimilarity(userQuestionEmbedding, questionEmbedding);

        if (similarity > highestSimilarity) {
            highestSimilarity = similarity;
            bestMatch = { question, answer };
        }
    }

    // Eğer benzerlik skoru eşik değerin üzerinde ise JSON'daki cevabı döndür
    if (highestSimilarity >= 0.8) {
        console.log(`En benzer soru bulundu: ${bestMatch.question} (${highestSimilarity})`);
        return bestMatch.answer;
    }

    // Eğer eşleşme bulunmazsa ChatGPT API çağrısı yap
    const apiUrl = 'https://api.openai.com/v1/chat/completions';
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
    };

    const promptText = "Sana gelen mesaj da eğer resim varsa resimi analiz et ve mesajın metnini oku doğru bir cevap yaz eğer cevabından emin değilsen bu metini gelen mesajın dilin de yaz\n\n1. Sizin için satış temsilcimiz en kısa sürede bilgi verecek";
    const data = {
        model: "gpt-4o-2024-05-13",
        messages: [
            {
                role: "user",
                content: promptText
            },
            {
                role: "user",
                content: text
            }
        ],
        max_tokens: 1600,
        temperature: 0.7
    };

    if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        if (media.mimetype.startsWith('image/')) {
            const base64Image = `data:${media.mimetype};base64,${media.data}`;
            data.messages.push({
                role: "user",
                content: {
                    type: "image_url",
                    image_url: base64Image,
                    detail: "high"
                }
            });
        } else if (media.mimetype.startsWith('video/')) {
            console.log('Video mesajı ChatGPT API\'ye gönderilmeyecek.');
            return null;
        }
    }

    try {
        console.log('ChatGPT API isteği gönderiliyor:', data);
        const response = await axios.post(apiUrl, data, { headers });
        console.log('ChatGPT API yanıtı alındı:', response.data);
        const reply = response.data.choices[0].message.content.trim();
        return reply;
    } catch (error) {
        console.error('ChatGPT API hatası:', error);
        return null;
    }
}

async function transcribeAudio(audioBuffer) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error('OpenAI API anahtarı tanımlanmamış.');
        return '';
    }

    // Ses dosyasını audio/mpeg formatına dönüştür
    const convertedBuffer = await convertToMp3(audioBuffer);
    console.log('Converted buffer length:', convertedBuffer.length);

    const formData = new FormData();
    formData.append("file", convertedBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    formData.append("model", "whisper-1");
    try {
        const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            headers: {
                ...formData.getHeaders(),
                Authorization: `Bearer ${apiKey}`,
            },
            method: "POST",
            body: formData,
        });

        const data = await response.json();
        if (data.text) {
            console.log(`Transcription: ${data.text}`);
            return data.text;
        } else {
            console.error('Transkripsiyon hatası:', data);
            return '';
        }
    } catch (error) {
        console.error('Sesli mesaj transkripsiyon hatası:', error);
        return '';
    }
}

function convertToMp3(audioBuffer) {
    return new Promise((resolve, reject) => {
        const inputStream = new Readable();
        inputStream.push(audioBuffer);
        inputStream.push(null);

        const chunks = [];
        const outputStream = new Writable({
            write(chunk, encoding, callback) {
                chunks.push(chunk);
                callback();
            }
        });

        ffmpeg(inputStream)
            .toFormat('mp3')
            .on('end', () => resolve(Buffer.concat(chunks)))
            .on('error', (err) => {
                console.error('FFmpeg error:', err);
                reject(err);
            })
            .pipe(outputStream, { end: true });
    });
}

async function calculateFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

async function getEmbedding(text, apiKey) {
    const apiUrl = 'https://api.openai.com/v1/embeddings';
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
    };
    const data = {
        model: "text-embedding-ada-002",
        input: text
    };

    try {
        const response = await axios.post(apiUrl, data, { headers });
        return response.data.data[0].embedding;
    } catch (error) {
        console.error('Embedding API hatası:', error);
        return null;
    }
}

function cosineSimilarity(vec1, vec2) {
    const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0);
    const magnitude1 = Math.sqrt(vec1.reduce((sum, val) => sum + val * val, 0));
    const magnitude2 = Math.sqrt(vec2.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magnitude1 * magnitude2);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
