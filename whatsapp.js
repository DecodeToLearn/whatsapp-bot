const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const FormData = require('form-data');
const { getImageEmbedding } = require('./image_embedding');
const findProductByEmbedding = require('./find_embedding_product');
const callChatGPTAPI = require('./callChatGPTAPI');
const clients = {};
module.exports = (app, wss) => {

    const qrCodes = {};
    const SESSION_DIR = './sessions';
    let isInitialCheckDone = false;

    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR);
    }

    // WhatsApp işlevleri burada olacak
    function createClient(userId) {
        console.log(`createClient fonksiyonu çağrıldı: ${userId}`); // Log ekleyelim
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
                console.log(`Kontaklar alındı: ${contacts.length} adet`); // Log ekleyelim
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
        
            // Yanıtlanmış mesajı kontrol et ve al
            if (msg.hasQuotedMsg) {
                const quotedMsg = await msg.getQuotedMessage();
                console.log(`Yanıtlanan mesaj: ${quotedMsg.body}`);
        
                // Yanıtlanan mesaja eklenen metni al
                const attachedMessage = msg.body ? msg.body : 'Eklenen metin yok';
                console.log(`Yanıtlanan mesaja eklenen metin: ${attachedMessage}`);
        
                // Eğer quotedMsg medyası varsa ve msg.body boş değilse, birleştir
                if (quotedMsg.hasMedia) {
                    const media = await quotedMsg.downloadMedia();
                    if (media) {
                        const combinedMessage = `${attachedMessage}\n[Medya: ${media.filename || 'dosya'}]`;
                        console.log(`Birleştirilmiş mesaj: ${combinedMessage}`);
                        const response = await getChatGPTResponse({ body: combinedMessage });
                        if (response) {
                            await msg.reply(response);
                        }
                    }
                } else {
                    // Yanıtlanan mesajın içeriği boşsa yanıtlanan mesajı gönder
                    if (!quotedMsg.body) {
                        const response = await getChatGPTResponse(quotedMsg);
                        if (response) {
                            await msg.reply(response);
                        }
                    } else {
                        // Yanıtlanan mesajın içeriği boş değilse attachedMessage'ı gönder
                        const response = await getChatGPTResponse({ body: attachedMessage });
                        if (response) {
                            await msg.reply(response);
                        }
                    }
                }
            }
        });
