require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: ['http://127.0.0.1:5500', 'https://project-delta.fr'],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Config Discord
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const BOT_TOKEN = process.env.BOT_TOKEN;

// Connexion MySQL (pool)
let db;
(async () => {
    try {
        db = await mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            port: 3306,
            connectionLimit: 5
        });
        console.log('✅ Connecté à la base MySQL');
    } catch (err) {
        console.error('❌ Erreur connexion MySQL:', err);
    }
})();

// Middleware pour vérifier le token Discord
const authenticateDiscordToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ message: 'Authorization header missing' });

    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Token missing' });

    try {
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${token}` }
        });
        req.user = userResponse.data;
        req.discordAccessToken = token;
        next();
    } catch (error) {
        console.error('Discord token verification failed:', error.response?.data || error.message);
        return res.status(401).json({ message: 'Invalid or expired Discord token' });
    }
};

// --- ROUTES ---

// Auth Discord OAuth2
app.post('/api/auth/discord', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code not provided' });

    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: DISCORD_CLIENT_ID,
            client_secret: DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: DISCORD_REDIRECT_URI,
            scope: 'identify guilds'
        }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        const { access_token, token_type } = tokenResponse.data;

        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `${token_type} ${access_token}` }
        });

        res.json({ access_token, user: userResponse.data });
    } catch (error) {
        console.error('Discord OAuth error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to authenticate with Discord' });
    }
});

// Récupérer guilds communes
app.get('/api/user/guilds', authenticateDiscordToken, async (req, res) => {
    try {
        const userGuildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: `Bearer ${req.discordAccessToken}` }
        });
        const userGuilds = userGuildsResponse.data;

        const botGuildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });
        const botGuilds = botGuildsResponse.data;

        const commonGuilds = userGuilds.filter(userGuild =>
            (parseInt(userGuild.permissions) & 8) === 8 &&
            botGuilds.some(botGuild => botGuild.id === userGuild.id)
        );

        const guildsWithIcons = commonGuilds.map(guild => ({
            id: guild.id,
            name: guild.name,
            icon_url: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png` : null
        }));

        res.json(guildsWithIcons);
    } catch (error) {
        console.error('Error fetching user guilds:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to fetch user guilds' });
    }
});

// Infos d'une guilde
app.get('/api/guilds/:guildId', authenticateDiscordToken, async (req, res) => {
    const { guildId } = req.params;
    try {
        const guildResponse = await axios.get(`https://discord.com/api/guilds/${guildId}`, {
            headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });

        const guildData = guildResponse.data;
        res.json({
            id: guildData.id,
            name: guildData.name,
            icon_url: guildData.icon ? `https://cdn.discordapp.com/icons/${guildData.id}/${guildData.icon}.png` : null
        });
    } catch (error) {
        console.error(`Error fetching guild ${guildId} info:`, error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to fetch guild info' });
    }
});

// Récupérer paramètres économie
app.get('/api/guilds/:guildId/settings/economy', authenticateDiscordToken, async (req, res) => {
    const { guildId } = req.params;
    try {
        const [rows] = await db.query(
            `SELECT work_cooldown, work_min_amount, work_max_amount 
             FROM server_settings WHERE guild_id = ?`,
            [guildId]
        );

        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.json({ work_cooldown: 3600, work_min_amount: 10, work_max_amount: 100 });
        }
    } catch (error) {
        console.error('Error fetching economy settings:', error);
        res.status(500).json({ error: 'Failed to fetch economy settings' });
    }
});

// Sauvegarder paramètres économie
app.post('/api/guilds/:guildId/settings/economy', authenticateDiscordToken, async (req, res) => {
    const { guildId } = req.params;
    const { work_cooldown, work_min_amount, work_max_amount } = req.body;

    if ([work_cooldown, work_min_amount, work_max_amount].some(v => typeof v !== 'number' || v < 0)) {
        return res.status(400).json({ message: 'Invalid input for economy settings.' });
    }

    try {
        await db.query(
            `INSERT INTO server_settings (guild_id, work_cooldown, work_min_amount, work_max_amount)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                work_cooldown = VALUES(work_cooldown),
                work_min_amount = VALUES(work_min_amount),
                work_max_amount = VALUES(work_max_amount)`,
            [guildId, work_cooldown, work_min_amount, work_max_amount]
        );

        res.json({ message: 'Economy settings updated successfully!' });
    } catch (error) {
        console.error('Error saving economy settings:', error);
        res.status(500).json({ error: 'Failed to save economy settings' });
    }
});

// Start
app.listen(PORT, () => {
    console.log(`🚀 Backend server running on port ${PORT}`);
});
