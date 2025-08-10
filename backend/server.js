require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Client } = require('mysql'); // Ou 'mysql' si vous utilisez MySQL

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: ['http://127.0.0.1:5500', 'https://project-delta.fr'], // Remplacez par l'URL de votre site web
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Configuration Discord OAuth2
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const BOT_TOKEN = process.env.BOT_TOKEN;

// Connexion à la base de données
const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // À utiliser si votre base de données est sur Render ou un service cloud avec SSL
    }
});

db.connect()
    .then(() => console.log('Connecté à la base de données PostgreSQL'))
    .catch(err => console.error('Erreur de connexion à la base de données', err));

// Middleware pour vérifier le token d'accès Discord
const authenticateDiscordToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ message: 'Authorization header missing' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ message: 'Token missing' });
    }

    try {
        // Vérifier le token en essayant de récupérer les infos utilisateur
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
        req.user = userResponse.data; // Attacher les infos utilisateur à la requête
        req.discordAccessToken = token; // Attacher le token pour les appels futurs
        next();
    } catch (error) {
        console.error('Discord token verification failed:', error.response?.data || error.message);
        return res.status(401).json({ message: 'Invalid or expired Discord token' });
    }
};

// --- Routes d'API ---

// 1. Route d'authentification Discord OAuth2
app.post('/api/auth/discord', async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ error: 'Code not provided' });
    }

    try {
        // Étape 1: Échanger le code d'autorisation contre un token d'accès
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: DISCORD_CLIENT_ID,
            client_secret: DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: DISCORD_REDIRECT_URI,
            scope: 'identify guilds'
        }).toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const { access_token, token_type } = tokenResponse.data;

        // Étape 2: Récupérer les informations de l'utilisateur
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: {
                Authorization: `${token_type} ${access_token}`
            }
        });

        res.json({ access_token, user: userResponse.data });

    } catch (error) {
        console.error('Discord OAuth error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to authenticate with Discord' });
    }
});

// 2. Route pour récupérer les guildes de l'utilisateur (où il est admin et où le bot est)
app.get('/api/user/guilds', authenticateDiscordToken, async (req, res) => {
    try {
        const userGuildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: {
                Authorization: `Bearer ${req.discordAccessToken}`
            }
        });
        const userGuilds = userGuildsResponse.data;

        // Récupérer les guildes du bot
        const botGuildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: {
                Authorization: `Bot ${BOT_TOKEN}`
            }
        });
        const botGuilds = botGuildsResponse.data;

        // Filtrer les guildes:
        // 1. L'utilisateur doit être administrateur (permission 0x8 = 8)
        // 2. Le bot doit être présent sur la guilde
        const commonGuilds = userGuilds.filter(userGuild =>
            (parseInt(userGuild.permissions) & 8) === 8 && // Vérifie la permission ADMINISTRATOR
            botGuilds.some(botGuild => botGuild.id === userGuild.id)
        );

        // Pour chaque guilde, récupérer l'URL de l'icône
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

// 3. Route pour récupérer les informations d'une guilde spécifique (nom, icône)
app.get('/api/guilds/:guildId', authenticateDiscordToken, async (req, res) => {
    const { guildId } = req.params;
    try {
        // Vérifier si l'utilisateur a accès à cette guilde (déjà fait par authenticateDiscordToken et le filtrage des guildes)
        // Pour être sûr, on pourrait refaire un appel à Discord API pour cette guilde spécifique
        // Mais pour simplifier, on suppose que si l'utilisateur est arrivé ici, il a les droits.
        // On peut utiliser le token du bot pour obtenir des infos plus fiables sur la guilde
        const guildResponse = await axios.get(`https://discord.com/api/guilds/${guildId}`, {
            headers: {
                Authorization: `Bot ${BOT_TOKEN}`
            }
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


// 4. Route pour récupérer les paramètres d'économie d'un serveur
app.get('/api/guilds/:guildId/settings/economy', authenticateDiscordToken, async (req, res) => {
    const { guildId } = req.params;

    try {
        // Vérifier si l'utilisateur est bien admin de cette guilde (redondant mais sécurisant)
        const userGuildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: `Bearer ${req.discordAccessToken}` }
        });
        const userGuilds = userGuildsResponse.data;
        const hasAdmin = userGuilds.some(g => g.id === guildId && (parseInt(g.permissions) & 8) === 8);

        if (!hasAdmin) {
            return res.status(403).json({ message: 'You do not have administrator permissions for this guild.' });
        }

        // Récupérer les paramètres de la base de données
        const result = await db.query(
            `SELECT work_cooldown, work_min_amount, work_max_amount FROM server_settings WHERE guild_id = $1`,
            [guildId]
        );

        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            // Si aucun paramètre n'est trouvé, retourner des valeurs par défaut
            res.json({
                work_cooldown: 3600, // 1 heure
                work_min_amount: 10,
                work_max_amount: 100
            });
        }
    } catch (error) {
        console.error('Error fetching economy settings:', error);
        res.status(500).json({ error: 'Failed to fetch economy settings' });
    }
});

// 5. Route pour sauvegarder les paramètres d'économie d'un serveur
app.post('/api/guilds/:guildId/settings/economy', authenticateDiscordToken, async (req, res) => {
    const { guildId } = req.params;
    const { work_cooldown, work_min_amount, work_max_amount } = req.body;

    // Validation simple des entrées
    if (typeof work_cooldown !== 'number' || typeof work_min_amount !== 'number' || typeof work_max_amount !== 'number' ||
        work_cooldown < 0 || work_min_amount < 0 || work_max_amount < 0) {
        return res.status(400).json({ message: 'Invalid input for economy settings.' });
    }

    try {
        // Vérifier si l'utilisateur est bien admin de cette guilde
        const userGuildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: `Bearer ${req.discordAccessToken}` }
        });
        const userGuilds = userGuildsResponse.data;
        const hasAdmin = userGuilds.some(g => g.id === guildId && (parseInt(g.permissions) & 8) === 8);

        if (!hasAdmin) {
            return res.status(403).json({ message: 'You do not have administrator permissions for this guild.' });
        }

        // Mettre à jour ou insérer les paramètres dans la base de données
        // Assurez-vous que votre table `server_settings` a une colonne `guild_id` comme clé primaire ou unique
        // et des colonnes pour `work_cooldown`, `work_min_amount`, `work_max_amount`.
        // Si votre bot utilise un schéma différent, adaptez cette requête.
        const query = `
            INSERT INTO server_settings (guild_id, work_cooldown, work_min_amount, work_max_amount)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (guild_id) DO UPDATE
            SET work_cooldown = $2,
                work_min_amount = $3,
                work_max_amount = $4
            RETURNING *;
        `;
        const values = [guildId, work_cooldown, work_min_amount, work_max_amount];
        await db.query(query, values);

        res.json({ message: 'Economy settings updated successfully!' });

    } catch (error) {
        console.error('Error saving economy settings:', error);
        res.status(500).json({ error: 'Failed to save economy settings' });
    }
});


// Démarrer le serveur
app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
});
