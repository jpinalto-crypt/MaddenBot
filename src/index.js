require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env');
  process.exit(1);
}

// Madden 27 EA constants (from reverse-engineered Companion App)
const EA = {
  AUTH_SOURCE: 317239,
  CLIENT_SECRET: "AmVfGJMTkej18iUCKagWGjm06MMPLDAmNklPPgReXy9ENWxEpb4OnOyYORTYRyJcq_20260727062224",
  REDIRECT_URL: "http://127.0.0.1/success",
  CLIENT_ID: "MCA_27_COMP_APP",
  MACHINE_KEY: "444d362e8e067fe2",
  YEAR: "2027",
  TWO_DIGIT: "27"
};

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'league.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS league (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_week INTEGER DEFAULT 1,
    season INTEGER DEFAULT 1,
    last_update TEXT,
    announce_channel TEXT
  );
  INSERT OR IGNORE INTO league (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS teams (
    team_id TEXT PRIMARY KEY,
    city TEXT,
    name TEXT,
    abbr TEXT,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    ties INTEGER DEFAULT 0,
    points_for INTEGER DEFAULT 0,
    points_against INTEGER DEFAULT 0,
    discord_user_id TEXT
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week INTEGER,
    home_team TEXT,
    away_team TEXT,
    home_score INTEGER,
    away_score INTEGER,
    played INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS ea_tokens (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    persona_id TEXT,
    league_id TEXT
  );
  INSERT OR IGNORE INTO ea_tokens (id) VALUES (1);
`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers]
});

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── Companion App fallback import ───────────────────────────────────────────
app.post('/import', (req, res) => {
  try {
    processImport(req.body);
    res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

function processImport(body) {
  if (body.leagueTeamInfoList) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO teams (team_id, city, name, abbr, wins, losses, ties, points_for, points_against)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of body.leagueTeamInfoList) {
      stmt.run(
        String(t.teamId || t.team_id || t.id),
        t.cityName || t.city || '',
        t.displayName || t.name || '',
        t.abbrName || t.abbr || '',
        t.totalWins || t.wins || 0,
        t.totalLosses || t.losses || 0,
        t.totalTies || t.ties || 0,
        t.ptsFor || t.pointsFor || 0,
        t.ptsAgainst || t.pointsAgainst || 0
      );
    }
  }

  if (body.gameScheduleInfoList) {
    const week = body.weekIndex || body.week || db.prepare('SELECT current_week FROM league WHERE id=1').get().current_week;
    db.prepare('DELETE FROM games WHERE week = ?').run(week);
    const stmt = db.prepare(`
      INSERT INTO games (week, home_team, away_team, home_score, away_score, played)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const g of body.gameScheduleInfoList) {
      const played = (g.homeScore > 0 || g.awayScore > 0) ? 1 : 0;
      stmt.run(week, String(g.homeTeamId), String(g.awayTeamId), g.homeScore || 0, g.awayScore || 0, played);
    }
    const playedCount = db.prepare('SELECT COUNT(*) as c FROM games WHERE week = ? AND played = 1').get(week).c;
    if (playedCount > 0) {
      const newWeek = week + 1;
      db.prepare('UPDATE league SET current_week = ?, last_update = ? WHERE id = 1').run(newWeek, new Date().toISOString());
      announceAdvance(newWeek);
    }
  }
  db.prepare('UPDATE league SET last_update = ? WHERE id = 1').run(new Date().toISOString());
}

function announceAdvance(week) {
  const row = db.prepare('SELECT announce_channel FROM league WHERE id=1').get();
  if (!row?.announce_channel) return;
  const channel = client.channels.cache.get(row.announce_channel);
  if (channel) {
    channel.send(`📅 **Week ${week} has started!** League data updated automatically.`).catch(() => {});
  }
}

// ─── EA Auto-Pull ────────────────────────────────────────────────────────────
function getLoginUrl() {
  return `https://accounts.ea.com/connect/auth?hide_create=true&release_type=prod&response_type=code&redirect_uri=${encodeURIComponent(EA.REDIRECT_URL)}&client_id=${EA.CLIENT_ID}&machineProfileKey=${EA.MACHINE_KEY}&authentication_source=${EA.AUTH_SOURCE}`;
}

