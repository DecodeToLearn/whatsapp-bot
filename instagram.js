const axios = require('axios');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');

const clientsInsta = {};
let isInitialCheckDone = false;

module.exports = (app, wss) => {
    const SESSION_DIR = './instagram_sessions';

    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR);
    }

    // WebSocket bağlantısı
    wss.on('connection', (ws, req) => {
        // Bağlantı URL'sinden parametreleri al
        const params = new URLSearchParams(req.url.split('?')[1]);
        const instagramId = params.get('instagramId');
        const accessToken = params.get('accessToken');
    
        if (!instagramId || !accessToken) {
            console.error('🚨 Hatalı WebSocket Bağlantısı: Instagram ID veya Token eksik!');
            ws.close();
            return;
        }
    
        // Kullanıcıyı WebSocket istemcilerine ekle
        clientsInsta[instagramId] = { accessToken, connected: true };
        console.log(`✅ Instagram Bağlantı Kuruldu: ${instagramId}`);
    
        ws.on('message', (message) => {
            console.log('📩 Gelen WebSocket Mesajı:', message);
        });
    
        ws.on('close', () => {
            console.log(`🔴 Kullanıcı Bağlantıyı Kapattı: ${instagramId}`);
            delete clientsInsta[instagramId]; // Kullanıcıyı temizle
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
        const accessToken = clientsInsta[userId].accessToken;
        try {
            const response = await axios.get(`https://graph.instagram.com/v22.0/me/messages?access_token=${accessToken}`);
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
            for (const userId of Object.keys(clientsInsta)) {
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

    async function sendMessage(instagramId, recipientId, message) {
        const accessToken = clientsInsta[instagramId].accessToken;
        try {
            await axios.post(`https://graph.instagram.com/v22.0/me/messages?access_token=${accessToken}`, {
                recipient: { id: recipientId },
                message: { text: message }
            });
            console.log(`📤 Mesaj gönderildi: ${recipientId} -> ${message}`);
        } catch (error) {
            console.error('❌ Mesaj gönderilemedi:', error);
        }
    }

    
    app.post('/instagram', (req, res) => {
        const body = req.body;
    
        // Gelen webhook bildirimi
        if (body.object === 'instagram') {
            body.entry.forEach(entry => {
                if (entry.messaging) {
                    entry.messaging.forEach(event => {
                        const senderId = event.sender && event.sender.id ? event.sender.id : 'Bilinmeyen Gönderen';
                        console.log(`Yeni mesaj alındı: Gönderen ID: ${senderId}`);
    
                        // Metin mesajını kontrol et
                        if (event.message && event.message.text) {
                            const textMessage = event.message.text;
                            console.log(`Metin mesajı: ${textMessage}`);
                        }
    
                        // Eğer mesajda attachment (medya) varsa kontrol et
                        if (event.message && event.message.attachments) {
                            event.message.attachments.forEach(attachment => {
                                if (attachment.type === 'image') {
                                    const imageUrl = attachment.payload.url;
                                    console.log(`Görsel mesajı alındı: ${imageUrl}`);
                                } else if (attachment.type === 'audio') {
                                    const audioUrl = attachment.payload.url;
                                    console.log(`Sesli mesaj alındı: ${audioUrl}`);
                                } else if (attachment.type === 'video') {
                                    const videoUrl = attachment.payload.url;
                                    console.log(`Video mesajı alındı: ${videoUrl}`);
                                } else if (attachment.type === 'file') {
                                    const fileUrl = attachment.payload.url;
                                    console.log(`Dosya alındı: ${fileUrl}`);
                                } else {
                                    console.log(`Desteklenmeyen medya türü: ${attachment.type}`);
                                }
                            });
                        }
    
                        // Quick Reply kontrolü
                        if (event.message && event.message.quick_reply) {
                            const quickReplyPayload = event.message.quick_reply.payload;
                            console.log(`Quick Reply seçildi: ${quickReplyPayload}`);
                        }
    
                        // Reply to (yanıtlanan mesaj veya hikaye)
                        if (event.message && event.message.reply_to) {
                            if (event.message.reply_to.story) {
                                const storyUrl = event.message.reply_to.story.url;
                                console.log(`Hikayeye yanıt alındı: ${storyUrl}`);
                            } else if (event.message.reply_to.mid) {
                                const replyToMessageId = event.message.reply_to.mid;
                                console.log(`Yanıtlanan mesaj ID'si: ${replyToMessageId}`);
                            }
                        }
    
                        // Reklam bilgisi kontrolü
                        if (event.message && event.message.referral) {
                            const adRef = event.message.referral.ref;
                            const adId = event.message.referral.ad_id;
                            console.log(`Reklamdan gelen mesaj. Reklam ID: ${adId}, Referans: ${adRef}`);
                        }
    
                        // Echo (bot tarafından gönderilen mesaj)
                        if (event.message && event.message.is_echo) {
                            console.log('Echo (bot mesajı) alındı.');
                        }
    
                        // Silinmiş mesaj kontrolü
                        if (event.message && event.message.is_deleted) {
                            console.log('Bir mesaj silindi.');
                        }
    
                        // Desteklenmeyen mesaj kontrolü
                        if (event.message && event.message.is_unsupported) {
                            console.log('Desteklenmeyen bir mesaj alındı.');
                        }
                    });
                }
            });
    
            // Instagram'a başarılı olduğunu bildiriyoruz
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
                console.log('Challenge Kodu:', challenge);  // Challenge kodunu logla
                res.status(200).send(challenge);
            } else {
                res.sendStatus(403);
            }
        } else {
            res.sendStatus(400);  // Eğer mode veya token yoksa 400 hatası döndür
        }
    });
    

    app.get('/contacts-instagram', async (req, res) => {
        const { instagramId, accessToken } = req.query;
    
        if (!clientsInsta[instagramId]) {
            clientsInsta[instagramId] = { accessToken, connected: true };
        }
    
        try {
            // 📌 DM konuşmalarını çek
            const response = await axios.get(`https://graph.instagram.com/v22.0/${instagramId}/conversations?fields=id,participants,message_count&access_token=${accessToken}`);
            const conversations = response.data.data || []; // Boş array döndürerek hatayı önle
    
            // 🔍 **Her katılımcı için profili al**
            const contactList = await Promise.all(conversations.map(async (convo) => {
                const participants = convo.participants && Array.isArray(convo.participants.data) ? convo.participants.data : [];
                
                // **Kendi ID'n hariç birini bul**
                const participant = participants.find(p => p.id !== instagramId) || {}; 
    
                // 🔍 **Katılımcının tam adını (profile_name) çek**
                let profileName = "Bilinmeyen Kişi";
                if (participant.id) {
                    try {
                        const profileResponse = await axios.get(`https://graph.instagram.com/${participant.id}?fields=id,username,name&access_token=${accessToken}`);
                        profileName = profileResponse.data.name || participant.username; // Eğer isim varsa al, yoksa username kullan
                    } catch (err) {
                        console.error(`⚠️ Profil adı alınamadı: ${participant.id}`, err.message);
                    }
                }
    
                return {
                    chatId: convo.id, // Konuşma ID'si
                    userId: participant.id || "Bilinmiyor",
                    name: profileName, // 🔥 Artık username değil, gerçek isim!
                    message_count: convo.message_count || 0
                };
            }));
    
            res.json({ contacts: contactList });
    
        } catch (error) {
            console.error('❌ DM konuşmaları alınamadı:', error.response ? error.response.data : error.message);
            res.status(500).json({ error: 'Konuşmalar çekilemedi.', details: error.response ? error.response.data : error.message });
        }
    });
    
    
    app.get('/messages', (req, res) => {
        Message.find()
            .then(messages => {
                res.json(messages); // Mesajları JSON olarak döndür
            })
            .catch(err => {
                console.error('Mesajlar alınamadı:', err);
                res.status(500).send('Mesajlar alınamadı');
            });
    });

    app.get('/messages-instagram/:chatId', async (req, res) => {
        const { instagramId, accessToken } = req.query;
        const { chatId } = req.params;
    
        if (!clientsInsta[instagramId]) {
            clientsInsta[instagramId] = { accessToken, connected: true };
        }
    
        try {
            // API çağrısı
            const response = await axios.get(`https://graph.instagram.com/v22.0/${chatId}/messages?fields=id,message,from,created_time,attachments&access_token=${accessToken}`);
            
        // Mesajları işle
        const messages = response.data.data.map(message => {
            let type = "text"; // Varsayılan olarak metin mesajı
            let content = message.message || "Mesaj içeriği yok";

            // Eğer mesaj boşsa ve attachments yoksa, desteklenmeyen mesaj türü olarak işaretleyelim
            if (!message.message && !message.attachments) {
                type = "unsupported";
                content = "Desteklenmeyen mesaj türü (muhtemelen ses mesajı).";
            }

            // Attachments'ları işle
            const attachments = message.attachments ? message.attachments.data.map(attachment => {
                if (attachment.image_data) {
                    return {
                        type: "image",
                        url: attachment.image_data.url
                    };
                } else if (attachment.video_data) {
                    return {
                        type: "video",
                        url: attachment.video_data.url
                    };
                } else {
                    return {
                        type: "unsupported",
                        url: null
                    };
                }
            }) : [];

            return {
                id: message.id,
                username: message.from.username || "Bilinmeyen Kullanıcı",
                text: content,
                type: type,
                createdTime: new Date(message.created_time).toLocaleString('tr-TR'),
                attachments: attachments
            };
        });
    
            res.json({ messages });
        } catch (error) {
            console.error('Mesajlar alınırken hata:', error.response ? error.response.data : error.message);
            res.status(500).json({ error: 'Mesajlar alınamadı.', details: error.response ? error.response.data : error.message });
        }
    });
    
    
};


module.exports.clientsInsta = clientsInsta;