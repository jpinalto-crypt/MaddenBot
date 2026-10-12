require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
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
    losses INTEGER DEFAULT 0
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
`);

// Seed default shop items if empty
const shopCount = db.prepare('SELECT COUNT(*) as c FROM shop').get().c;
if (shopCount === 0) {
  const insert = db.prepare('INSERT INTO shop (name, price, description) VALUES (?, ?, ?)');
  insert.run('Extra Trade', 500, 'One additional trade this season');
  insert.run('Dev Upgrade', 750, 'Upgrade a player development trait');
  insert.run('Age Reduction', 600, 'Reduce a player age by 1 year');
  insert.run('Contract Reduction', 400, 'Reduce a contract by 20%');
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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const commands = [
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your coin balance and record'),
  new SlashCommandBuilder()
    .setName('win')
    .setDescription('Award a win (+100 coins) — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('loss')
    .setDescription('Award a loss (+50 coins) — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('shop')
    .setDescription('View the shop'),
  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Buy an item from the shop')
    .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('View your purchased items'),
  new SlashCommandBuilder()
    .setName('shopadd')
    .setDescription('Add or update a shop item — Admin only')
    .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true))
    .addIntegerOption(o => o.setName('price').setDescription('Price in coins').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Short description'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('shopprice')
    .setDescription('Change the price of a shop item — Admin only')
    .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true))
    .addIntegerOption(o => o.setName('price').setDescription('New price').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Play blackjack and bet coins')
    .addIntegerOption(o => o.setName('bet').setDescription('Amount to bet').setRequired(true).setMinValue(10)),
  new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Flip a coin and bet coins')
    .addIntegerOption(o => o.setName('bet').setDescription('Amount to bet').setRequired(true).setMinValue(10))
    .addStringOption(o => o.setName('side').setDescription('heads or tails').setRequired(true)
      .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })),
  new SlashCommandBuilder()
    .setName('dice')
    .setDescription('Roll dice and bet coins (higher than bot wins)')
    .addIntegerOption(o => o.setName('bet').setDescription('Amount to bet').setRequired(true).setMinValue(10))
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

// Simple card helpers for blackjack
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

  if (interaction.commandName === 'balance') {
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

  if (interaction.commandName === 'win') {
    const target = interaction.options.getUser('user');
    const u = getUser(target.id);
    db.prepare('UPDATE users SET wins = wins + 1, coins = coins + 100 WHERE user_id = ?').run(target.id);
    return interaction.reply(`${target} recorded a **WIN** (+100 coins). New balance: ${u.coins + 100}`);
  }

  if (interaction.commandName === 'loss') {
    const target = interaction.options.getUser('user');
    const u = getUser(target.id);
    db.prepare('UPDATE users SET losses = losses + 1, coins = coins + 50 WHERE user_id = ?').run(target.id);
    return interaction.reply(`${target} recorded a **LOSS** (+50 coins). New balance: ${u.coins + 50}`);
  }

  if (interaction.commandName === 'shop') {
    const items = db.prepare('SELECT * FROM shop ORDER BY price').all();
    if (!items.length) return interaction.reply('Shop is empty.');
    const lines = items.map(i => `**${i.name}** — ${i.price} coins\n${i.description || ''}`);
    const embed = new EmbedBuilder()
      .setTitle('League Shop')
      .setDescription(lines.join('\n\n'))
      .setColor(0xffaa00)
      .setFooter({ text: 'Use /buy item:<name>' });
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'buy') {
    const itemName = interaction.options.getString('item');
    const item = db.prepare('SELECT * FROM shop WHERE lower(name) = lower(?)').get(itemName);
    if (!item) return interaction.reply('Item not found. Check /shop');
    const u = getUser(userId);
    if (u.coins < item.price) return interaction.reply(`Not enough coins. You have ${u.coins}, need ${item.price}.`);
    db.prepare('UPDATE users SET coins = coins - ? WHERE user_id = ?').run(item.price, userId);
    db.prepare(`
      INSERT INTO inventory (user_id, item_name, quantity) VALUES (?, ?, 1)
      ON CONFLICT(user_id, item_name) DO UPDATE SET quantity = quantity + 1
    `).run(userId, item.name);
    return interaction.reply(`Purchased **${item.name}** for ${item.price} coins. Remaining: ${u.coins - item.price}`);
  }

  if (interaction.commandName === 'inventory') {
    const items = db.prepare('SELECT * FROM inventory WHERE user_id = ?').all(userId);
    if (!items.length) return interaction.reply('You own nothing yet.');
    const lines = items.map(i => `${i.item_name} x${i.quantity}`);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Your Inventory').setDescription(lines.join('\n'))] });
  }

  if (interaction.commandName === 'shopadd') {
    const name = interaction.options.getString('name');
    const price = interaction.options.getInteger('price');
    const desc = interaction.options.getString('description') || '';
    db.prepare(`
      INSERT INTO shop (name, price, description) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET price = excluded.price, description = excluded.description
    `).run(name, price, desc);
    return interaction.reply(`Shop item **${name}** set to ${price} coins.`);
  }

  if (interaction.commandName === 'shopprice') {
    const name = interaction.options.getString('name');
    const price = interaction.options.getInteger('price');
    const result = db.prepare('UPDATE shop SET price = ? WHERE lower(name) = lower(?)').run(price, name);
    if (result.changes === 0) return interaction.reply('Item not found.');
    return interaction.reply(`Updated **${name}** price to ${price} coins.`);
  }

  if (interaction.commandName === 'blackjack') {
    const bet = interaction.options.getInteger('bet');
    const u = getUser(userId);
    if (u.coins < bet) return interaction.reply(`Not enough coins. You have ${u.coins}.`);

    const player = [drawCard(), drawCard()];
    const dealer = [drawCard(), drawCard()];
    const pVal = handValue(player);
    const dVal = handValue(dealer);

    let result = '';
    let payout = 0;
    if (pVal === 21 && dVal !== 21) {
      result = 'Blackjack! You win!';
      payout = Math.floor(bet * 1.5);
    } else if (dVal === 21) {
      result = 'Dealer blackjack. You lose.';
      payout = -bet;
    } else if (pVal > 21) {
      result = 'Bust! You lose.';
      payout = -bet;
    } else if (dVal > 21 || pVal > dVal) {
      result = 'You win!';
      payout = bet;
    } else if (pVal < dVal) {
      result = 'Dealer wins.';
      payout = -bet;
    } else {
      result = 'Push (tie).';
      payout = 0;
    }

    addCoins(userId, payout);
    const newBal = u.coins + payout;
    const embed = new EmbedBuilder()
      .setTitle('Blackjack')
      .setColor(payout > 0 ? 0x00ff00 : payout < 0 ? 0xff0000 : 0xffff00)
      .addFields(
        { name: 'Your Hand', value: player.map(c => `${c.rank}${c.suit}`).join(' ') + ` (${pVal})`, inline: true },
        { name: 'Dealer Hand', value: dealer.map(c => `${c.rank}${c.suit}`).join(' ') + ` (${dVal})`, inline: true },
        { name: 'Result', value: result },
        { name: 'Bet', value: `${bet}`, inline: true },
        { name: 'New Balance', value: `${newBal}`, inline: true }
      );
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'coinflip') {
    const bet = interaction.options.getInteger('bet');
    const side = interaction.options.getString('side');
    const u = getUser(userId);
    if (u.coins < bet) return interaction.reply(`Not enough coins. You have ${u.coins}.`);

    const flip = Math.random() < 0.5 ? 'heads' : 'tails';
    const win = flip === side;
    const payout = win ? bet : -bet;
    addCoins(userId, payout);

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('Coinflip')
        .setDescription(`You chose **${side}**. Landed on **${flip}**.`)
        .addFields(
          { name: 'Result', value: win ? 'You win!' : 'You lose.' },
          { name: 'New Balance', value: `${u.coins + payout}` }
        )
        .setColor(win ? 0x00ff00 : 0xff0000)]
    });
  }

  if (interaction.commandName === 'dice') {
    const bet = interaction.options.getInteger('bet');
    const u = getUser(userId);
    if (u.coins < bet) return interaction.reply(`Not enough coins. You have ${u.coins}.`);

    const playerRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
    const botRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
    let payout = 0;
    let result = '';
    if (playerRoll > botRoll) {
      result = 'You win!';
      payout = bet;
    } else if (playerRoll < botRoll) {
      result = 'Bot wins.';
      payout = -bet;
    } else {
      result = 'Tie.';
      payout = 0;
    }
    addCoins(userId, payout);

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('Dice')
        .setDescription(`You rolled **${playerRoll}**. Bot rolled **${botRoll}**.`)
        .addFields(
          { name: 'Result', value: result },
          { name: 'New Balance', value: `${u.coins + payout}` }
        )
        .setColor(payout > 0 ? 0x00ff00 : payout < 0 ? 0xff0000 : 0xffff00)]
    });
  }
});

client.login(TOKEN);
