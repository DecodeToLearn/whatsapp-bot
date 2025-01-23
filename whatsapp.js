const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const FormData = require('form-data');

module.exports = (app, wss) => {
    const clients = {};
    const qrCodes = {};
    const SESSION_DIR = './sessions';
    let isInitialCheckDone = false;

    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR);
    }

    // WhatsApp işlevleri burada olacak
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

    setInterval(async () => {
        if (isInitialCheckDone) {
            for (const client of Object.values(clients)) {
                await checkUnreadMessages(client);
            }
        }
    }, 1 * 60 * 1000); // 5 dakika

    async function getChatGPTResponse(msg) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            console.error('OpenAI API anahtarı tanımlanmamış.');
            return null;
        }

        const questionsFilePath = path.join(__dirname, 'questions.json');
        const questionsFileUrl = 'https://drive.google.com/uc?export=download&id=1kfUA2QYRu6wt8SibOPiz6jo21_hzJTTu';

        let downloadFile = false;
        if (fs.existsSync(questionsFilePath)) {
            const localFileHash = await calculateFileHash(questionsFilePath);
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

        const questionsData = JSON.parse(fs.readFileSync(questionsFilePath, 'utf8'));

        let text = msg.body;
        let imageUrl = null;
        let caption = null;
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
            } else if (msg.type === 'image') {
                console.log('Mesaj türü: image.');
                const media = await msg.downloadMedia();
                const filePath = await saveImageToFile(media, msg.id?._serialized, msg.timestamp);
                console.log(`Resim dosyası: ${filePath}`);
                if (!filePath) {
                    console.error('Resim dosyası kaydedilemedi.');
                    return null;
                }
                imageUrl = filePath;
                caption = msg.body;
            } else {
                console.log(`Mesaj türü: ${msg.type}. Sesli mesaj veya resim değil.`);
            }
        } else {
            console.log('Mesajda medya yok.');
        }

        if (imageUrl && caption) {
            const reply = await handleImageWithCaption(imageUrl, caption, questionsData, apiKey);
            if (reply) {
                return reply;
            }
        }

        const userQuestionEmbedding = await getEmbedding(text, apiKey);

        let bestMatch = null;
        let highestSimilarity = 0;

        const embeddingPromises = Object.entries(questionsData).map(async ([question, answer]) => {
            const questionEmbedding = await getEmbedding(question, apiKey);
            const similarity = cosineSimilarity(userQuestionEmbedding, questionEmbedding);

            if (similarity > highestSimilarity) {
                highestSimilarity = similarity;
                bestMatch = { question, answer };
            }
        });
        await Promise.all(embeddingPromises);

        if (highestSimilarity >= 0.8) {
            console.log(`En benzer soru bulundu: ${bestMatch.question} (${highestSimilarity})`);
            return bestMatch.answer;
        }

        const apiUrl = 'https://api.openai.com/v1/chat/completions';
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };

        const promptText = "Sana gelen mesaj da eğer resim varsa resimi analiz et ve mesajın metnini oku doğru bir cevap yaz eğer cevabından emin değilsen bu metini gelen mesajın dilin de yaz\n\n1. Sizin için satış temsilcimiz en kısa sürede bilgi verecek";
        const data = {
            model: "gpt-4o-2024-08-06",
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

    async function saveImageToFile(media, msgId, timestamp) {
        if (!media || !media.mimetype || !media.data) {
            console.error('Geçersiz medya dosyası.');
            return null;
        }

        const mediaDir = path.join(__dirname, 'media');

        if (!fs.existsSync(mediaDir)) {
            fs.mkdirSync(mediaDir);
        }

        const extension = media.mimetype.split('/')[1] || 'unknown';
        const fileName = `${timestamp}_${msgId}.${extension}`;
        const filePath = path.join(mediaDir, fileName);

        if (fs.existsSync(filePath)) {
            console.log('Medya dosyası zaten mevcut:', filePath);
            return `https://whatsapp-bot-ie3t.onrender.com/media/${fileName}`;
        }

        try {
            await fs.promises.writeFile(filePath, media.data, 'base64');
            console.log('Medya dosyası kaydedildi:', filePath);
            return `https://whatsapp-bot-ie3t.onrender.com/media/${fileName}`;
        } catch (error) {
            console.error('Medya dosyası kaydedilirken hata:', error);
            return null;
        }
    }

    async function transcribeAudio(audioBuffer) {
        const inputPath = 'input.ogg';
        const outputPath = 'output.mp3';
        const apiKey = process.env.OPENAI_API_KEY;
        fs.writeFileSync(inputPath, audioBuffer);

        try {
            await convertOggToMp3(inputPath, outputPath);
            console.log('Dönüştürme tamamlandı.');

            const formData = new FormData();
            formData.append('file', fs.createReadStream(outputPath));
            formData.append('model', 'whisper-1');

            const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Authorization': `Bearer ${apiKey}`
                }
            });

            const data = response.data;
            console.log('Transkripsiyon:', data.text);
            return data.text;
        } catch (error) {
            console.error('Bir hata oluştu:', error);
            try {
                fs.unlinkSync(inputPath);
                fs.unlinkSync(outputPath);
            } catch (fileError) {
                console.error('Dosya silme işlemi sırasında hata:', fileError);
            }
            return '';
        } finally {
            try {
                fs.unlinkSync(inputPath);
                fs.unlinkSync(outputPath);
            } catch (finalError) {
                console.error('Dosya silme işlemi sırasında final hata:', finalError);
            }
        }
    }

    function convertOggToMp3(inputPath, outputPath) {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .toFormat('mp3')
                .on('end', () => resolve())
                .on('error', (err) => reject(err))
                .save(outputPath);
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


    async function handleImageWithCaption(imageUrl, caption, questionsData, apiKey) {
    /* const userQuestionEmbedding = await getEmbedding(caption, apiKey);

        // JSON'daki soruların embedding'lerini oluştur ve en benzerini bul
        let bestMatch = null;
        let highestSimilarity = 0;

        const embeddingPromises = Object.entries(questionsData).map(async ([question, answer]) => {
            const questionEmbedding = await getEmbedding(question, apiKey);
            const similarity = cosineSimilarity(userQuestionEmbedding, questionEmbedding);

            if (similarity > highestSimilarity) {
                highestSimilarity = similarity;
                bestMatch = { question, answer };
            }
        });

        await Promise.all(embeddingPromises);

        // Eğer benzerlik skoru eşik değerin üzerinde ise JSON'daki cevabı döndür
        if (highestSimilarity >= 0.8) {
            console.log(`En benzer soru bulundu: ${bestMatch.question} (${highestSimilarity})`);
            return bestMatch.answer;
        }
    */
        // Eğer eşleşme bulunmazsa ChatGPT API çağrısı yap
        const messages = [
            { role: 'system', content: 'Analyze the following images.' },
            {
                role: "user",
                content: [
                    { type: "text", text: caption },
                    {
                        type: "image_url",
                        image_url: {
                            "url": imageUrl, // URL'yi kullan
                        },
                    },
                ],
            },
        ];

        const apiUrl = 'https://api.openai.com/v1/chat/completions';
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };

        const data = {
            model: "gpt-4o-mini", // use model that can do vision
            messages: messages,
        };

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
};