// Kontakları döndüren endpoint
app.get('/contacts/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        if (!userId) {
            return res.status(400).json({ error: 'User ID gereklidir.' });
        }
        if (!clients[userId]) {
            return res.status(400).json({ error: 'User not registered.' });
        }
        const activeClient = clients[userId];
        console.log(`${activeClient} WhatsApp botu hazır.`);
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
    const { userId } = req.query.userId;
    try {
        const limit = parseInt(req.query.limit) || 20;
        const { chatId } = req.params;

        if (!clients[userId]) {
            return res.status(400).json({ error: 'User not registered.' });
        }
        const activeClient = clients[userId];
        const chat = await activeClient.getChatById(chatId);
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
        try {
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
    
                            // Yanıtlanmış mesajı kontrol et ve al
                            if (msg.hasQuotedMsg) {
                                const quotedMsg = await msg.getQuotedMessage();
                                console.log(`Yanıtlanan mesaj: ${quotedMsg.body}`);
    
                                // Yanıtlanan mesaja eklenen metni al
                                const attachedMessage = msg.body ? msg.body : 'Eklenen metin yok';
                                console.log(`Yanıtlanan mesaja eklenen metin: ${attachedMessage}`);
    
                                // Eğer quotedMsg medyası varsa ve msg.body boş değilse, birleştir
                                if (quotedMsg.hasMedia) {
                                    const media = await quotedMsg.downloadMedia();
                                    if (media) {
                                        const combinedMessage = {
                                            body: attachedMessage,
                                            media: {
                                                filename: media.filename || 'dosya',
                                                mimetype: media.mimetype,
                                                data: media.data
                                            }
                                        };
                                        console.log(`Birleştirilmiş mesaj: ${JSON.stringify(combinedMessage)}`);
                                        const response = await getChatGPTResponse(combinedMessage);
                                        if (response) {
                                            await msg.reply(response);
                                        }
                                    }
                                } else {
                                    // Yanıtlanan mesajın içeriği boşsa yanıtlanan mesajı gönder
                                    if (!quotedMsg.body) {
                                        const response = await getChatGPTResponse(quotedMsg);
                                        if (response) {
                                            await msg.reply(response);
                                        }
                                    } else {
                                        // Yanıtlanan mesajın içeriği boş değilse attachedMessage'ı gönder
                                        const response = await getChatGPTResponse(attachedMessage);
                                        if (response) {
                                            await msg.reply(response);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Okunmamış mesajlar kontrol edilirken hata:', error);
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
        const questionsFileUrl = 'https://drive.google.com/uc?export=download&id=1lpn05Wby5KN1dXtm0kHVMkK2HxMgc1Mj';

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
        let media = null;
        // Eğer msg bir combinedMessage ise
        if (msg.body && typeof msg.body === 'object' && msg.body.body) {
            text = msg.body.body;
            media = msg.body.media;
        }
        console.log('Mesaj içeriği:', text);
        console.log('Mesaj içeriği:', media);
        console.log('Mesaj içeriği:', msg);
        if (media) {
            console.log('Mesajda medya var.');
            if (media.mimetype.startsWith('image/')) {
                console.log('Mesaj türü: image.');
                const filePath = await saveImageToFile(media, msg.id?._serialized, msg.timestamp);
                if (!filePath) {
                    return 'Resim işlenirken hata oluştu.';
                }
                return await handleImageMessage(filePath, text, questionsData, apiKey);
            } else if (media.mimetype.startsWith('audio/')) {
                console.log('Mesaj türü: ptt (voice message).');
                const audioBuffer = Buffer.from(media.data, 'base64');
                return await handleAudioMessage(audioBuffer, questionsData, apiKey);
            } else {
                console.log(`Mesaj türü: ${media.mimetype}. Sesli mesaj veya resim değil.`);
            }
        } else if (msg.hasMedia) {
            console.log('Mesajda medya var.');
            console.log('Mesaj türü:', msg.type);
            if (msg.type === 'ptt') {
                console.log('Mesaj türü: ptt (voice message).');
                const media = await msg.downloadMedia();
                const audioBuffer = Buffer.from(media.data, 'base64');
                return await handleAudioMessage(audioBuffer, questionsData, apiKey);
            } else if (msg.type === 'image') {
                console.log('Mesaj türü: image.');
                const media = await msg.downloadMedia();
                const filePath = await saveImageToFile(media, msg.id?._serialized, msg.timestamp);
                if (!filePath) {
                    return 'Resim işlenirken hata oluştu.';
                }
                return await handleImageMessage(filePath, text, questionsData, apiKey);
            } else {
                console.log(`Mesaj türü: ${msg.type}. Sesli mesaj veya resim değil.`);
            }
        } else {
                // Metin mesajı
                return await handleTextMessage(text, questionsData, apiKey);
            }
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
        if (!text || text.trim().length === 0) {
            console.error('Boş metin ile getEmbedding çağrıldı.');
            return null;
        }
    
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
            if (response?.data?.data?.[0]?.embedding) {
                return response.data.data[0].embedding;
            } else {
                console.error('Embedding API geçerli bir yanıt döndürmedi.');
                return null;
            }
        } catch (error) {
            console.error('Embedding API hatası:', error.message);
            return null;
        }
    }
    
    function cosineSimilarity(vec1, vec2) {
        if (!vec1 || !vec2 || vec1.length !== vec2.length) {
            console.error('Vektörler geçersiz veya farklı uzunlukta.');
            return null;
        }
    
        const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0);
        const magnitude1 = Math.sqrt(vec1.reduce((sum, val) => sum + val * val, 0));
        const magnitude2 = Math.sqrt(vec2.reduce((sum, val) => sum + val * val, 0));
    
        if (magnitude1 === 0 || magnitude2 === 0) {
            console.error('Vektörlerden biri sıfır büyüklüğüne sahip.');
            return null;
        }
    
        return dotProduct / (magnitude1 * magnitude2);
    }

    async function translateText(text, targetLanguage) {
        if (!text || text.trim() === '') {
            console.error('Çeviri için boş bir metin gönderildi.');
            return text; // Boş metni döndür
        }
        const apiKey = process.env.OPENAI_API_KEY;
    
        const apiUrl = 'https://api.openai.com/v1/chat/completions';
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };
    
        const data = {
            model: 'gpt-4o-2024-08-06',
            messages: [
                {
                    role: 'system',
                    content: `Çeviriyi yaparken, her dildeki mesajı hedef dil olan ${targetLanguage} diline çevir.`
                },
                {
                    role: 'user',
                    content: text
                }
            ]
        };
    
        try {
            const response = await axios.post(apiUrl, data, { headers });
            const translation = response.data.choices[0].message.content.trim();
            return translation;
        } catch (error) {
            console.error('Çeviri API hatası:', error.response?.data || error.message);
            return text; // Hata olursa orijinal metni döndür
        }
    }

    async function detectLanguage(text) {
        if (!text || text.trim() === '') {
            console.error('Çeviri için boş bir metin gönderildi.');
            return text; // Boş metni döndür
        }
        const apiKey = process.env.OPENAI_API_KEY;
    
        const apiUrl = 'https://api.openai.com/v1/chat/completions';
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };
    
        const data = {
            model: 'gpt-4o-2024-08-06',
            messages: [
                {
                    role: 'system',
                    content: 'Bu metni analiz et ve dilini algıla. Sadece dil kodunu döndür (ör: "tr", "en").'
                },
                {
                    role: 'user',
                    content: text
                }
            ]
        };
    
        try {
            const response = await axios.post(apiUrl, data, { headers });
            return response.data.choices[0].message.content.trim();
        } catch (error) {
            console.error('Dil algılama hatası:', error.message);
            return 'unknown';
        }
    }
    
    async function handleImageMessage(imageUrl, caption, questionsData, apiKey) {
        const userLanguage = await detectLanguage(caption); // Caption dilini algıla
        const translatedCaption = await translateText(caption, 'tr'); // Türkçe'ye çevir
    
        const keywords = ['fiyat', 'beden', 'renk', 'kumaş', 'içerik', 'boy', 'kalıp'];
        const containsKeywords = keywords.some(keyword => translatedCaption.toLowerCase().includes(keyword));
    
        if (containsKeywords) {
            console.log('Ürün bilgisi sorgulanıyor, embedding işlemine yönlendiriliyor...');
            const imageEmbedding = await getImageEmbedding(imageUrl);
            const product = await findProductByEmbedding(imageEmbedding, userLanguage);
    
            if (product) {
                const response = `Ürün Bilgisi:\nAd: ${product.name}\nFiyat: ${product.price}\nBeden: ${product.size}\nRenk: ${product.color}`;
                return await translateText(response, userLanguage); // Kullanıcının diline çevir ve döndür
            }
    
            return await translateText('Ürün bulunamadı.', userLanguage);
        }
    
            // Eğer anahtar kelime yoksa question.json dosyasını kontrol et
        let bestMatch = null;
        let highestSimilarity = 0;

        try {
            const userEmbedding = await getEmbedding(translatedCaption, apiKey); // Kullanıcı caption'ı embedding
            if (!userEmbedding) {
                console.error('Kullanıcı embedding alınamadı.');
                return await translateText('Bir hata oluştu, lütfen tekrar deneyin.', userLanguage);
            }

            // Question.json içeriğiyle benzerlik analizi
            for (const [question, answer] of Object.entries(questionsData)) {
                const questionEmbedding = await getEmbedding(question, apiKey);
                if (!questionEmbedding) {
                    console.error(`Soru için embedding alınamadı: ${question}`);
                    continue;
                }

                const similarity = cosineSimilarity(userEmbedding, questionEmbedding);
                if (similarity > highestSimilarity) {
                    highestSimilarity = similarity;
                    bestMatch = { question, answer };
                }
            }

            // Eğer eşleşme varsa cevap döndür
            if (highestSimilarity >= 0.85) {
                console.log(`En uygun cevap bulundu: ${bestMatch.question} (${highestSimilarity})`);
                const translatedResponse = await translateText(bestMatch.answer, userLanguage);
                return translatedResponse;
            }

        } catch (error) {
            console.error('Soru eşleştirme sırasında hata oluştu:', error);
        }

        // Eğer hiçbir eşleşme bulunamazsa ChatGPT API'ye yönlendir
        console.log('Benzer soru bulunamadı, ChatGPT API çağrılıyor...');
        // JSON'dan cevap bulunamazsa ChatGPT API'ye yönlendir
        return await callChatGPTAPI(translatedCaption, userLanguage, apiKey);
    }

    async function handleAudioMessage(audioBuffer, questionsData, apiKey) {
        try {
            // 1. Ses metne dönüştürülüyor
            const transcribedText = await transcribeAudio(audioBuffer); 
            if (!transcribedText) {
                console.error('Ses metne dönüştürülemedi.');
                return 'Ses metne dönüştürülürken bir hata oluştu.';
            }
    
            // 2. Dil algılama
            const userLanguage = await detectLanguage(transcribedText); 
            const translatedText = await translateText(transcribedText, 'tr'); // Türkçe'ye çevir
    
            let bestMatch = null;
            let highestSimilarity = 0;
    
            // 3. Benzerlik analizi için embedding'ler hazırlanıyor
            const userEmbedding = await getEmbedding(translatedText, apiKey);
            if (!userEmbedding) {
                console.error('Kullanıcı metni embedding alınamadı.');
                return 'Bir hata oluştu, lütfen tekrar deneyin.';
            }
    
            for (const [question, answer] of Object.entries(questionsData)) {
                const questionEmbedding = await getEmbedding(question, apiKey);
                if (!questionEmbedding) {
                    console.error(`Soru için embedding alınamadı: ${question}`);
                    continue;
                }
    
                const similarity = cosineSimilarity(userEmbedding, questionEmbedding);
                if (similarity > highestSimilarity) {
                    highestSimilarity = similarity;
                    bestMatch = { question, answer };
                }
            }
    
            // 4. En yüksek benzerlik eşik değeri ile karşılaştırılıyor
            if (highestSimilarity >= 0.85 && bestMatch) {
                console.log(`En uygun cevap bulundu: ${bestMatch.question} (${highestSimilarity})`);
                const translatedResponse = await translateText(bestMatch.answer, userLanguage); // Cevabı kullanıcı diline çevir
                return translatedResponse;
            }
    
            // 5. JSON'dan cevap bulunamazsa ChatGPT API'ye yönlendirilir
            console.log('Benzer soru bulunamadı, ChatGPT API çağrılıyor...');
            return await callChatGPTAPI(transcribedText, userLanguage, apiKey);
        } catch (error) {
            console.error('handleAudioMessage sırasında hata oluştu:', error);
            return 'Bir hata oluştu, lütfen tekrar deneyin.';
        }
    }
    async function handleTextMessage(msg, questionsData, apiKey) {
        try {
        const userLanguage = await detectLanguage(msg); // Mesajın dilini algıla
        const translatedText = await translateText(msg, 'tr'); // Türkçe'ye çevir

                // 2. Anahtar kelimelerle kategori belirle
                const selectedCategory = findCategory(translatedText, questionsData);
                if (!selectedCategory) {
                    console.log("Kategori bulunamadı. ChatGPT'ye yönlendiriliyor...");
                    return await callChatGPTAPI(msg, userLanguage, apiKey);
                }


        // 3. Seçilen kategoride soru eşleştirme
        const categoryQuestions = questionsData[selectedCategory].Sorular;
        const userEmbedding = await getEmbedding(translatedText, apiKey);

        if (!userEmbedding) {
            console.error("Kullanıcı embedding'i alınamadı.");
            return "Bir hata oluştu. Lütfen tekrar deneyin.";
        }
        let bestMatch = null;
        let highestSimilarity = 0;
        const similarityThreshold = 0.85; // Benzerlik için eşik değeri
    
        // Soruların embedding'lerini oluştur ve en iyi eşleşmeyi bul
        for (const [question, questionData] of Object.entries(categoryQuestions)) {
            for (const template of questionData.Şablonlar) {
                const questionEmbedding = await getEmbedding(template, apiKey);
                const similarity = cosineSimilarity(userEmbedding, questionEmbedding);

                if (similarity > highestSimilarity) {
                    highestSimilarity = similarity;
                    bestMatch = questionData.Cevap;
                }
            }
        }
    
        // Eşik değer kontrolü
        // 4. Eşleşme kontrolü ve cevap döndürme
        if (highestSimilarity >= similarityThreshold) {
            const translatedResponse = await translateText(bestMatch, userLanguage);
            console.log(`En uygun cevap bulundu: "${bestMatch}" (${highestSimilarity})`);
            return translatedResponse;
        } else {
            console.log("Uygun cevap bulunamadı. ChatGPT'ye yönlendiriliyor...");
            return await callChatGPTAPI(msg, userLanguage, apiKey);
        }
    } catch (error) {
        console.error("Bir hata oluştu:", error.message);
        return "Bir hata oluştu. Lütfen tekrar deneyin.";
    }
    }
        // Kategori bulma fonksiyonu
    function findCategory(text, questionsData) {
        const lowerCaseText = text.toLowerCase();
        for (const [category, data] of Object.entries(questionsData)) {
            if (data["Anahtar Kelimeler"].some(keyword => text.toLowerCase().includes(keyword.toLowerCase()))) {
                return category;
            }
        }
        return null; // Kategori bulunamadı
    }
module.exports.clients = clients;