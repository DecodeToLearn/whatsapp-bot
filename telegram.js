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
            // Tüm kontakları alın
            const result = await clients[userId].invoke(new Api.contacts.GetContacts({
                hash: 0
            }));
    
            // Tüm kullanıcı bilgilerini topla
            const contacts = result.users.map(user => ({
                id: user.id,
                isContact: user.contact, // Kayıtlı olup olmadığını kontrol eder
                username: user.username || null,
                phone: user.phone || null,
                name: [user.firstName, user.lastName].filter(Boolean).join(' ')
            }));
    
            res.json({ contacts });
        } catch (error) {
            console.error('Error fetching contacts:', error);
            res.status(500).json({ error: 'Failed to fetch contacts.' });
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
                    addOffset: offsetId
                }));
    
                // Gelen mesajları topla
                const messages = result.messages.map(message => ({
                    id: message.id,
                    from: message.fromId ? message.fromId.userId || message.fromId.channelId || message.fromId.chatId : null,
                    body: message.message || '',
                    media: message.media && message.media.document ? {
                        url: message.media.document.url || null,
                        mimetype: message.media.document.mimeType || null
                    } : null
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