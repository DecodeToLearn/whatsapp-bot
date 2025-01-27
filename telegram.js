const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');

const clients = {};
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
                            const photoPath = await clients[userId].downloadMedia(message.media, './media/');
                            formattedMessage.media = {
                                type: 'photo',
                                url: photoPath,
                            };
                        } else if (message.media.document) {
                            // Belge mesajı
                            const documentPath = await clients[userId].downloadMedia(message.media, './media/');
                            formattedMessage.media = {
                                type: 'document',
                                url: documentPath,
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