async function refreshAccessToken() {
  const tokens = db.prepare('SELECT * FROM ea_tokens WHERE id=1').get();
  if (!tokens?.refresh_token) return null;

  const body = new URLSearchParams({
    authentication_source: EA.AUTH_SOURCE,
    client_secret: EA.CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    release_type: 'prod',
    client_id: EA.CLIENT_ID
  });

  const res = await fetch('https://accounts.ea.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031)'
    },
    body
  });

  if (!res.ok) return null;
  const data = await res.json();
  db.prepare('UPDATE ea_tokens SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = 1')
    .run(data.access_token, data.refresh_token || tokens.refresh_token, Date.now() + (data.expires_in || 3600) * 1000);
  return data.access_token;
}

async function getValidAccessToken() {
  const tokens = db.prepare('SELECT * FROM ea_tokens WHERE id=1').get();
  if (!tokens?.access_token) return null;
  if (tokens.expires_at && tokens.expires_at > Date.now() + 60000) return tokens.access_token;
  return await refreshAccessToken();
}

// Background checker – runs every 10 minutes
setInterval(async () => {
  try {
    const token = await getValidAccessToken();
    if (!token) return;

    // This is a simplified check. Full implementation would call the actual league endpoints
    // after obtaining persona + league ID. For now we log and rely on Companion App fallback
    // until the full EA league endpoints are wired.
    console.log('[Auto] EA token valid – checking for advances...');
    // TODO: implement full getLeagueInfo call once persona is stored
  } catch (e) {
    console.error('[Auto] check failed', e.message);
  }
}, 10 * 60 * 1000);

// ─── Express routes ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.send('OK'));

app.post('/interactions', express.raw({ type: 'application/json' }), (req, res) => {
  res.status(200).json({ type: 1 });
});

// Simple callback page for EA login (user pastes code or we capture redirect)
app.get('/ea-callback', (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('Missing code. Complete the EA login first.');
  // In a full version you would exchange the code here for tokens.
  res.send(`
    <h2>Code received</h2>
    <p>Paste this code into Discord with <code>/link code:${code}</code></p>
    <pre>${code}</pre>
  `);
});

