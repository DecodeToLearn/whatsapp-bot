const axios = require('axios');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');

const clients = {};
let isInitialCheckDone = false;

// Kullanıcı kaydetme fonksiyonu
async function registerUser(userId, instagramId, accessToken) {
    clients[userId] = { instagramId, accessToken };
    console.log(`✅ Kullanıcı ${userId} (${instagramId}) başarıyla kaydedildi.`);
    checkUnreadMessages(userId);
    isInitialCheckDone = true;
}

module.exports = (app, wss) => {
    const SESSION_DIR = './instagram_sessions';

    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR);
    }

    // WebSocket bağlantısı
    wss.on('connection', (ws) => {
        ws.on('message', async (message) => {
            const data = JSON.parse(message);
            if (data.type === 'register') {
                const { userId, accessToken } = data;
                await registerUser(userId, accessToken);
            }
        });
    });

    async function checkIfReplied(message) {
        // Instagram API'sinde mesaj yanıtlarını kontrol etme
        // Bu kısım Instagram API'sine göre uyarlanmalıdır
        return false;
    }

    async function handleNewMessage(event) {
        const message = event.message;
        if (!message.out) {
            console.log('Yeni mesaj alındı:', message);

            const isReplied = await checkIfReplied(message);
            if (!isReplied) {
                const response = await getChatGPTResponse(message);
                if (response) {
                    await sendMessage(message.sender.id, response);
                }
            }
        }
    }

    async function checkUnreadMessages(userId) {
        const accessToken = clients[userId].accessToken;
        try {
            const response = await axios.get(`https://graph.instagram.com/v21.0/me/messages?access_token=${accessToken}`);
            const messages = response.data.data;

            for (const message of messages) {
                if (!message.is_read) {
                    console.log('Okunmamış mesaj bulundu:', message);
                    const isReplied = await checkIfReplied(message);
                    if (!isReplied) {
                        const response = await getChatGPTResponse(message);
                        if (response) {
                            await sendMessage(message.sender.id, response);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Hata:', error);
        }
    }

    setInterval(async () => {
        if (isInitialCheckDone) {
            for (const userId of Object.keys(clients)) {
                await checkUnreadMessages(userId);
            }
        }
    }, 1 * 60 * 1000); // 1 dakika

    async function getChatGPTResponse(message) {
        console.log('getChatGPTResponse fonksiyonu çağrıldı:', message);
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

        let text = message.text;
        let imageUrl = null;
        let caption = null;
        console.log('Mesaj içeriği:', message);

        if (message.attachments) {
            console.log('Mesajda medya var.');
            const attachment = message.attachments[0];
            if (attachment.type === 'image') {
                console.log('Mesaj türü: image.');
                const photoBuffer = await downloadMedia(attachment.url);
                const timestamp = Math.floor(Date.now() / 1000);
                const msgId = message.id;
                const filePath = await saveImageToFile(photoBuffer, msgId, timestamp);
                console.log(`Resim dosyası: ${filePath}`);
                if (!filePath) {
                    console.error('Resim dosyası kaydedilemedi.');
                    return null;
                }
                imageUrl = filePath;
                caption = message.text;
            } else if (attachment.type === 'audio') {
                console.log('Mesaj türü: audio.');
                const audioBuffer = await downloadMedia(attachment.url);
                text = await transcribeAudio(audioBuffer);
                console.log(`Sesli mesaj metne dönüştürüldü: ${text}`);
            } else {
                console.log(`Mesaj türü: ${attachment.type}. Sesli mesaj veya resim değil.`);
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

    async function saveImageToFile(mediaBuffer, msgId, timestamp) {
        if (!mediaBuffer) {
            console.error('Geçersiz medya dosyası.');
            return null;
        }

        const mediaDir = path.join(__dirname, 'media');

        if (!fs.existsSync(mediaDir)) {
            fs.mkdirSync(mediaDir);
        }

        const fileName = `${timestamp}_${msgId}.jpg`;
        const filePath = path.join(mediaDir, fileName);

        if (fs.existsSync(filePath)) {
            console.log('Medya dosyası zaten mevcut:', filePath);
            return `https://whatsapp-bot-ie3t.onrender.com/media/${fileName}`;
        }

        try {
            await fs.promises.writeFile(filePath, mediaBuffer);
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

    async function sendMessage(recipientId, message) {
        const accessToken = clients[recipientId].accessToken;
        try {
            await axios.post(`https://graph.instagram.com/v21.0/me/messages?access_token=${accessToken}`, {
                recipient: { id: recipientId },
                message: { text: message }
            });
            console.log('Mesaj gönderildi:', message);
        } catch (error) {
            console.error('Mesaj gönderilemedi:', error);
        }
    }

    app.post('/instagram', (req, res) => {
        const body = req.body;

        if (body.object === 'instagram') {
            body.entry.forEach(entry => {
                entry.messaging.forEach(event => {
                    if (event.message) {
                        handleNewMessage(event);
                    }
                });
            });
            res.status(200).send('EVENT_RECEIVED');
        } else {
            res.sendStatus(404);
        }
    });

    app.get('/instagram', (req, res) => {
        const VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN;

        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode && token) {
            if (mode === 'subscribe' && token === VERIFY_TOKEN) {
                console.log('Webhook doğrulandı');
                res.status(200).send(challenge);
            } else {
                res.sendStatus(403);
            }
        }
    });

    app.get('/contacts-instagram', async (req, res) => {
        const { userId } = req.query;

        if (!clients[userId]) {
            return res.status(400).json({ error: 'User not registered.' });
        }

        try {
            const accessToken = clients[userId].accessToken;
            const response = await axios.get(`https://graph.instagram.com/v21.0/me/contacts?access_token=${accessToken}`);
            const contacts = response.data.data.map(contact => ({
                id: contact.id,
                name: contact.name,
                profilePic: contact.profile_pic,
            }));

            res.json({ contacts });
        } catch (error) {
            console.error('Error fetching contacts:', error);
            res.status(500).json({ error: 'Failed to fetch contacts.' });
        }
    });

    app.get('/messages-instagram/:chatId', async (req, res) => {
        const { userId } = req.query;
        const { chatId } = req.params;

        if (!clients[userId]) {
            return res.status(400).json({ error: 'User not registered.' });
        }

        try {
            const accessToken = clients[userId].accessToken;
            const response = await axios.get(`https://graph.instagram.com/v21.0/${chatId}/messages?access_token=${accessToken}`);
            const messages = response.data.data.map(message => ({
                id: message.id,
                from: message.from.id,
                text: message.text,
                media: message.attachments ? message.attachments.map(attachment => ({
                    type: attachment.type,
                    url: attachment.url,
                })) : null,
            }));

            res.json({ messages });
        } catch (error) {
            console.error('Error fetching messages:', error);
            res.status(500).json({ error: 'Failed to fetch messages.' });
        }
    });
};

module.exports.registerUser = registerUser;
module.exports.clients = clients;