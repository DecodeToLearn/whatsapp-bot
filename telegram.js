const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { NewMessageEvent } = require('telegram/events/NewMessage');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');

const clients = {};
let isInitialCheckDone = false;

module.exports = (app, wss) => {
    const SESSION_DIR = './telegram_sessions';

    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR);
    }

    async function createClient(userId, apiId, apiHash, phoneNumber, password, phoneCode) {
        const sessionPath = path.join(SESSION_DIR, `${userId}.session`);
        const stringSession = new StringSession(fs.existsSync(sessionPath) ? fs.readFileSync(sessionPath, 'utf8') : '');

        const client = new TelegramClient(stringSession, Number(apiId), apiHash, {
            connectionRetries: 5,
        });

        await client.start({
            phoneNumber: () => phoneNumber,
            password: () => password,
            phoneCode: () => phoneCode,
            onError: (err) => console.log(err),
        });

        console.log('You should now be connected.');
        fs.writeFileSync(sessionPath, client.session.save());

        clients[userId] = client;

        client.addEventHandler(async (event) => {
            const message = event.message || event.originalArgs.message; // Mesaj nesnesini doğru alın
            if (!message) return; // Eğer mesaj yoksa devam etme
        
            console.log('Yeni mesaj alındı:', message);
        
            // Mesajın outgoing (giden) olup olmadığını kontrol edin
            if (message.out) return;
        
            const isReplied = await checkIfReplied(message);
            if (!isReplied) {
                console.log('Mesaj daha önce yanıtlanmamış, ChatGPT yanıtı alınıyor...');
                const response = await getChatGPTResponse(message);
                if (response) {
                    console.log('ChatGPT yanıtı alındı, mesaj gönderiliyor...');
                    await client.sendMessage(message.peerId, { message: response });
                }
            }
        }, new NewMessage({}));


        checkUnreadMessages(client);
        isInitialCheckDone = true;
    }
    async function checkIfReplied(message) {
        if (!message || !message.replyTo) return false; // Yanıtlanmamış
        const replies = await message.getReplies(); // Yanıtları al
        return replies && replies.length > 0; // Eğer yanıt varsa true döndür
    }

    async function checkUnreadMessages(client) {
        try {
            const dialogs = await client.getDialogs({ limit: 100 });
            for (const dialog of dialogs) {
                const peer = dialog.entity; // Dialogdaki peer alınmalı
                if (!peer || !(peer instanceof Api.PeerUser)) continue; // Sadece kullanıcılar için işlem yapın
    
                const unreadCount = dialog.unreadCount || 0; // Okunmamış mesaj sayısını alın
                if (unreadCount > 0) {
                    console.log(`Okunmamış mesaj sayısı: ${unreadCount}, Peer ID: ${peer.id}`);
    
                    const unreadMessages = await client.getMessages(peer, { limit: unreadCount });
                    for (const message of unreadMessages) {
                        if (message.out || message.isRead) continue; // Giden veya okunmuş mesajları atla
    
                        console.log('Okunmamış mesaj bulundu:', message);
    
                        const isReplied = await checkIfReplied(message);
                        if (!isReplied) {
                            console.log('Mesaj daha önce yanıtlanmamış, ChatGPT yanıtı alınıyor...');
                            const response = await getChatGPTResponse(message);
                            if (response) {
                                console.log('ChatGPT yanıtı alındı, mesaj gönderiliyor...');
                                await client.sendMessage(peer, { message: response });
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('checkUnreadMessages sırasında hata oluştu:', error);
        }
    }
    

    setInterval(async () => {
        if (isInitialCheckDone) {
            for (const client of Object.values(clients)) {
                await checkUnreadMessages(client);
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

        let text = message.message;
        let imageUrl = null;
        let caption = null;
        console.log('Mesaj içeriği:', message);

        if (message.media) {
            console.log('Mesajda medya var.');
            console.log('Mesaj türü:', message.media.className);
            if (message.media.className === 'MessageMediaPhoto') {
                console.log('Mesaj türü: image.');
                const photoBuffer = await client.downloadMedia(message.media, { workers: 1 });
                const filePath = await saveImageToFile(photoBuffer, message.id, message.date);
                console.log(`Resim dosyası: ${filePath}`);
                if (!filePath) {
                    console.error('Resim dosyası kaydedilemedi.');
                    return null;
                }
                imageUrl = filePath;
                caption = message.message;
            } else if (message.media.className === 'MessageMediaDocument' && message.media.document.mimeType === 'audio/ogg') {
                console.log('Mesaj türü: ptt (voice message).');
                const audioBuffer = await client.downloadMedia(message.media, { workers: 1 });
                text = await transcribeAudio(audioBuffer);
                console.log(`Sesli mesaj metne dönüştürüldü: ${text}`);
            } else {
                console.log(`Mesaj türü: ${message.media.className}. Sesli mesaj veya resim değil.`);
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

    app.post('/send-code', async (req, res) => {
        const { userId, apiId, apiHash, phoneNumber } = req.body;

        if (!userId || !apiId || !apiHash || !phoneNumber) {
            return res.status(400).json({ error: 'All fields are required.' });
        }

        try {
            const client = new TelegramClient(new StringSession(''), Number(apiId), apiHash, { connectionRetries: 5 });

            await client.start({
                phoneNumber: () => phoneNumber,
                phoneCode: async () => {
                    // Doğrulama kodunu bekleyin
                    return new Promise((resolve) => {
                        clients[userId] = { client, resolve };
                    });
                },
                onError: (err) => console.log(err),
            });

            res.json({ status: 'code_sent' });
        } catch (error) {
            console.error('Error sending code:', error);
            res.status(500).json({ error: 'Failed to send code.' });
        }
    });

    app.post('/verify-code', async (req, res) => {
        const { userId, phoneCode, password } = req.body;

        if (!userId || !phoneCode) {
            return res.status(400).json({ error: 'User ID and phone code are required.' });
        }

        const clientData = clients[userId];
        if (!clientData) {
            return res.status(400).json({ error: 'User not found or code not sent.' });
        }

        try {
            clientData.resolve(phoneCode);
            // Password doğrulama işlemi olmadan devam ediyoruz
            fs.writeFileSync(path.join(SESSION_DIR, `${userId}.session`), clientData.client.session.save());
            clients[userId] = clientData.client;

            res.json({ status: 'connected' });
        } catch (error) {
            console.error('Error verifying code:', error);
            res.status(500).json({ error: 'Failed to verify code.' });
        }
    });

    
    app.get('/contacts', async (req, res) => {
      const { userId } = req.query;
  
      if (!clients[userId]) {
          return res.status(400).json({ error: 'User not registered.' });
      }
  
      try {
          const client = clients[userId];
  
          // Tüm diyalogları al
          const dialogs = await client.getDialogs({ limit: 100 });
  
          const allUsers = [];
          const seenUserIds = new Set();
  
          for (const dialog of dialogs) {
              const entity = dialog.entity;
  
              // Sadece kullanıcıları işleyin (grupları veya kanalları değil)
              if (entity.className === 'User' && !seenUserIds.has(entity.id)) {
                  allUsers.push(entity);
                  seenUserIds.add(entity.id);
              }
          }
          const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
          // Kullanıcıları rehbere ekle
          for (const user of allUsers) {
            if (!user.contact) {
                // firstName ve lastName kontrolü
                if (!user.firstName || user.firstName.trim() === '') {
                    console.log(`Kullanıcı ${user.id} eksik isim bilgisine sahip, atlanıyor.`);
                    continue;
                }
        
                try {
                    await client.invoke(
                        new Api.contacts.AddContact({
                            id: user.id,
                            firstName: user.firstName,
                            lastName: user.lastName || '',
                            phone: user.phone || '',
                            addPhonePrivacyException: false,
                        })
                    );
                    console.log(`${user.username || user.firstName} rehbere eklendi.`);
                    await delay(1000);
                  } catch (error) {
                    if (error.code === 420) {
                        // FloodWaitError durumunda belirtilen süre kadar bekleyin
                        const waitTime = (error.seconds + 1) * 1000;
                        console.log(`Flood limitine ulaşıldı. ${waitTime / 1000} saniye bekleniyor...`);
                        await delay(waitTime);
                    } else {
                        console.error(`${user.username || user.firstName} eklenirken hata oluştu:`, error);
                    }
                }
            }
        }
  
          // Rehberdeki tüm kişileri al
          const contactsResult = await client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) }));
          const contacts = (contactsResult.users || []).map(user => ({
              id: user.id.toString(),
              isContact: true,
              username: user.username || 'YOK',
              phone: user.phone || 'GİZLİ',
              name: [user.firstName, user.lastName].filter(Boolean).join(' '),
          }));
  
          res.json({ contacts });
      } catch (error) {
          console.error('Error fetching contacts:', error);
          res.status(500).json({
              error: 'Failed to fetch contacts.',
              details: error.message || 'Unknown error',
          });
      }
  });
  
  
  
    
  app.get('/messages/:chatId', async (req, res) => {
    const { userId } = req.query;
    const { chatId } = req.params;

    if (!clients[userId]) {
        return res.status(400).json({ error: 'User not registered.' });
    }

    const allMessages = [];
    let offsetId = 0;
    const limit = 100; // Telegram API'nin desteklediği maksimum limit

    try {
        const peer = new Api.InputPeerUser({ userId: parseInt(chatId) });

        while (true) {
            const result = await clients[userId].invoke(new Api.messages.GetHistory({
                peer,
                limit,
                addOffset: offsetId,
            }));

            const messages = await Promise.all(result.messages.map(async (message) => {
                const formattedMessage = {
                    id: message.id,
                    date: message.date,
                    from: message.fromId ? message.fromId.userId : null,
                    text: message.message || '',
                    media: null,
                };

                // Medya mesajlarını kontrol et ve işle
                if (message.media) {
                    if (message.media.photo) {
                        // Fotoğraf mesajı
                        const photoBuffer = await clients[userId].downloadMedia(message.media, { workers: 1 });
                        formattedMessage.media = {
                            type: 'photo',
                            url: `data:image/jpeg;base64,${photoBuffer.toString('base64')}`,
                        };
                    } else if (message.media.document && message.media.document.mimeType === 'video/mp4') {
                        // Video mesajı
                        const videoBuffer = await clients[userId].downloadMedia(message.media, { workers: 1 });
                        formattedMessage.media = {
                            type: 'video',
                            url: `data:video/mp4;base64,${videoBuffer.toString('base64')}`,
                            mimeType: message.media.document.mimeType,
                        };
                    } else if (message.media.document) {
                        // Belge mesajı
                        const documentBuffer = await clients[userId].downloadMedia(message.media, { workers: 1 });
                        formattedMessage.media = {
                            type: 'document',
                            url: `data:application/octet-stream;base64,${documentBuffer.toString('base64')}`,
                            mimeType: message.media.document.mimeType,
                        };
                    }
                }

                return formattedMessage;
            }));

            allMessages.push(...messages);

            // Eğer mesajlar tükendiyse döngüden çık
            if (result.messages.length < limit) break;

            // Offset'i güncelle
            offsetId = result.messages[result.messages.length - 1].id;
        }

        res.json({ messages: allMessages });
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: 'Failed to fetch messages.' });
    }
});
    
    

    wss.on('connection', (ws) => {
        console.log('New WebSocket connection established.');
    });
};

module.exports.clients = clients;