require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Pool } = require('pg');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`Health server on ${PORT}`));

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const DATABASE_URL = process.env.DATABASE_URL;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      coins INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      last_daily BIGINT DEFAULT 0,
      superbowls_alltime INTEGER DEFAULT 0,
      superbowls_current INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS shop (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE,
      price INTEGER,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory (
      user_id TEXT,
      item_name TEXT,
      quantity INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, item_name)
    );

    CREATE TABLE IF NOT EXISTS cooldowns (
      user_id TEXT PRIMARY KEY,
      plays INTEGER DEFAULT 0,
      window_start BIGINT DEFAULT 0
    );
  `);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM shop');
  if (rows[0].c === 0) {
    await pool.query(`
      INSERT INTO shop (name, price, description) VALUES
      ('Extra Trade', 500, 'One additional trade this season'),
      ('Dev Upgrade', 750, 'Upgrade a player development trait'),
      ('Age Reduction', 600, 'Reduce a player age by 1 year'),
      ('Contract Reduction', 400, 'Reduce a contract by 20%'),
      ('Theft', 300, 'Attempt to steal 1-200 coins from another player')
    `);
  }
  console.log('Database ready');
}

async function getUser(userId) {
  let { rows } = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
  if (!rows.length) {
    await pool.query('INSERT INTO users (user_id) VALUES ($1)', [userId]);
    ({ rows } = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]));
  }
  return rows[0];
}

async function addCoins(userId, amount) {
  await getUser(userId);
  await pool.query('UPDATE users SET coins = coins + $1 WHERE user_id = $2', [amount, userId]);
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function checkGameCooldown(userId) {
  const now = Date.now();
  let { rows } = await pool.query('SELECT * FROM cooldowns WHERE user_id = $1', [userId]);
  if (!rows.length) {
    await pool.query('INSERT INTO cooldowns (user_id, plays, window_start) VALUES ($1, 0, $2)', [userId, now]);
    rows = [{ plays: 0, window_start: now }];
  }
  let row = rows[0];
  if (now - Number(row.window_start) >= GAME_WINDOW) {
    await pool.query('UPDATE cooldowns SET plays = 0, window_start = $1 WHERE user_id = $2', [now, userId]);
    row.plays = 0;
    row.window_start = now;
  }
  if (row.plays >= GAME_PLAYS) {
    const left = Math.ceil((GAME_WINDOW - (now - Number(row.window_start))) / 60000);
    return { allowed: false, left };
  }
  return { allowed: true };
}

async function useGamePlay(userId) {
  await pool.query('UPDATE cooldowns SET plays = plays + 1 WHERE user_id = $1', [userId]);
}

async function resetCooldown(userId) {
  await pool.query(`
    INSERT INTO cooldowns (user_id, plays, window_start) VALUES ($1, 0, 0)
    ON CONFLICT (user_id) DO UPDATE SET plays = 0, window_start = 0
  `, [userId]);
}

const MAX_BET = 1000;
const MIN_BET = 10;
const DAILY_COOLDOWN = 24 * 60 * 60 * 1000;
const GAME_PLAYS = 3;
const GAME_WINDOW = 2 * 60 * 60 * 1000;
const pendingChallenges = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const commands = [
  new SlashCommandBuilder().setName('balance').setDescription('Check your coin balance and record'),
  new SlashCommandBuilder().setName('win').setDescription('Award a win (+100 coins) — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true)),
  new SlashCommandBuilder().setName('loss').setDescription('Award a loss (+50 coins) — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true)),
  new SlashCommandBuilder().setName('shop').setDescription('View the shop'),
  new SlashCommandBuilder().setName('buy').setDescription('Buy an item from the shop')
    .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true)),
  new SlashCommandBuilder().setName('inventory').setDescription('View your purchased items'),
  new SlashCommandBuilder().setName('shopadd').setDescription('Add or update a shop item — Admin only')
    .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true))
    .addIntegerOption(o => o.setName('price').setDescription('Price in coins').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Short description')),
  new SlashCommandBuilder().setName('shopprice').setDescription('Change the price of a shop item — Admin only')
    .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true))
    .addIntegerOption(o => o.setName('price').setDescription('New price').setRequired(true)),
  new SlashCommandBuilder().setName('shopremove').setDescription('Remove an item from the shop — Admin only')
    .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true)),
  new SlashCommandBuilder().setName('blackjack').setDescription('Play blackjack and bet coins')
    .addIntegerOption(o => o.setName('bet').setDescription('Amount to bet').setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET)),
  new SlashCommandBuilder().setName('coinflip').setDescription('Flip a coin and bet coins')
    .addIntegerOption(o => o.setName('bet').setDescription('Amount to bet').setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET))
    .addStringOption(o => o.setName('side').setDescription('heads or tails').setRequired(true)
      .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })),
  new SlashCommandBuilder().setName('dice').setDescription('Roll dice and bet coins')
    .addIntegerOption(o => o.setName('bet').setDescription('Amount to bet').setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET)),
  new SlashCommandBuilder().setName('slots').setDescription('Spin the slots')
    .addIntegerOption(o => o.setName('bet').setDescription('Amount to bet').setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET)),
  new SlashCommandBuilder().setName('challengedice').setDescription('Challenge someone to best-of-3 dice')
    .addUserOption(o => o.setName('user').setDescription('Opponent').setRequired(true))
    .addIntegerOption(o => o.setName('bet').setDescription('Amount each player bets').setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top coin holders'),
  new SlashCommandBuilder().setName('give').setDescription('Give coins to another player')
    .addUserOption(o => o.setName('user').setDescription('Recipient').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('daily').setDescription('Claim your daily coins (1-20)'),
  new SlashCommandBuilder().setName('stats').setDescription('View a player’s full stats')
    .addUserOption(o => o.setName('user').setDescription('Player')),
  new SlashCommandBuilder().setName('resetcooldown').setDescription('Reset a player’s game cooldown — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true)),
  new SlashCommandBuilder().setName('reset').setDescription('Reset a player’s coins and record — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true)),
  new SlashCommandBuilder().setName('award').setDescription('Manually give coins — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('fine').setDescription('Take coins from a player — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('addsuperbowl').setDescription('Add Super Bowl trophies to a user — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .addIntegerOption(o => o.setName('count').setDescription('Number of trophies (default 1)').setMinValue(1))
    .addBooleanOption(o => o.setName('current').setDescription('Also count for current Madden season? (default true)')),
  new SlashCommandBuilder().setName('removesuperbowl').setDescription('Remove Super Bowl trophies from a user — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .addIntegerOption(o => o.setName('count').setDescription('Number to remove (default 1)').setMinValue(1))
    .addBooleanOption(o => o.setName('current').setDescription('Also remove from current Madden season? (default true)')),
  new SlashCommandBuilder().setName('steal').setDescription('Use a Theft item to steal coins from someone')
    .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)),
  new SlashCommandBuilder().setName('use').setDescription('Use an item from your inventory')
    .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true)),
  new SlashCommandBuilder().setName('help').setDescription('List all commands')
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
  } catch (e) {
    console.error(e);
  }
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initDb();
  registerCommands();
});

function drawCard() {
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const suits = ['♠', '♥', '♦', '♣'];
  const rank = ranks[Math.floor(Math.random() * ranks.length)];
  const suit = suits[Math.floor(Math.random() * suits.length)];
  return { rank, suit, value: rank === 'A' ? 11 : ['J','Q','K'].includes(rank) ? 10 : parseInt(rank) };
}

function handValue(hand) {
  let total = hand.reduce((s, c) => s + c.value, 0);
  let aces = hand.filter(c => c.rank === 'A').length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const userId = interaction.user.id;
  const cmd = interaction.commandName;

  const adminCmds = ['win', 'loss', 'shopadd', 'shopprice', 'shopremove', 'reset', 'resetcooldown', 'award', 'fine', 'addsuperbowl', 'removesuperbowl'];
  if (adminCmds.includes(cmd) && !isAdmin(interaction)) {
    return interaction.reply({ content: 'You need Administrator permission to use this command.', ephemeral: true });
  }

  try {
    if (cmd === 'balance') {
      const u = await getUser(userId);
      const embed = new EmbedBuilder()
        .setTitle(`${interaction.user.username}'s Balance`)
        .setColor(0x00ff00)
        .addFields(
          { name: 'Coins', value: `${u.coins}`, inline: true },
          { name: 'Record', value: `${u.wins}W - ${u.losses}L`, inline: true }
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (cmd === 'win') {
      const target = interaction.options.getUser('user');
      await getUser(target.id);
      await pool.query('UPDATE users SET wins = wins + 1, coins = coins + 100 WHERE user_id = $1', [target.id]);
      const u = await getUser(target.id);
      return interaction.reply(`${target} recorded a **WIN** (+100 coins). New balance: ${u.coins}`);
    }

    if (cmd === 'loss') {
      const target = interaction.options.getUser('user');
      await getUser(target.id);
      await pool.query('UPDATE users SET losses = losses + 1, coins = coins + 50 WHERE user_id = $1', [target.id]);
      const u = await getUser(target.id);
      return interaction.reply(`${target} recorded a **LOSS** (+50 coins). New balance: ${u.coins}`);
    }

    if (cmd === 'shop') {
      const { rows } = await pool.query('SELECT * FROM shop ORDER BY price');
      if (!rows.length) return interaction.reply('Shop is empty.');
      const lines = rows.map(i => `**${i.name}** — ${i.price} coins\n${i.description || ''}`);
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle('League Shop').setDescription(lines.join('\n\n')).setColor(0xffaa00)] });
    }

    if (cmd === 'buy') {
      const itemName = interaction.options.getString('item');
      const { rows } = await pool.query('SELECT * FROM shop WHERE lower(name) = lower($1)', [itemName]);
      const item = rows[0];
      if (!item) return interaction.reply('Item not found. Check /shop');
      const u = await getUser(userId);
      if (u.coins < item.price) return interaction.reply(`Not enough coins. You have ${u.coins}, need ${item.price}.`);
      await pool.query('UPDATE users SET coins = coins - $1 WHERE user_id = $2', [item.price, userId]);
      await pool.query(`
        INSERT INTO inventory (user_id, item_name, quantity) VALUES ($1, $2, 1)
        ON CONFLICT (user_id, item_name) DO UPDATE SET quantity = inventory.quantity + 1
      `, [userId, item.name]);
      return interaction.reply(`Purchased **${item.name}** for ${item.price} coins. Remaining: ${u.coins - item.price}`);
    }

    if (cmd === 'inventory') {
      const { rows } = await pool.query('SELECT * FROM inventory WHERE user_id = $1', [userId]);
      if (!rows.length) return interaction.reply('You own nothing yet.');
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Your Inventory').setDescription(rows.map(i => `${i.item_name} x${i.quantity}`).join('\n'))] });
    }

    if (cmd === 'shopadd') {
      const name = interaction.options.getString('name');
      const price = interaction.options.getInteger('price');
      const desc = interaction.options.getString('description') || '';
      await pool.query(`
        INSERT INTO shop (name, price, description) VALUES ($1, $2, $3)
        ON CONFLICT (name) DO UPDATE SET price = EXCLUDED.price, description = EXCLUDED.description
      `, [name, price, desc]);
      return interaction.reply(`Shop item **${name}** set to ${price} coins.`);
    }

    if (cmd === 'shopprice') {
      const name = interaction.options.getString('name');
      const price = interaction.options.getInteger('price');
      const result = await pool.query('UPDATE shop SET price = $1 WHERE lower(name) = lower($2)', [price, name]);
      if (result.rowCount === 0) return interaction.reply('Item not found.');
      return interaction.reply(`Updated **${name}** price to ${price} coins.`);
    }

    if (cmd === 'shopremove') {
      const name = interaction.options.getString('name');
      const result = await pool.query('DELETE FROM shop WHERE lower(name) = lower($1)', [name]);
      if (result.rowCount === 0) return interaction.reply('Item not found.');
      return interaction.reply(`Removed **${name}** from the shop.`);
    }

    if (cmd === 'blackjack') {
      const cd = await checkGameCooldown(userId);
      if (!cd.allowed) return interaction.reply(`Game cooldown: ${GAME_PLAYS} plays every 2 hours. Try again in ~${cd.left} minutes.`);
      const bet = interaction.options.getInteger('bet');
      const u = await getUser(userId);
      if (u.coins < bet) return interaction.reply(`Not enough coins. You have ${u.coins}.`);
      await useGamePlay(userId);

      const player = [drawCard(), drawCard()];
      const dealer = [drawCard(), drawCard()];
      const pVal = handValue(player);
      const dVal = handValue(dealer);

      let result = '', payout = 0;
      if (pVal === 21 && dVal !== 21) { result = 'Blackjack! You win!'; payout = Math.floor(bet * 1.5); }
      else if (dVal === 21) { result = 'Dealer blackjack. You lose.'; payout = -bet; }
      else if (pVal > 21) { result = 'Bust! You lose.'; payout = -bet; }
      else if (dVal > 21 || pVal > dVal) { result = 'You win!'; payout = bet; }
      else if (pVal < dVal) { result = 'Dealer wins.'; payout = -bet; }
      else { result = 'Push (tie).'; payout = 0; }

      await addCoins(userId, payout);
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setTitle('Blackjack')
        .setColor(payout > 0 ? 0x00ff00 : payout < 0 ? 0xff0000 : 0xffff00)
        .addFields(
          { name: 'Your Hand', value: player.map(c => `${c.rank}${c.suit}`).join(' ') + ` (${pVal})`, inline: true },
          { name: 'Dealer Hand', value: dealer.map(c => `${c.rank}${c.suit}`).join(' ') + ` (${dVal})`, inline: true },
          { name: 'Result', value: result },
          { name: 'New Balance', value: `${u.coins + payout}` }
        )] });
    }

    if (cmd === 'coinflip') {
      const cd = await checkGameCooldown(userId);
      if (!cd.allowed) return interaction.reply(`Game cooldown: ${GAME_PLAYS} plays every 2 hours. Try again in ~${cd.left} minutes.`);
      const bet = interaction.options.getInteger('bet');
      const side = interaction.options.getString('side');
      const u = await getUser(userId);
      if (u.coins < bet) return interaction.reply(`Not enough coins. You have ${u.coins}.`);
      await useGamePlay(userId);
      const flip = Math.random() < 0.5 ? 'heads' : 'tails';
      const win = flip === side;
      const payout = win ? bet : -bet;
      await addCoins(userId, payout);
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setTitle('Coinflip')
        .setDescription(`You chose **${side}**. Landed on **${flip}**.`)
        .addFields({ name: 'Result', value: win ? 'You win!' : 'You lose.' }, { name: 'New Balance', value: `${u.coins + payout}` })
        .setColor(win ? 0x00ff00 : 0xff0000)] });
    }

    if (cmd === 'dice') {
      const cd = await checkGameCooldown(userId);
      if (!cd.allowed) return interaction.reply(`Game cooldown: ${GAME_PLAYS} plays every 2 hours. Try again in ~${cd.left} minutes.`);
      const bet = interaction.options.getInteger('bet');
      const u = await getUser(userId);
      if (u.coins < bet) return interaction.reply(`Not enough coins. You have ${u.coins}.`);
      await useGamePlay(userId);
      const playerRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
      const botRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
      let payout = 0, result = '';
      if (playerRoll > botRoll) { result = 'You win!'; payout = bet; }
      else if (playerRoll < botRoll) { result = 'Bot wins.'; payout = -bet; }
      else { result = 'Tie.'; payout = 0; }
      await addCoins(userId, payout);
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setTitle('Dice')
        .setDescription(`You rolled **${playerRoll}**. Bot rolled **${botRoll}**.`)
        .addFields({ name: 'Result', value: result }, { name: 'New Balance', value: `${u.coins + payout}` })
        .setColor(payout > 0 ? 0x00ff00 : payout < 0 ? 0xff0000 : 0xffff00)] });
    }

    if (cmd === 'slots') {
      const cd = await checkGameCooldown(userId);
      if (!cd.allowed) return interaction.reply(`Game cooldown: ${GAME_PLAYS} plays every 2 hours. Try again in ~${cd.left} minutes.`);
      const bet = interaction.options.getInteger('bet');
      const u = await getUser(userId);
      if (u.coins < bet) return interaction.reply(`Not enough coins. You have ${u.coins}.`);
      await useGamePlay(userId);
      const symbols = ['🍒', '🍋', '🍊', '🍇', '⭐', '7️⃣'];
      const reels = [symbols[Math.floor(Math.random()*6)], symbols[Math.floor(Math.random()*6)], symbols[Math.floor(Math.random()*6)]];
      let multiplier = 0;
      if (reels[0] === reels[1] && reels[1] === reels[2]) multiplier = reels[0] === '7️⃣' ? 10 : 5;
      else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) multiplier = 2;
      const payout = Math.floor(bet * multiplier) - bet;
      await addCoins(userId, payout);
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setTitle('Slots')
        .setDescription(reels.join(' | '))
        .addFields({ name: 'Result', value: multiplier > 1 ? `You win! x${multiplier}` : 'No match.' }, { name: 'New Balance', value: `${u.coins + payout}` })
        .setColor(payout > 0 ? 0x00ff00 : 0xff0000)] });
    }

    if (cmd === 'leaderboard') {
      const { rows } = await pool.query('SELECT user_id, coins, wins, losses FROM users ORDER BY coins DESC LIMIT 10');
      if (!rows.length) return interaction.reply('No players yet.');
      const lines = rows.map((u, i) => `${i+1}. <@${u.user_id}> — ${u.coins} coins (${u.wins}W-${u.losses}L)`);
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Coin Leaderboard').setDescription(lines.join('\n'))] });
    }

    if (cmd === 'give') {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      if (target.id === userId) return interaction.reply('You can’t give coins to yourself.');
      const u = await getUser(userId);
      if (u.coins < amount) return interaction.reply(`Not enough coins. You have ${u.coins}.`);
      await addCoins(userId, -amount);
      await addCoins(target.id, amount);
      return interaction.reply(`Gave ${amount} coins to ${target}. Your new balance: ${u.coins - amount}`);
    }

    if (cmd === 'daily') {
      const u = await getUser(userId);
      const now = Date.now();
      if (now - Number(u.last_daily || 0) < DAILY_COOLDOWN) {
        const left = Math.ceil((DAILY_COOLDOWN - (now - Number(u.last_daily))) / 3600000);
        return interaction.reply(`You already claimed your daily. Try again in ~${left} hours.`);
      }
      const amount = Math.floor(Math.random() * 20) + 1;
      await addCoins(userId, amount);
      await pool.query('UPDATE users SET last_daily = $1 WHERE user_id = $2', [now, userId]);
      return interaction.reply(`Claimed **${amount}** daily coins! New balance: ${u.coins + amount}`);
    }

    if (cmd === 'stats') {
      const target = interaction.options.getUser('user') || interaction.user;
      const u = await getUser(target.id);
      const { rows: inv } = await pool.query('SELECT * FROM inventory WHERE user_id = $1', [target.id]);
      const invText = inv.length ? inv.map(i => `${i.item_name} x${i.quantity}`).join(', ') : 'None';
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setTitle(`${target.username}'s Stats`)
        .addFields(
          { name: 'Coins', value: `${u.coins}`, inline: true },
          { name: 'Record', value: `${u.wins}W - ${u.losses}L`, inline: true },
          { name: 'Super Bowls (All-Time)', value: `${u.superbowls_alltime || 0}`, inline: true },
          { name: 'Super Bowls (This Madden)', value: `${u.superbowls_current || 0}`, inline: true },
          { name: 'Inventory', value: invText }
        )] });
    }

    if (cmd === 'resetcooldown') {
      const target = interaction.options.getUser('user');
      await resetCooldown(target.id);
      return interaction.reply(`Reset game cooldown for ${target}.`);
    }

    if (cmd === 'reset') {
      const target = interaction.options.getUser('user');
      await pool.query('UPDATE users SET coins = 0, wins = 0, losses = 0, superbowls_alltime = 0, superbowls_current = 0 WHERE user_id = $1', [target.id]);
      return interaction.reply(`Reset ${target}'s coins and record.`);
    }

    if (cmd === 'award') {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const reason = interaction.options.getString('reason') || 'No reason';
      await addCoins(target.id, amount);
      const u = await getUser(target.id);
      return interaction.reply(`Awarded ${amount} coins to ${target} (${reason}). New balance: ${u.coins}`);
    }

    if (cmd === 'fine') {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const reason = interaction.options.getString('reason') || 'No reason';
      const u = await getUser(target.id);
      const actual = Math.min(amount, u.coins);
      await addCoins(target.id, -actual);
      return interaction.reply(`Fined ${target} ${actual} coins (${reason}). New balance: ${u.coins - actual}`);
    }

    if (cmd === 'addsuperbowl') {
      const target = interaction.options.getUser('user');
      const count = interaction.options.getInteger('count') || 1;
      const current = interaction.options.getBoolean('current') !== false;
      await getUser(target.id);
      await pool.query('UPDATE users SET superbowls_alltime = superbowls_alltime + $1 WHERE user_id = $2', [count, target.id]);
      if (current) {
        await pool.query('UPDATE users SET superbowls_current = superbowls_current + $1 WHERE user_id = $2', [count, target.id]);
      }
      const u = await getUser(target.id);
      return interaction.reply(`Added **${count}** Super Bowl${count > 1 ? 's' : ''} to ${target}.\nAll-Time: ${u.superbowls_alltime} | This Madden: ${u.superbowls_current}`);
    }

    if (cmd === 'removesuperbowl') {
      const target = interaction.options.getUser('user');
      const count = interaction.options.getInteger('count') || 1;
      const current = interaction.options.getBoolean('current') !== false;
      const u = await getUser(target.id);
      const removeAll = Math.min(count, u.superbowls_alltime || 0);
      const removeCurrent = current ? Math.min(count, u.superbowls_current || 0) : 0;
      await pool.query('UPDATE users SET superbowls_alltime = GREATEST(0, superbowls_alltime - $1) WHERE user_id = $2', [removeAll, target.id]);
      if (current) {
        await pool.query('UPDATE users SET superbowls_current = GREATEST(0, superbowls_current - $1) WHERE user_id = $2', [removeCurrent, target.id]);
      }
      const updated = await getUser(target.id);
      return interaction.reply(`Removed **${removeAll}** Super Bowl${removeAll !== 1 ? 's' : ''} from ${target}.\nAll-Time: ${updated.superbowls_alltime} | This Madden: ${updated.superbowls_current}`);
    }

    if (cmd === 'steal') {
      const target = interaction.options.getUser('user');
      if (target.id === userId) return interaction.reply('You can’t steal from yourself.');
      if (target.bot) return interaction.reply('You can’t steal from a bot.');

      const { rows } = await pool.query('SELECT * FROM inventory WHERE user_id = $1 AND lower(item_name) = lower($2)', [userId, 'Theft']);
      const theft = rows[0];
      if (!theft || theft.quantity < 1) return interaction.reply('You don’t have a Theft item. Buy one from /shop.');

      const victim = await getUser(target.id);
      if (victim.coins <= 0) return interaction.reply(`${target} has no coins to steal.`);

      const amount = Math.floor(Math.random() * 200) + 1;
      const stolen = Math.min(amount, victim.coins);

      await addCoins(target.id, -stolen);
      await addCoins(userId, stolen);
      await pool.query('UPDATE inventory SET quantity = quantity - 1 WHERE user_id = $1 AND item_name = $2', [userId, theft.item_name]);

      return interaction.reply(`You used **Theft** and stole **${stolen}** coins from ${target}!`);
    }

    if (cmd === 'use') {
      const itemName = interaction.options.getString('item');
      const { rows } = await pool.query('SELECT * FROM inventory WHERE user_id = $1 AND lower(item_name) = lower($2)', [userId, itemName]);
      const row = rows[0];
      if (!row || row.quantity < 1) return interaction.reply('You don’t own that item.');
      await pool.query('UPDATE inventory SET quantity = quantity - 1 WHERE user_id = $1 AND item_name = $2', [userId, row.item_name]);
      return interaction.reply(`Used **${row.item_name}**. Remaining: ${row.quantity - 1}`);
    }

    if (cmd === 'help') {
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setTitle('Commands')
        .setDescription([
          '**Economy:** /balance, /daily (1-20 coins), /give, /leaderboard, /stats',
          '**Shop:** /shop, /buy, /inventory, /use, /steal',
          '**Games:** /blackjack, /coinflip, /dice, /slots, /challengedice (best of 3)',
          '**Admin:** /win, /loss, /award, /fine, /reset, /resetcooldown, /addsuperbowl, /removesuperbowl, /shopadd, /shopprice, /shopremove'
        ].join('\n'))] });
    }

    if (cmd === 'challengedice') {
      const target = interaction.options.getUser('user');
      const bet = interaction.options.getInteger('bet');
      if (target.id === userId) return interaction.reply('You can’t challenge yourself.');
      if (target.bot) return interaction.reply('You can’t challenge a bot.');

      const challenger = await getUser(userId);
      const opponent = await getUser(target.id);
      if (challenger.coins < bet) return interaction.reply(`You don’t have enough coins (${challenger.coins}).`);
      if (opponent.coins < bet) return interaction.reply(`${target} doesn’t have enough coins.`);

      const challengeId = `${userId}-${target.id}-${Date.now()}`;
      pendingChallenges.set(challengeId, { challengerId: userId, targetId: target.id, bet, accepted: false });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`accept_${challengeId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`decline_${challengeId}`).setLabel('Decline').setStyle(ButtonStyle.Danger)
      );

      return interaction.reply({
        content: `${target}, ${interaction.user} challenges you to **best-of-3 dice** for **${bet} coins** each!`,
        components: [row]
      });
    }
  } catch (err) {
    console.error(err);
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: 'Something went wrong. Try again.', ephemeral: true });
    }
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const [action, ...rest] = interaction.customId.split('_');
  const challengeId = rest.join('_');
  const challenge = pendingChallenges.get(challengeId);
  if (!challenge) return interaction.reply({ content: 'This challenge has expired.', ephemeral: true });

  if (interaction.user.id !== challenge.targetId) {
    return interaction.reply({ content: 'Only the challenged player can respond.', ephemeral: true });
  }

  if (action === 'decline') {
    pendingChallenges.delete(challengeId);
    return interaction.update({ content: 'Challenge declined.', components: [] });
  }

  if (action === 'accept') {
    try {
      const { challengerId, targetId, bet } = challenge;
      const cUser = await getUser(challengerId);
      const tUser = await getUser(targetId);
      if (cUser.coins < bet || tUser.coins < bet) {
        pendingChallenges.delete(challengeId);
        return interaction.update({ content: 'One of the players no longer has enough coins.', components: [] });
      }

      await addCoins(challengerId, -bet);
      await addCoins(targetId, -bet);

      let cWins = 0, tWins = 0;
      const rounds = [];
      for (let i = 1; i <= 3; i++) {
        const cRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
        const tRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
        rounds.push(`Round ${i}: <@${challengerId}> ${cRoll} vs <@${targetId}> ${tRoll}`);
        if (cRoll > tRoll) cWins++;
        else if (tRoll > cRoll) tWins++;
        if (cWins === 2 || tWins === 2) break;
      }

      let winnerId = null;
      let resultText = '';
      if (cWins > tWins) {
        winnerId = challengerId;
        resultText = `<@${challengerId}> wins ${cWins}-${tWins}!`;
        await addCoins(challengerId, bet * 2);
      } else if (tWins > cWins) {
        winnerId = targetId;
        resultText = `<@${targetId}> wins ${tWins}-${cWins}!`;
        await addCoins(targetId, bet * 2);
      } else {
        resultText = 'Tie! Bets refunded.';
        await addCoins(challengerId, bet);
        await addCoins(targetId, bet);
      }

      pendingChallenges.delete(challengeId);
      const embed = new EmbedBuilder()
        .setTitle('Best of 3 Dice')
        .setDescription(rounds.join('\n') + '\n\n' + resultText)
        .setColor(winnerId ? 0x00ff00 : 0xffff00);

      return interaction.update({ content: '', embeds: [embed], components: [] });
    } catch (err) {
      console.error(err);
      return interaction.update({ content: 'Error running the challenge.', components: [] });
    }
  }
});

client.login(TOKEN);
