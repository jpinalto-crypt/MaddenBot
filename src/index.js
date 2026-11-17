require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { createClient } = require('@libsql/client');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`Health server on ${PORT}`));

const MAX_BET = 300;
const STREAK_BONUS = 10;
const STREAK_CAP = 5; // max +50 bonus

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID');
  process.exit(1);
}
if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN');
  process.exit(1);
}

const db = createClient({
  url: TURSO_URL,
  authToken: TURSO_TOKEN,
});

async function initDb() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      coins INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      superbowls_alltime INTEGER DEFAULT 0,
      superbowls_current INTEGER DEFAULT 0,
      current_streak INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      game TEXT,
      pick TEXT,
      amount INTEGER,
      resolved INTEGER DEFAULT 0
    );
  `);

  // Add columns if missing
  const alters = [
    'ALTER TABLE users ADD COLUMN current_streak INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN last_daily INTEGER DEFAULT 0'
  ];
  for (const sql of alters) {
    try { await db.execute(sql); } catch (e) {}
  }

  // Re-seed shop
  await db.execute('DELETE FROM shop');
  await db.batch([
    { sql: 'INSERT INTO shop (name, price, description) VALUES (?, ?, ?)', args: ['Theft', 200, 'Attempt to steal 10-350 coins or an item from another user'] },
    { sql: 'INSERT INTO shop (name, price, description) VALUES (?, ?, ?)', args: ['Insurance', 150, 'Blocks one theft attempt (consumed on use)'] },
    { sql: 'INSERT INTO shop (name, price, description) VALUES (?, ?, ?)', args: ['Contract Reduction', 400, 'Reduce a contract by 20%'] },
    { sql: 'INSERT INTO shop (name, price, description) VALUES (?, ?, ?)', args: ['Age Reduction', 500, 'Reduce player age by 3'] },
    { sql: 'INSERT INTO shop (name, price, description) VALUES (?, ?, ?)', args: ['Dev Upgrade', 750, 'Upgrade a player development trait'] },
  ], 'write');
}

async function getUser(userId) {
  let result = await db.execute({ sql: 'SELECT * FROM users WHERE user_id = ?', args: [userId] });
  if (result.rows.length === 0) {
    await db.execute({ sql: 'INSERT INTO users (user_id) VALUES (?)', args: [userId] });
    result = await db.execute({ sql: 'SELECT * FROM users WHERE user_id = ?', args: [userId] });
  }
  return result.rows[0];
}

async function addCoins(userId, amount) {
  await getUser(userId);
  await db.execute({ sql: 'UPDATE users SET coins = coins + ? WHERE user_id = ?', args: [amount, userId] });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const commands = [
  new SlashCommandBuilder().setName('balance').setDescription('Check your coin balance and record'),
  new SlashCommandBuilder().setName('stats').setDescription('View full stats for a user')
    .addUserOption(o => o.setName('user').setDescription('User (leave blank for yourself)')),
  new SlashCommandBuilder().setName('daily').setDescription('Claim your daily coins (1-40)'),
  new SlashCommandBuilder().setName('streak').setDescription('Check your current win streak'),
  new SlashCommandBuilder().setName('pay').setDescription('Send coins to another user')
    .addUserOption(o => o.setName('user').setDescription('Who to pay').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('myitems').setDescription('See your unused shop items'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Record leaderboard sorted by win percentage'),
  new SlashCommandBuilder().setName('richest').setDescription('Coin leaderboard'),
  new SlashCommandBuilder().setName('win').setDescription('Award a win (+100 + streak bonus) — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('loss').setDescription('Award a loss (+50, resets streak) — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setrecord').setDescription('Set full coins/wins/losses — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .addIntegerOption(o => o.setName('coins').setDescription('Coins').setRequired(true).setMinValue(0))
    .addIntegerOption(o => o.setName('wins').setDescription('Wins').setRequired(true).setMinValue(0))
    .addIntegerOption(o => o.setName('losses').setDescription('Losses').setRequired(true).setMinValue(0))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setsuperbowls').setDescription('Set Super Bowl counts — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .addIntegerOption(o => o.setName('alltime').setDescription('All-time').setRequired(true).setMinValue(0))
    .addIntegerOption(o => o.setName('current').setDescription('This season').setRequired(true).setMinValue(0))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('sbmvp').setDescription('Award Super Bowl MVP bonus (+250 coins) — Admin only')
    .addUserOption(o => o.setName('user').setDescription('MVP').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('givecoins').setDescription('Give coins — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('takecoins').setDescription('Take coins — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('giveitem').setDescription('Give an item to a user\'s inventory — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true))
    .addIntegerOption(o => o.setName('quantity').setDescription('How many').setRequired(true).setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('useitem').setDescription('Use/consume an item from a user\'s inventory — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true))
    .addIntegerOption(o => o.setName('quantity').setDescription('How many to use').setRequired(false).setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('bet').setDescription('Place a bet on a game')
    .addStringOption(o => o.setName('game').setDescription('Game name (e.g. Week 5 vs Team)').setRequired(true))
    .addStringOption(o => o.setName('pick').setDescription('Your pick (team or player)').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Coins to bet').setRequired(true).setMinValue(10)),
  new SlashCommandBuilder().setName('bets').setDescription('View open bets'),
  new SlashCommandBuilder().setName('resolvebet').setDescription('Resolve a bet and pay winner — Admin only')
    .addIntegerOption(o => o.setName('id').setDescription('Bet ID').setRequired(true))
    .addBooleanOption(o => o.setName('won').setDescription('Did they win?').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('shop').setDescription('View the shop'),
  new SlashCommandBuilder().setName('buy').setDescription('Buy an item from the shop')
    .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true)),
  new SlashCommandBuilder().setName('theft').setDescription('Use a Theft item')
    .addUserOption(o => o.setName('target').setDescription('User to steal from').setRequired(true)),
  new SlashCommandBuilder().setName('inventory').setDescription('View your purchased items'),
  new SlashCommandBuilder().setName('shopadd').setDescription('Add/update shop item — Admin only')
    .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true))
    .addIntegerOption(o => o.setName('price').setDescription('Price').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Description'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('shopprice').setDescription('Change shop price — Admin only')
    .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true))
    .addIntegerOption(o => o.setName('price').setDescription('New price').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('blackjack').setDescription('Blackjack (max 300)')
    .addIntegerOption(o => o.setName('bet').setDescription('Bet (10-300)').setRequired(true).setMinValue(10).setMaxValue(MAX_BET)),
  new SlashCommandBuilder().setName('coinflip').setDescription('Coinflip (max 300)')
    .addIntegerOption(o => o.setName('bet').setDescription('Bet (10-300)').setRequired(true).setMinValue(10).setMaxValue(MAX_BET))
    .addStringOption(o => o.setName('side').setDescription('heads or tails').setRequired(true)
      .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })),
  new SlashCommandBuilder().setName('dice').setDescription('Dice (max 300)')
    .addIntegerOption(o => o.setName('bet').setDescription('Bet (10-300)').setRequired(true).setMinValue(10).setMaxValue(MAX_BET))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() {
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    console.log('Cleared old global commands');
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Guild commands registered');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Global commands registered');
    }
  } catch (e) {
    console.error(e);
  }
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initDb();
  await registerCommands();
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
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const userId = interaction.user.id;

  if (interaction.commandName === 'balance') {
    const u = await getUser(userId);
    const embed = new EmbedBuilder()
      .setTitle(`${interaction.user.username}'s Balance`)
      .setColor(0x00ff00)
      .addFields(
        { name: 'Coins', value: `${u.coins}`, inline: true },
        { name: 'Record', value: `${u.wins}W - ${u.losses}L`, inline: true },
        { name: 'Streak', value: `${u.current_streak || 0}`, inline: true }
      );
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'daily') {
    const u = await getUser(userId);
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    if (u.last_daily && now - u.last_daily < day) {
      const hours = Math.ceil((day - (now - u.last_daily)) / (60 * 60 * 1000));
      return interaction.reply(`You already claimed today. Come back in ~${hours} hours.`);
    }
    const amount = Math.floor(Math.random() * 40) + 1;
    await db.execute({ sql: 'UPDATE users SET coins = coins + ?, last_daily = ? WHERE user_id = ?', args: [amount, now, userId] });
    return interaction.reply(`You claimed **${amount}** daily coins!`);
  }

  if (interaction.commandName === 'streak') {
    const u = await getUser(userId);
    return interaction.reply(`Your current win streak: **${u.current_streak || 0}**`);
  }

  if (interaction.commandName === 'pay') {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (target.id === userId) return interaction.reply('You can\'t pay yourself.');
    const u = await getUser(userId);
    if (u.coins < amount) return interaction.reply(`Not enough coins. You have ${u.coins}.`);
    await db.execute({ sql: 'UPDATE users SET coins = coins - ? WHERE user_id = ?', args: [amount, userId] });
    await addCoins(target.id, amount);
    return interaction.reply(`Sent **${amount}** coins to ${target}.`);
  }

  if (interaction.commandName === 'myitems') {
    const items = await db.execute({ sql: 'SELECT * FROM inventory WHERE user_id = ? AND quantity > 0', args: [userId] });
    if (!items.rows.length) return interaction.reply('You have no unused items.');
    const lines = items.rows.map(i => `${i.item_name} x${i.quantity}`);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Your Available Items').setDescription(lines.join('\n'))] });
  }

  if (interaction.commandName === 'stats') {
    const target = interaction.options.getUser('user') || interaction.user;
    const u = await getUser(target.id);
    const embed = new EmbedBuilder()
      .setTitle(`${target.username}'s Full Stats`)
      .setColor(0x0099ff)
      .addFields(
        { name: 'Coins', value: `${u.coins}`, inline: true },
        { name: 'Record', value: `${u.wins}W - ${u.losses}L`, inline: true },
        { name: 'Streak', value: `${u.current_streak || 0}`, inline: true },
        { name: 'Super Bowls (All-time)', value: `${u.superbowls_alltime || 0}`, inline: true },
        { name: 'Super Bowls (This Season)', value: `${u.superbowls_current || 0}`, inline: true }
      );
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'win') {
    const target = interaction.options.getUser('user');
    const u = await getUser(target.id);
    const newStreak = (u.current_streak || 0) + 1;
    const bonus = Math.min(newStreak, STREAK_CAP) * STREAK_BONUS;
    await db.execute({
      sql: 'UPDATE users SET wins = wins + 1, coins = coins + 100 + ?, current_streak = ? WHERE user_id = ?',
      args: [bonus, newStreak, target.id]
    });
    return interaction.reply(`${target} **WIN** (+100 + ${bonus} streak bonus). Streak: ${newStreak}`);
  }

  if (interaction.commandName === 'loss') {
    const target = interaction.options.getUser('user');
    await getUser(target.id);
    await db.execute({
      sql: 'UPDATE users SET losses = losses + 1, coins = coins + 50, current_streak = 0 WHERE user_id = ?',
      args: [target.id]
    });
    return interaction.reply(`${target} **LOSS** (+50 coins). Streak reset.`);
  }

  if (interaction.commandName === 'setrecord') {
    const target = interaction.options.getUser('user');
    const coins = interaction.options.getInteger('coins');
    const wins = interaction.options.getInteger('wins');
    const losses = interaction.options.getInteger('losses');
    await getUser(target.id);
    await db.execute({
      sql: 'UPDATE users SET coins = ?, wins = ?, losses = ? WHERE user_id = ?',
      args: [coins, wins, losses, target.id]
    });
    return interaction.reply(`Updated **${target.username}**: ${coins} coins, ${wins}W-${losses}L`);
  }

  if (interaction.commandName === 'setsuperbowls') {
    const target = interaction.options.getUser('user');
    const alltime = interaction.options.getInteger('alltime');
    const current = interaction.options.getInteger('current');
    await getUser(target.id);
    await db.execute({
      sql: 'UPDATE users SET superbowls_alltime = ?, superbowls_current = ? WHERE user_id = ?',
      args: [alltime, current, target.id]
    });
    return interaction.reply(`Updated **${target.username}** Super Bowls: ${alltime} AT / ${current} this season`);
  }

  if (interaction.commandName === 'sbmvp') {
    const target = interaction.options.getUser('user');
    await addCoins(target.id, 250);
    return interaction.reply(`${target} awarded **Super Bowl MVP** (+250 coins)!`);
  }

  if (interaction.commandName === 'givecoins') {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    await addCoins(target.id, amount);
    return interaction.reply(`Gave **${amount}** coins to ${target}.`);
  }

  if (interaction.commandName === 'takecoins') {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    const u = await getUser(target.id);
    const take = Math.min(amount, u.coins);
    await db.execute({ sql: 'UPDATE users SET coins = coins - ? WHERE user_id = ?', args: [take, target.id] });
    return interaction.reply(`Took **${take}** coins from ${target}.`);
  }

  if (interaction.commandName === 'giveitem') {
    const target = interaction.options.getUser('user');
    const item = interaction.options.getString('item');
    const quantity = interaction.options.getInteger('quantity');
    await getUser(target.id);
    await db.execute({
      sql: `INSERT INTO inventory (user_id, item_name, quantity) VALUES (?, ?, ?)
            ON CONFLICT(user_id, item_name) DO UPDATE SET quantity = quantity + ?`,
      args: [target.id, item, quantity, quantity]
    });
    return interaction.reply(`Gave **${quantity}x ${item}** to ${target}.`);
  }

  if (interaction.commandName === 'useitem') {
    const target = interaction.options.getUser('user');
    const item = interaction.options.getString('item');
    const quantity = interaction.options.getInteger('quantity') || 1;
    const inv = await db.execute({ sql: 'SELECT quantity FROM inventory WHERE user_id = ? AND lower(item_name) = lower(?)', args: [target.id, item] });
    if (!inv.rows.length || inv.rows[0].quantity < quantity) {
      return interaction.reply(`${target} doesn't have enough **${item}** (has ${inv.rows[0]?.quantity || 0}).`);
    }
    await db.execute({ sql: 'UPDATE inventory SET quantity = quantity - ? WHERE user_id = ? AND lower(item_name) = lower(?)', args: [quantity, target.id, item] });
    return interaction.reply(`Used **${quantity}x ${item}** from ${target}'s inventory.`);
  }

  if (interaction.commandName === 'bet') {
    const game = interaction.options.getString('game');
    const pick = interaction.options.getString('pick');
    const amount = interaction.options.getInteger('amount');
    const u = await getUser(userId);
    if (u.coins < amount) return interaction.reply(`Not enough coins. You have ${u.coins}.`);
    await db.execute({ sql: 'UPDATE users SET coins = coins - ? WHERE user_id = ?', args: [amount, userId] });
    const res = await db.execute({
      sql: 'INSERT INTO bets (user_id, game, pick, amount) VALUES (?, ?, ?, ?)',
      args: [userId, game, pick, amount]
    });
    return interaction.reply(`Bet **${amount}** on **${pick}** for "${game}" (Bet ID: ${res.lastInsertRowid})`);
  }

  if (interaction.commandName === 'bets') {
    const result = await db.execute('SELECT * FROM bets WHERE resolved = 0 ORDER BY id DESC LIMIT 10');
    if (!result.rows.length) return interaction.reply('No open bets.');
    const lines = result.rows.map(b => `**#${b.id}** ${b.game} — ${b.pick} (${b.amount} coins)`);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Open Bets').setDescription(lines.join('\n'))] });
  }

  if (interaction.commandName === 'resolvebet') {
    const id = interaction.options.getInteger('id');
    const won = interaction.options.getBoolean('won');
    const bet = await db.execute({ sql: 'SELECT * FROM bets WHERE id = ? AND resolved = 0', args: [id] });
    if (!bet.rows.length) return interaction.reply('Bet not found or already resolved.');
    const b = bet.rows[0];
    if (won) {
      await addCoins(b.user_id, b.amount * 2);
      await db.execute({ sql: 'UPDATE bets SET resolved = 1 WHERE id = ?', args: [id] });
      return interaction.reply(`Bet #${id} won! Paid ${b.amount * 2} coins.`);
    } else {
      await db.execute({ sql: 'UPDATE bets SET resolved = 1 WHERE id = ?', args: [id] });
      return interaction.reply(`Bet #${id} lost.`);
    }
  }

  if (interaction.commandName === 'shop') {
    const items = await db.execute('SELECT * FROM shop ORDER BY price');
    if (!items.rows.length) return interaction.reply('Shop is empty.');
    const lines = items.rows.map(i => `**${i.name}** — ${i.price} coins\n${i.description || ''}`);
    const embed = new EmbedBuilder().setTitle('League Shop').setDescription(lines.join('\n\n')).setColor(0xffaa00);
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'shopadd') {
    const name = interaction.options.getString('name');
    const price = interaction.options.getInteger('price');
    const desc = interaction.options.getString('description') || '';
    await db.execute({
      sql: `INSERT INTO shop (name, price, description) VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET price = excluded.price, description = excluded.description`,
      args: [name, price, desc]
    });
    return interaction.reply(`Shop item **${name}** set to ${price} coins.`);
  }

  if (interaction.commandName === 'shopprice') {
    const name = interaction.options.getString('name');
    const price = interaction.options.getInteger('price');
    const result = await db.execute({ sql: 'UPDATE shop SET price = ? WHERE lower(name) = lower(?)', args: [price, name] });
    if (result.rowsAffected === 0) return interaction.reply('Item not found.');
    return interaction.reply(`Updated **${name}** price to ${price} coins.`);
  }

  if (interaction.commandName === 'buy') {
    const itemName = interaction.options.getString('item');
    const itemResult = await db.execute({ sql: 'SELECT * FROM shop WHERE lower(name) = lower(?)', args: [itemName] });
    if (!itemResult.rows.length) return interaction.reply('Item not found.');
    const item = itemResult.rows[0];
    const u = await getUser(userId);
    if (u.coins < item.price) return interaction.reply(`Not enough coins. Need ${item.price}.`);
    await db.execute({ sql: 'UPDATE users SET coins = coins - ? WHERE user_id = ?', args: [item.price, userId] });
    await db.execute({
      sql: `INSERT INTO inventory (user_id, item_name, quantity) VALUES (?, ?, 1)
            ON CONFLICT(user_id, item_name) DO UPDATE SET quantity = quantity + 1`,
      args: [userId, item.name]
    });
    return interaction.reply(`Purchased **${item.name}**. Remaining: ${u.coins - item.price}`);
  }

  if (interaction.commandName === 'theft') {
    const target = interaction.options.getUser('target');
    if (target.id === userId) return interaction.reply('Can\'t steal from yourself.');

    const inv = await db.execute({ sql: 'SELECT quantity FROM inventory WHERE user_id = ? AND item_name = ?', args: [userId, 'Theft'] });
    if (!inv.rows.length || inv.rows[0].quantity < 1) return interaction.reply('You need a Theft item.');

    // Always consume the Theft item
    await db.execute({ sql: 'UPDATE inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_name = ?', args: [userId, 'Theft'] });

    // Check if target has Insurance
    const insurance = await db.execute({ sql: 'SELECT quantity FROM inventory WHERE user_id = ? AND item_name = ?', args: [target.id, 'Insurance'] });
    if (insurance.rows.length && insurance.rows[0].quantity > 0) {
      await db.execute({ sql: 'UPDATE inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_name = ?', args: [target.id, 'Insurance'] });
      return interaction.reply(`${target} had **Insurance**! Your theft attempt was blocked. (Insurance used up)`);
    }

    // 35% chance to steal an item instead
    const targetItems = await db.execute({ sql: 'SELECT item_name, quantity FROM inventory WHERE user_id = ? AND quantity > 0 AND item_name != ?', args: [target.id, 'Insurance'] });
    if (Math.random() < 0.35 && targetItems.rows.length > 0) {
      const randomItem = targetItems.rows[Math.floor(Math.random() * targetItems.rows.length)];
      await db.execute({ sql: 'UPDATE inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_name = ?', args: [target.id, randomItem.item_name] });
      await db.execute({
        sql: `INSERT INTO inventory (user_id, item_name, quantity) VALUES (?, ?, 1)
              ON CONFLICT(user_id, item_name) DO UPDATE SET quantity = quantity + 1`,
        args: [userId, randomItem.item_name]
      });
      return interaction.reply(`You stole **1x ${randomItem.item_name}** from ${target}!`);
    }

    // Otherwise steal coins (10-350)
    const victim = await getUser(target.id);
    if (victim.coins < 10) return interaction.reply(`${target} doesn't have enough coins to steal from.`);
    const steal = Math.min(Math.floor(Math.random() * 341) + 10, victim.coins); // 10 to 350
    await db.execute({ sql: 'UPDATE users SET coins = coins - ? WHERE user_id = ?', args: [steal, target.id] });
    await addCoins(userId, steal);
    return interaction.reply(`You stole **${steal}** coins from ${target}!`);
  }

  if (interaction.commandName === 'inventory') {
    const items = await db.execute({ sql: 'SELECT * FROM inventory WHERE user_id = ?', args: [userId] });
    if (!items.rows.length) return interaction.reply('You own nothing yet.');
    const lines = items.rows.map(i => `${i.item_name} x${i.quantity}`);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Your Inventory').setDescription(lines.join('\n'))] });
  }

  if (interaction.commandName === 'leaderboard') {
    const result = await db.execute('SELECT user_id, wins, losses, superbowls_alltime, superbowls_current FROM users WHERE (wins + losses) > 0');
    if (!result.rows.length) return interaction.reply('No records yet.');
    const sorted = result.rows
      .map(u => ({ ...u, winPct: (u.wins / (u.wins + u.losses)) * 100 }))
      .sort((a, b) => b.winPct - a.winPct || b.wins - a.wins)
      .slice(0, 15);
    const lines = await Promise.all(sorted.map(async (u, i) => {
      const member = await interaction.guild.members.fetch(u.user_id).catch(() => null);
      const name = member ? member.displayName : `User …${u.user_id.slice(-4)}`;
      return `**${i + 1}.** ${name} — ${u.wins}W-${u.losses}L (${u.winPct.toFixed(1)}%) 🏆${u.superbowls_current || 0}S/${u.superbowls_alltime || 0}AT`;
    }));
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Record Leaderboard').setDescription(lines.join('\n')).setColor(0xffd700)] });
  }

  if (interaction.commandName === 'richest') {
    const result = await db.execute('SELECT user_id, coins FROM users WHERE coins > 0 ORDER BY coins DESC LIMIT 15');
    if (!result.rows.length) return interaction.reply('No one has coins yet.');
    const lines = await Promise.all(result.rows.map(async (u, i) => {
      const member = await interaction.guild.members.fetch(u.user_id).catch(() => null);
      const name = member ? member.displayName : `User …${u.user_id.slice(-4)}`;
      return `**${i + 1}.** ${name} — ${u.coins.toLocaleString()} coins`;
    }));
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Richest Players').setDescription(lines.join('\n')).setColor(0x00ff00)] });
  }

  // Mini-games (unchanged logic)
  if (interaction.commandName === 'blackjack') {
    const bet = interaction.options.getInteger('bet');
    if (bet > MAX_BET) return interaction.reply(`Max bet is ${MAX_BET}.`);
    const u = await getUser(userId);
    if (u.coins < bet) return interaction.reply(`Not enough coins.`);
    const player = [drawCard(), drawCard()];
    const dealer = [drawCard(), drawCard()];
    const pVal = handValue(player);
    const dVal = handValue(dealer);
    let payout = 0, result = '';
    if (pVal === 21 && dVal !== 21) { result = 'Blackjack!'; payout = Math.floor(bet * 1.5); }
    else if (dVal === 21 || pVal > 21 || (pVal < dVal && dVal <= 21)) { result = 'You lose.'; payout = -bet; }
    else if (pVal > dVal || dVal > 21) { result = 'You win!'; payout = bet; }
    else { result = 'Push.'; payout = 0; }
    await addCoins(userId, payout);
    const embed = new EmbedBuilder().setTitle('Blackjack').setColor(payout > 0 ? 0x00ff00 : 0xff0000)
      .addFields(
        { name: 'You', value: player.map(c => c.rank + c.suit).join(' ') + ` (${pVal})`, inline: true },
        { name: 'Dealer', value: dealer.map(c => c.rank + c.suit).join(' ') + ` (${dVal})`, inline: true },
        { name: 'Result', value: result },
        { name: 'New Balance', value: `${u.coins + payout}` }
      );
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'coinflip') {
    const bet = interaction.options.getInteger('bet');
    const side = interaction.options.getString('side');
    if (bet > MAX_BET) return interaction.reply(`Max bet is ${MAX_BET}.`);
    const u = await getUser(userId);
    if (u.coins < bet) return interaction.reply(`Not enough coins.`);
    const flip = Math.random() < 0.5 ? 'heads' : 'tails';
    const win = flip === side;
    const payout = win ? bet : -bet;
    await addCoins(userId, payout);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Coinflip').setDescription(`Landed on **${flip}**`).setColor(win ? 0x00ff00 : 0xff0000).addFields({ name: 'Result', value: win ? 'You win!' : 'You lose.' }, { name: 'New Balance', value: `${u.coins + payout}` })] });
  }

  if (interaction.commandName === 'dice') {
    const bet = interaction.options.getInteger('bet');
    if (bet > MAX_BET) return interaction.reply(`Max bet is ${MAX_BET}.`);
    const u = await getUser(userId);
    if (u.coins < bet) return interaction.reply(`Not enough coins.`);
    const p = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
    const b = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
    let payout = p > b ? bet : p < b ? -bet : 0;
    await addCoins(userId, payout);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Dice').setDescription(`You: **${p}** | Bot: **${b}**`).setColor(payout > 0 ? 0x00ff00 : 0xff0000).addFields({ name: 'New Balance', value: `${u.coins + payout}` })] });
  }
});

client.login(TOKEN);
