require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`Health server on ${PORT}`));

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID');
  process.exit(1);
}

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'economy.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    coins INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    last_daily INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS shop (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    window_start INTEGER DEFAULT 0
  );
`);

const shopCount = db.prepare('SELECT COUNT(*) as c FROM shop').get().c;
if (shopCount === 0) {
  const insert = db.prepare('INSERT INTO shop (name, price, description) VALUES (?, ?, ?)');
  insert.run('Extra Trade', 500, 'One additional trade this season');
  insert.run('Dev Upgrade', 750, 'Upgrade a player development trait');
  insert.run('Age Reduction', 600, 'Reduce a player age by 1 year');
  insert.run('Contract Reduction', 400, 'Reduce a contract by 20%');
  insert.run('Theft', 300, 'Attempt to steal 1-200 coins from another player');
}

function getUser(userId) {
  let user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  if (!user) {
    db.prepare('INSERT INTO users (user_id) VALUES (?)').run(userId);
    user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  }
  return user;
}

function addCoins(userId, amount) {
  getUser(userId);
  db.prepare('UPDATE users SET coins = coins + ? WHERE user_id = ?').run(amount, userId);
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function checkGameCooldown(userId) {
  const now = Date.now();
  let row = db.prepare('SELECT * FROM cooldowns WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO cooldowns (user_id, plays, window_start) VALUES (?, 0, ?)').run(userId, now);
    row = { plays: 0, window_start: now };
  }
  if (now - row.window_start >= GAME_WINDOW) {
    db.prepare('UPDATE cooldowns SET plays = 0, window_start = ? WHERE user_id = ?').run(now, userId);
    row.plays = 0;
    row.window_start = now;
  }
  if (row.plays >= GAME_PLAYS) {
    const left = Math.ceil((GAME_WINDOW - (now - row.window_start)) / 60000);
    return { allowed: false, left };
  }
  return { allowed: true };
}

function useGamePlay(userId) {
  db.prepare('UPDATE cooldowns SET plays = plays + 1 WHERE user_id = ?').run(userId);
}

function resetCooldown(userId) {
  db.prepare('INSERT INTO cooldowns (user_id, plays, window_start) VALUES (?, 0, 0) ON CONFLICT(user_id) DO UPDATE SET plays = 0, window_start = 0').run(userId);
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
  new SlashCommandBuilder().setName('challengedice').setDescription('Challenge someone to best-of-3 dice')
    .addUserOption(o => o.setName('user').setDescription('Opponent').setRequired(true))
    .addIntegerOption(o => o.setName('bet').setDescription('Amount each player bets').setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET)),
  new SlashCommandBuilder().setName('slots').setDescription('Spin the slots')
    .addIntegerOption(o => o.setName('bet').setDescription('Amount to bet').setRequired(true).setMinValue(MIN_BET).setMaxValue(MAX_BET)),
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

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
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

  const adminCmds = ['win', 'loss', 'shopadd', 'shopprice', 'shopremove', 'reset', 'resetcooldown', 'award', 'fine'];
  if (adminCmds.includes(cmd) && !isAdmin(interaction)) {
    return interaction.reply({ content: 'You need Administrator permission to use this command.', ephemeral: true });
  }

  if (cmd === 'balance') {
    const u = getUser(userId);
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
    getUser(target.id);
    db.prepare('UPDATE users SET wins = wins + 1, coins = coins + 100 WHERE user_id = ?').run(target.id);
    const u = getUser(target.id);
    return interaction.reply(`${target} recorded a **WIN** (+100 coins). New balance: ${u.coins}`);
  }

  if (cmd === 'loss') {
    const target = interaction.options.getUser('user');
    getUser(target.id);
    db.prepare('UPDATE users SET losses = losses + 1, coins = coins + 50 WHERE user_id = ?').run(target.id);
    const u = getUser(target.id);
    return interaction.reply(`${target} recorded a **LOSS** (+50 coins). New balance: ${u.coins}`);
  }

  if (cmd === 'shop') {
    const items = db.prepare('SELECT * FROM shop ORDER BY price').all();
    if (!items.length) return interaction.reply('Shop is empty.');
    const lines = items.map(i => `**${i.name}** — ${i.price} coins\n${i.description || ''}`);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('League Shop').setDescription(lines.join('\n\n')).setColor(0xffaa00)] });
  }

  if (cmd === 'buy') {
    const itemName = interaction.options.getString('item');
    const item = db.prepare('SELECT * FROM shop WHERE lower(name) = lower(?)').get(itemName);
    if (!item) return interaction.reply('Item not found. Check /shop');
    const u = getUser(userId);
    if (u.coins < item.price) return interaction.reply(`Not enough coins. You have ${u.coins}, need ${item.price}.`);
    db.prepare('UPDATE users SET coins = coins - ? WHERE user_id = ?').run(item.price, userId);
    db.prepare(`INSERT INTO inventory (user_id, item_name, quantity) VALUES (?, ?, 1)
      ON CONFLICT(user_id, item_name) DO UPDATE SET quantity = quantity + 1`).run(userId, item.name);
    return interaction.reply(`Purchased **${item.name}** for ${item.price} coins. Remaining: ${u.coins - item.price}`);
  }

  if (cmd === 'inventory') {
    const items = db.prepare('SELECT * FROM inventory WHERE user_id = ?').all(userId);
    if (!items.length) return interaction.reply('You own nothing yet.');
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Your Inventory').setDescription(items.map(i => `${i.item_name} x${i.quantity}`).join('\n'))] });
  }

  if (cmd === 'shopadd') {
    const name = interaction.options.getString('name');
    const price = interaction.options.getInteger('price');
    const desc = interaction.options.getString('description') || '';
    db.prepare(`INSERT INTO shop (name, price, description) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET price = excluded.price, description = excluded.description`).run(name, price, desc);
    return interaction.reply(`Shop item **${name}** set to ${price} coins.`);
  }

  if (cmd === 'shopprice') {
    const name = interaction.options.getString('name');
    const price = interaction.options.getInteger('price');
    const result = db.prepare('UPDATE shop SET price = ? WHERE lower(name) = lower(?)').run(price, name);
    if (result.changes === 0) return interaction.reply('Item not found.');
    return interaction.reply(`Updated **${name}** price to ${price} coins.`);
  }

  if (cmd === 'shopremove') {
    const name = interaction.options.getString('name');
    const result = db.prepare('DELETE FROM shop WHERE lower(name) = lower(?)').run(name);
    if (result.changes === 0) return interaction.reply('Item not found.');
    return interaction.reply(`Removed **${name}** from the shop.`);
  }

  if (cmd === 'blackjack') {
    const cd = checkGameCooldown(userId);
    if (!cd.allowed) return interaction.reply(`Game cooldown: ${GAME_PLAYS} plays every 2 hours. Try again in ~${cd.left} minutes.`);
    const bet = interaction.options.getInteger('bet');
    const u = getUser(userId);
    if (u.coins < bet) return interaction.reply(`Not enough coins. You have ${u.coins}.`);
    useGamePlay(userId);

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

    addCoins(userId, payout);
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
    const cd = checkGameCooldown(userId);
    if (!cd.allowed) return interaction.reply(`Game cooldown: ${GAME_PLAYS} plays every 2 hours. Try again in ~${cd.left} minutes.`);
    const bet = interaction.options.getInteger('bet');
    const side = interaction.options.getString('side');
    const u = getUser(userId);
    if (u.coins < bet) return interaction.reply(`Not enough coins. You have ${u.coins}.`);
    useGamePlay(userId);
    const flip = Math.random() < 0.5 ? 'heads' : 'tails';
    const win = flip === side;
    const payout = win ? bet : -bet;
    addCoins(userId, payout);
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setTitle('Coinflip')
      .setDescription(`You chose **${side}**. Landed on **${flip}**.`)
      .addFields({ name: 'Result', value: win ? 'You win!' : 'You lose.' }, { name: 'New Balance', value: `${u.coins + payout}` })
      .setColor(win ? 0x00ff00 : 0xff0000)] });
  }

  if (cmd === 'dice') {
    const cd = checkGameCooldown(userId);
    if (!cd.allowed) return interaction.reply(`Game cooldown: ${GAME_PLAYS} plays every 2 hours. Try again in ~${cd.left} minutes.`);
    const bet = interaction.options.getInteger('bet');
    const u = getUser(userId);
    if (u.coins < bet) return interaction.reply(`Not enough coins. You have ${u.coins}.`);
    useGamePlay(userId);
    const playerRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
    const botRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
    let payout = 0, result = '';
    if (playerRoll > botRoll) { result = 'You win!'; payout = bet; }
    else if (playerRoll < botRoll) { result = 'Bot wins.'; payout = -bet; }
    else { result = 'Tie.'; payout = 0; }
    addCoins(userId, payout);
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setTitle('Dice')
      .setDescription(`You rolled **${playerRoll}**. Bot rolled **${botRoll}**.`)
      .addFields({ name: 'Result', value: result }, { name: 'New Balance', value: `${u.coins + payout}` })
      .setColor(payout > 0 ? 0x00ff00 : payout < 0 ? 0xff0000 : 0xffff00)] });
  }

  if (cmd === 'slots') {
    const cd = checkGameCooldown(userId);
    if (!cd.allowed) return interaction.reply(`Game cooldown: ${GAME_PLAYS} plays every 2 hours. Try again in ~${cd.left} minutes.`);
    const bet = interaction.options.getInteger('bet');
    const u = getUser(userId);
    if (u.coins < bet) return interaction.reply(`Not enough coins. You have ${u.coins}.`);
    useGamePlay(userId);
    const symbols = ['🍒', '🍋', '🍊', '🍇', '⭐', '7️⃣'];
    const reels = [symbols[Math.floor(Math.random()*6)], symbols[Math.floor(Math.random()*6)], symbols[Math.floor(Math.random()*6)]];
    let multiplier = 0;
    if (reels[0] === reels[1] && reels[1] === reels[2]) multiplier = reels[0] === '7️⃣' ? 10 : 5;
    else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) multiplier = 2;
    const payout = Math.floor(bet * multiplier) - bet;
    addCoins(userId, payout);
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setTitle('Slots')
      .setDescription(reels.join(' | '))
      .addFields({ name: 'Result', value: multiplier > 1 ? `You win! x${multiplier}` : 'No match.' }, { name: 'New Balance', value: `${u.coins + payout}` })
      .setColor(payout > 0 ? 0x00ff00 : 0xff0000)] });
  }

  if (cmd === 'leaderboard') {
    const top = db.prepare('SELECT user_id, coins, wins, losses FROM users ORDER BY coins DESC LIMIT 10').all();
    if (!top.length) return interaction.reply('No players yet.');
    const lines = top.map((u, i) => `${i+1}. <@${u.user_id}> — ${u.coins} coins (${u.wins}W-${u.losses}L)`);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Coin Leaderboard').setDescription(lines.join('\n'))] });
  }

  if (cmd === 'give') {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (target.id === userId) return interaction.reply('You can’t give coins to yourself.');
    const u = getUser(userId);
    if (u.coins < amount) return interaction.reply(`Not enough coins. You have ${u.coins}.`);
    addCoins(userId, -amount);
    addCoins(target.id, amount);
    return interaction.reply(`Gave ${amount} coins to ${target}. Your new balance: ${u.coins - amount}`);
  }

  if (cmd === 'daily') {
    const u = getUser(userId);
    const now = Date.now();
    if (now - (u.last_daily || 0) < DAILY_COOLDOWN) {
      const left = Math.ceil((DAILY_COOLDOWN - (now - u.last_daily)) / 3600000);
      return interaction.reply(`You already claimed your daily. Try again in ~${left} hours.`);
    }
    const amount = Math.floor(Math.random() * 20) + 1;
    addCoins(userId, amount);
    db.prepare('UPDATE users SET last_daily = ? WHERE user_id = ?').run(now, userId);
    return interaction.reply(`Claimed **${amount}** daily coins! New balance: ${u.coins + amount}`);
  }

  if (cmd === 'stats') {
    const target = interaction.options.getUser('user') || interaction.user;
    const u = getUser(target.id);
    const inv = db.prepare('SELECT * FROM inventory WHERE user_id = ?').all(target.id);
    const invText = inv.length ? inv.map(i => `${i.item_name} x${i.quantity}`).join(', ') : 'None';
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setTitle(`${target.username}'s Stats`)
      .addFields(
        { name: 'Coins', value: `${u.coins}`, inline: true },
        { name: 'Record', value: `${u.wins}W - ${u.losses}L`, inline: true },
        { name: 'Inventory', value: invText }
      )] });
  }

  if (cmd === 'resetcooldown') {
    const target = interaction.options.getUser('user');
    resetCooldown(target.id);
    return interaction.reply(`Reset game cooldown for ${target}.`);
  }

  if (cmd === 'reset') {
    const target = interaction.options.getUser('user');
    db.prepare('UPDATE users SET coins = 0, wins = 0, losses = 0 WHERE user_id = ?').run(target.id);
    return interaction.reply(`Reset ${target}'s coins and record.`);
  }

  if (cmd === 'award') {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    const reason = interaction.options.getString('reason') || 'No reason';
    addCoins(target.id, amount);
    const u = getUser(target.id);
    return interaction.reply(`Awarded ${amount} coins to ${target} (${reason}). New balance: ${u.coins}`);
  }

  if (cmd === 'fine') {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    const reason = interaction.options.getString('reason') || 'No reason';
    const u = getUser(target.id);
    const actual = Math.min(amount, u.coins);
    addCoins(target.id, -actual);
    return interaction.reply(`Fined ${target} ${actual} coins (${reason}). New balance: ${u.coins - actual}`);
  }


  if (cmd === 'steal') {
    const target = interaction.options.getUser('user');
    if (target.id === userId) return interaction.reply('You can’t steal from yourself.');
    if (target.bot) return interaction.reply('You can’t steal from a bot.');

    const theft = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND lower(item_name) = lower(?)').get(userId, 'Theft');
    if (!theft || theft.quantity < 1) return interaction.reply('You don’t have a Theft item. Buy one from /shop.');

    const victim = getUser(target.id);
    if (victim.coins <= 0) return interaction.reply(`${target} has no coins to steal.`);

    const amount = Math.floor(Math.random() * 200) + 1;
    const stolen = Math.min(amount, victim.coins);

    addCoins(target.id, -stolen);
    addCoins(userId, stolen);
    db.prepare('UPDATE inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_name = ?').run(userId, theft.item_name);

    return interaction.reply(`You used **Theft** and stole **${stolen}** coins from ${target}!`);
  }

  if (cmd === 'use') {
    const itemName = interaction.options.getString('item');
    const row = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND lower(item_name) = lower(?)').get(userId, itemName);
    if (!row || row.quantity < 1) return interaction.reply('You don’t own that item.');
    db.prepare('UPDATE inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_name = ?').run(userId, row.item_name);
    return interaction.reply(`Used **${row.item_name}**. Remaining: ${row.quantity - 1}`);
  }


  if (cmd === 'challengedice') {
    const target = interaction.options.getUser('user');
    const bet = interaction.options.getInteger('bet');
    if (target.id === userId) return interaction.reply('You can’t challenge yourself.');
    if (target.bot) return interaction.reply('You can’t challenge a bot.');

    const challenger = getUser(userId);
    const opponent = getUser(target.id);
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

  if (cmd === 'help') {
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setTitle('Commands')
      .setDescription([
        '**Economy:** /balance, /daily (1-20 coins), /give, /leaderboard, /stats',
        '**Shop:** /shop, /buy, /inventory, /use, /steal',
        '**Games:** /blackjack, /coinflip, /dice, /slots, /challengedice (best of 3)',
        '**Admin:** /win, /loss, /award, /fine, /reset, /resetcooldown, /shopadd, /shopprice, /shopremove'
      ].join('\n'))] });
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
    const { challengerId, targetId, bet } = challenge;
    const cUser = getUser(challengerId);
    const tUser = getUser(targetId);
    if (cUser.coins < bet || tUser.coins < bet) {
      pendingChallenges.delete(challengeId);
      return interaction.update({ content: 'One of the players no longer has enough coins.', components: [] });
    }

    // Deduct bets
    addCoins(challengerId, -bet);
    addCoins(targetId, -bet);

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
      addCoins(challengerId, bet * 2);
    } else if (tWins > cWins) {
      winnerId = targetId;
      resultText = `<@${targetId}> wins ${tWins}-${cWins}!`;
      addCoins(targetId, bet * 2);
    } else {
      resultText = 'Tie! Bets refunded.';
      addCoins(challengerId, bet);
      addCoins(targetId, bet);
    }

    pendingChallenges.delete(challengeId);
    const embed = new EmbedBuilder()
      .setTitle('Best of 3 Dice')
      .setDescription(rounds.join('\n') + '\n\n' + resultText)
      .setColor(winnerId ? 0x00ff00 : 0xffff00);

    return interaction.update({ content: '', embeds: [embed], components: [] });
  }
});

client.login(TOKEN);