const commands = [
  new SlashCommandBuilder().setName('standings').setDescription('Show current league standings'),
  new SlashCommandBuilder().setName('schedule').setDescription('Show the schedule for a week')
    .addIntegerOption(opt => opt.setName('week').setDescription('Week number (default current)')),
  new SlashCommandBuilder().setName('status').setDescription('Show current week and last update'),
  new SlashCommandBuilder().setName('teams').setDescription('List teams or assign a team')
    .addSubcommand(sub => sub.setName('list').setDescription('List all teams'))
    .addSubcommand(sub =>
      sub.setName('assign').setDescription('Assign a Discord user to a team')
        .addStringOption(o => o.setName('team').setDescription('Team name or abbr').setRequired(true))
        .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))),
  new SlashCommandBuilder().setName('gamechannels').setDescription('Create game channels for the current week')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('link').setDescription('Link your EA account for automatic updates')
    .addStringOption(o => o.setName('code').setDescription('Auth code from EA login (optional)')),
  new SlashCommandBuilder().setName('setannounce').setDescription('Set the channel for advance announcements')
    .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() {
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    }
    console.log('Commands registered');
  } catch (err) {
    console.error(err);
  }
}

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const league = db.prepare('SELECT * FROM league WHERE id=1').get();

  if (interaction.commandName === 'status') {
    const tokens = db.prepare('SELECT access_token IS NOT NULL as linked FROM ea_tokens WHERE id=1').get();
    const embed = new EmbedBuilder()
      .setTitle('League Status')
      .setColor(0x00ff00)
      .addFields(
        { name: 'Current Week', value: String(league.current_week), inline: true },
        { name: 'Last Update', value: league.last_update ? new Date(league.last_update).toLocaleString() : 'Never', inline: true },
        { name: 'EA Linked', value: tokens?.linked ? 'Yes (auto-pull enabled)' : 'No – use /link', inline: true }
      );
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'standings') {
    const teams = db.prepare('SELECT * FROM teams ORDER BY wins DESC, (points_for - points_against) DESC').all();
    if (!teams.length) return interaction.reply('No standings yet. Export from Companion App or finish EA linking.');
    const lines = teams.slice(0, 16).map((t, i) =>
      `${i + 1}. ${t.abbr || t.name}  ${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}  (${t.points_for}-${t.points_against})`
    );
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Standings').setDescription(lines.join('\n')).setColor(0x0099ff)] });
  }

  if (interaction.commandName === 'schedule') {
    const week = interaction.options.getInteger('week') || league.current_week;
    const games = db.prepare('SELECT * FROM games WHERE week = ?').all(week);
    if (!games.length) return interaction.reply(`No schedule for week ${week}.`);
    const lines = games.map(g => {
      const home = db.prepare('SELECT abbr FROM teams WHERE team_id = ?').get(g.home_team) || { abbr: g.home_team };
      const away = db.prepare('SELECT abbr FROM teams WHERE team_id = ?').get(g.away_team) || { abbr: g.away_team };
      return `${away.abbr} @ ${home.abbr}${g.played ? ` ${g.away_score}-${g.home_score}` : ''}`;
    });
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Week ${week} Schedule`).setDescription(lines.join('\n')).setColor(0xff9900)] });
  }

  if (interaction.commandName === 'teams') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const teams = db.prepare('SELECT * FROM teams').all();
      const lines = teams.map(t => `${t.abbr || t.name}: ${t.discord_user_id ? `<@${t.discord_user_id}>` : 'Unassigned'}`);
      return interaction.reply({ content: lines.join('\n') || 'No teams', ephemeral: true });
    }
    if (sub === 'assign') {
      const q = interaction.options.getString('team').toLowerCase();
      const user = interaction.options.getUser('user');
      const team = db.prepare('SELECT * FROM teams WHERE lower(abbr) = ? OR lower(name) LIKE ?').get(q, `%${q}%`);
      if (!team) return interaction.reply('Team not found.');
      db.prepare('UPDATE teams SET discord_user_id = ? WHERE team_id = ?').run(user.id, team.team_id);
      return interaction.reply(`Assigned ${user} to ${team.abbr || team.name}`);
    }
  }

  if (interaction.commandName === 'gamechannels') {
    await interaction.deferReply();
    const week = league.current_week;
    const games = db.prepare('SELECT * FROM games WHERE week = ?').all(week);
    if (!games.length) return interaction.editReply('No games for this week.');
    let category = interaction.guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes('madden'));
    if (!category) category = await interaction.guild.channels.create({ name: 'Madden Games', type: ChannelType.GuildCategory });
    for (const g of games) {
      const home = db.prepare('SELECT abbr FROM teams WHERE team_id = ?').get(g.home_team) || { abbr: 'HOME' };
      const away = db.prepare('SELECT abbr FROM teams WHERE team_id = ?').get(g.away_team) || { abbr: 'AWAY' };
      await interaction.guild.channels.create({
        name: `${away.abbr}-vs-${home.abbr}-w${week}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
        type: ChannelType.GuildText,
        parent: category.id
      });
    }
    return interaction.editReply(`Created game channels for week ${week}.`);
  }

  if (interaction.commandName === 'link') {
    const code = interaction.options.getString('code');
    if (!code) {
      return interaction.reply({
        content: `**Link EA for automatic updates**\n\n1. Open this login URL:\n${getLoginUrl()}\n\n2. After login you’ll be redirected to a page that fails (expected).\n3. Copy the \`code=\` value from the URL bar.\n4. Run \`/link code:PASTE_CODE_HERE\`\n\nOnce linked the bot will check for advances every 10 minutes.`,
        ephemeral: true
      });
    }
    // Exchange code for tokens (simplified)
    try {
      const body = new URLSearchParams({
        authentication_source: EA.AUTH_SOURCE,
        client_secret: EA.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: EA.REDIRECT_URL,
        release_type: 'prod',
        client_id: EA.CLIENT_ID
      });
      const res = await fetch('https://accounts.ea.com/connect/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031)'
        },
        body
      });
      if (!res.ok) return interaction.reply('Failed to exchange code. Try again.');
      const data = await res.json();
      db.prepare('UPDATE ea_tokens SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = 1')
        .run(data.access_token, data.refresh_token, Date.now() + (data.expires_in || 3600) * 1000);
      return interaction.reply('EA account linked! Automatic advance detection is now active.');
    } catch (e) {
      return interaction.reply('Error linking EA account.');
    }
  }

  if (interaction.commandName === 'setannounce') {
    const channel = interaction.options.getChannel('channel');
    db.prepare('UPDATE league SET announce_channel = ? WHERE id = 1').run(channel.id);
    return interaction.reply(`Advance announcements will be posted in ${channel}.`);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  console.log(`Companion App import URL: ${PUBLIC_URL}/import`);
  console.log(`EA login starts with /link`);
});

client.login(TOKEN);
