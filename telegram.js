const { TelegramClient } = require('telegram');
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

        const client = new TelegramClient(stringSession, apiId, apiHash, {
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

    app.post('/register', async (req, res) => {
        const { userId, apiId, apiHash, appTitle, shortName } = req.body;

        if (!userId || !apiId || !apiHash || !appTitle || !shortName) {
            return res.status(400).json({ error: 'All fields are required.' });
        }

        if (clients[userId]) {
            return res.json({ status: 'already_registered' });
        }

        try {
            await createClient(userId, apiId, apiHash, appTitle, shortName);
            res.json({ status: 'registered' });
        } catch (error) {
            console.error('Error creating Telegram client:', error);
            res.status(500).json({ error: 'Failed to register user.' });
        }
    });

    app.post('/send-code', async (req, res) => {
        const { userId, apiId, apiHash, phoneNumber } = req.body;

        if (!userId || !apiId || !apiHash || !phoneNumber) {
            return res.status(400).json({ error: 'All fields are required.' });
        }

        try {
            const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

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
            if (password) {
                await clientData.client.checkPassword(password);
            }

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
            const contacts = await clients[userId].getContacts();
            res.json({ contacts });
        } catch (error) {
            console.error('Error fetching contacts:', error);
            res.status(500).json({ error: 'Failed to fetch contacts.' });
        }
    });

    app.get('/messages/:chatId', async (req, res) => {
        const { userId } = req.query;
        const { chatId } = req.params;
        const limit = parseInt(req.query.limit, 10) || 20;

        if (!clients[userId]) {
            return res.status(400).json({ error: 'User not registered.' });
        }

        try {
            const messages = await clients[userId].getMessages(chatId, { limit });
            res.json({ messages });
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