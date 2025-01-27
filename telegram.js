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
  
      // 1. Kullanıcı Kontrolü
      if (!clients[userId]) {
          return res.status(400).json({ error: 'Kullanıcı kayıtlı değil.' });
      }
  
      try {
          const client = clients[userId];
  
          // 2. Oturum Açık mı Kontrolü (Telethon mantığı)
          if (!(await client.isUserAuthorized())) {
              throw new Error('Kullanıcı oturumu geçersiz.');
          }
  
          // 3. Kayıtlı Kontakları Çek
          const contactsResult = await client.invoke(
              new Api.contacts.GetContacts({ hash: BigInt(0) }) // Telegram hash için BigInt bekler
          );
  
          // 4. Kontakları Formatla
          const contacts = (contactsResult.users || []).map(user => ({
              id: user.id.toString(),
              isContact: true,
              username: user.username || "YOK",
              phone: user.phone || "GİZLİ",
              name: [user.firstName, user.lastName].filter(Boolean).join(' '),
          }));
  
          // 5. Son Diyalogları Çek (Sadece Bireysel Sohbetler)
          const dialogsResult = await client.invoke(
              new Api.messages.GetDialogs({
                  limit: 100,
                  excludePinned: true,
                  folderId: 0
              })
          );
  
          // 6. Diyaloglardan Kullanıcıları Çıkar
          const recentUsers = [];
          const seenUserIds = new Set();
  
          dialogsResult.dialogs.forEach(dialog => {
            const peer = dialog.dialog.peer;
            
            // Sadece bireysel kullanıcı diyaloglarını al
            if (peer instanceof Api.PeerUser) {
              const user = dialogsResult.users.find(u => 
                u.id.toString() === peer.userId.toString()
              );
              
              // Kullanıcı tanımlıysa ekle
              if (user && !seenUserIds.has(user.id)) {
                recentUsers.push(user);
                seenUserIds.add(user.id);
              }
            } else {
              console.warn('Undefined peer.userId for dialog:', dialog);
            }
          });
  
          // 7. Son İletişimleri Formatla
          const recentContacts = recentUsers.map(user => ({
            id: user.id.toString(),
            isContact: user.contact || false,
            username: user.username || "YOK",
            phone: user.phone || "GİZLİ",
            name: [user.firstName, user.lastName].filter(Boolean).join(' '),
          }));
  
          // 8. Tüm Listeyi Birleştir ve Tekilleştir
          const allContacts = [...contacts, ...recentContacts];
          const uniqueContacts = allContacts.filter(
            (contact, index, self) =>
              index === self.findIndex(c => c.id === contact.id)
          );
  
          res.json({ contacts: uniqueContacts });
  
      } catch (error) {
          console.error('Hata Detayı:', error);
          res.status(500).json({ 
            error: 'Kontaklar alınamadı.',
            details: error.message 
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