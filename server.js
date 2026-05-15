require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
const PORT = 3000;

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Initialize Discord Bot for Role Syncing
const discordBot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
discordBot.login(process.env.DISCORD_BOT_TOKEN);

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'epic_rp_secret_key',
    resave: false,
    saveUninitialized: false
}));

// Discord OAuth2 Setup
passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: 'http://localhost:3000/auth/discord/callback',
    scope: ['identify']
}, async (accessToken, refreshToken, profile, done) => {
    let { data: user } = await supabase.from('users').select('*').eq('discord_id', profile.id).single();

    if (!user) {
        const { data: newUser } = await supabase.from('users').insert([{
            discord_id: profile.id,
            username: profile.username,
            is_admin: profile.id === '1090055441381343302' 
        }]).select().single();
        user = newUser;
    } else {
        await supabase.from('users').update({ username: profile.username }).eq('discord_id', profile.id);
    }

    profile.isAdmin = user ? user.is_admin : false;
    return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser(async (obj, done) => {
    const { data: user } = await supabase.from('users').select('*').eq('discord_id', obj.id).single();
    if (user) {
        obj.isAdmin = user.is_admin;
        obj.cooldownUntil = user.cooldown_until;
    }
    done(null, obj);
});

app.use(passport.initialize());
app.use(passport.session());

// Helper function for Discord Webhooks
async function sendDiscordWebhook(type, details, color = 3447003) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    const payload = {
        embeds: [{
            title: `🌐 System Log: ${type}`,
            description: details,
            color: color,
            timestamp: new Date(),
            footer: { text: "Basic RP Web Logs" }
        }]
    };

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (err) {
        console.error("Discord Webhook Error:", err);
    }
}

// Helper: Sync Role
async function syncDiscordRole(discordId) {
    try {
        const guild = await discordBot.guilds.fetch(process.env.DISCORD_GUILD_ID);
        const member = await guild.members.fetch(discordId);
        await member.roles.add(process.env.DISCORD_ROLE_ID);
        return true;
    } catch (err) {
        console.error("❌ Role Sync Error:", err.message);
        return false;
    }
}

// Middlewares
function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/auth/discord');
}

function checkAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user.isAdmin) return next();
    res.status(403).send("Access Denied");
}

// Routes
app.get('/', (req, res) => res.render('index', { user: req.user }));
app.get('/rules', (req, res) => res.render('rules', { user: req.user }));
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/apply'));
app.get('/logout', (req, res) => { req.logout(() => { res.redirect('/'); }); });

app.get('/apply', checkAuth, async (req, res) => {
    const { data: userApp } = await supabase.from('applications').select('*').eq('discord_id', req.user.id).maybeSingle();
    res.render('apply', { user: req.user, application: userApp });
});

app.post('/apply', checkAuth, async (req, res) => {
    if (req.user.cooldownUntil && new Date(req.user.cooldownUntil) > new Date()) {
        return res.send("You are still on cooldown.");
    }

    const { characterName, age, timezone, microphone, background, failRpDefinition, goals } = req.body;
    await supabase.from('applications').insert([{
        discord_id: req.user.id,
        username: req.user.username,
        character_name: characterName,
        age, timezone, microphone, background,
        fail_rp_definition: failRpDefinition,
        goals: goals || 'Not provided', 
        status: 'Pending'
    }]);

    await supabase.from('application_logs').insert([{
        type: 'Application Submitted',
        username: req.user.username,
        details: `New application submitted by ${req.user.username}`
    }]);

    sendDiscordWebhook('New Application', `**User:** ${req.user.username}\n**Character:** ${characterName}`, 3447003);
    res.redirect('/apply');
});

app.get('/admin', checkAdmin, async (req, res) => {
    const { data: applications } = await supabase.from('applications').select('*').order('submitted_at', { ascending: false });
    const { data: admins } = await supabase.from('users').select('*').eq('is_admin', true);
    const { data: logs } = await supabase.from('application_logs').select('*').order('created_at', { ascending: false }).limit(50);
    
    const formattedLogs = logs ? logs.map(l => ({
        type: l.type,
        username: l.username,
        timestamp: new Date(l.created_at).toLocaleString(),
        details: l.details
    })) : [];

    res.render('admin', { 
        user: req.user, 
        applications: applications || [], 
        applicationLogs: formattedLogs, 
        adminList: admins ? admins.map(a => a.discord_id) : [] 
    });
});

app.post('/admin/action', checkAdmin, async (req, res) => {
    const { appId, action, reason, cooldownDays } = req.body;
    const newStatus = action === 'accept' ? 'Accepted' : 'Rejected';
    
    // Fetch applicant data first
    const { data: appData } = await supabase.from('applications').select('*').eq('id', appId).single();

    if (action === 'accept') {
        await syncDiscordRole(appData.discord_id);
    } else if (action === 'reject' && cooldownDays > 0) {
        const cooldownDate = new Date();
        cooldownDate.setDate(cooldownDate.getDate() + parseInt(cooldownDays));
        await supabase.from('users').update({ cooldown_until: cooldownDate }).eq('discord_id', appData.discord_id);
    }

    // Update status and Denial Reason
    await supabase.from('applications').update({ 
        status: newStatus,
        denial_reason: action === 'reject' ? reason : null 
    }).eq('id', appId);
    
    await supabase.from('application_logs').insert([{
        type: 'Admin Action',
        username: req.user.username,
        details: `${action.toUpperCase()} app from ${appData.username}${action === 'reject' ? ' (Reason: ' + reason + ')' : ''}`
    }]);

    sendDiscordWebhook('Admin Decision', `**Admin:** ${req.user.username}\n**Result:** ${newStatus}\n**Target:** ${appData.username}\n**Reason:** ${reason || 'N/A'}`, action === 'accept' ? 3066993 : 15158332);
    res.redirect('/admin');
});

app.post('/admin/manage-permissions', checkAdmin, async (req, res) => {
    const { discordId, action } = req.body;
    await supabase.from('users').update({ is_admin: action === 'add' }).eq('discord_id', discordId);
    res.redirect('/admin');
});

app.get('/check-status', (req, res) => res.render('check-status', { user: req.user }));
app.post('/check-status', async (req, res) => {
    const { discordId } = req.body;
    const { data: application } = await supabase.from('applications').select('*').eq('discord_id', discordId).maybeSingle();
    if (!application) return res.render('check-status', { user: req.user, error: 'No application found.' });
    application.characterName = application.character_name;
    application.submittedAt = new Date(application.submitted_at).toLocaleString();
    res.render('check-status', { user: req.user, application });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
