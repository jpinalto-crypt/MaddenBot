require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { createClient } = require('@libsql/client');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`Health server on ${PORT}`));

const MAX_BET = 300;

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
      superbowls_current INTEGER DEFAULT 0
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

  // Add columns if they don't exist yet (for existing databases)
  try {
    await db.execute('ALTER TABLE users ADD COLUMN superbowls_alltime INTEGER DEFAULT 0');
  } catch (e) {}
  try {
    await db.execute('ALTER TABLE users ADD COLUMN superbowls_current INTEGER DEFAULT 0');
  } catch (e) {}

  // Clear and re-seed shop with the exact items you want
  await db.execute('DELETE FROM shop');
  await db.batch([
    { sql: 'INSERT INTO shop (name, price, description) VALUES (?, ?, ?)', args: ['Theft', 95, 'Attempt to steal 1-200 coins from another user'] },
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
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your coin balance and record'),
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('View full stats for a user')
    .addUserOption(o => o.setName('user').setDescription('User (leave blank for yourself)')),
  new SlashCommandBuilder()
    .setName('records')
    .setDescription('Leaderboard sorted by win/loss record + Super Bowl trophies'),
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
    .setName('setrecord')
    .setDescription('Set a user\'s full coins/wins/losses — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .addIntegerOption(o => o.setName('coins').setDescription('Total coins').setRequired(true).setMinValue(0))
    .addIntegerOption(o => o.setName('wins').setDescription('Total wins').setRequired(true).setMinValue(0))
    .addIntegerOption(o => o.setName('losses').setDescription('Total losses').setRequired(true).setMinValue(0))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('setsuperbowls')
    .setDescription('Set Super Bowl counts — Admin only')
    .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
    .addIntegerOption(o => o.setName('alltime').setDescription('All-time Super Bowls').setRequired(true).setMinValue(0))
    .addIntegerOption(o => o.setName('current').setDescription('This season Super Bowls').setRequired(true).setMinValue(0))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('shop')
    .setDescription('View the shop'),
  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Buy an item from the shop')
    .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('theft')
    .setDescription('Use a Theft item to try stealing coins from someone')
    .addUserOption(o => o.setName('target').setDescription('User to steal from').setRequired(true)),
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
    .setDescription('Play blackjack and bet coins (max 300)')
    .addIntegerOption(o => o.setName('bet').setDescription('Amount to bet (10-300)').setRequired(true).setMinValue(10).setMaxValue(MAX_BET)),
  new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Flip a coin and bet coins (max 300)')
    .addIntegerOption(o => o.setName('bet').setDescription('Amount to bet (10-300)').setRequired(true).setMinValue(10).setMaxValue(MAX_BET))
    .addStringOption(o => o.setName('side').setDescription('heads or tails').setRequired(true)
      .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })),
  new SlashCommandBuilder()
    .setName('dice')
    .setDescription('Roll dice and bet coins (higher than bot wins, max 300)')
    .addIntegerOption(o => o.setName('bet').setDescription('Amount to bet (10-300)').setRequired(true).setMinValue(10).setMaxValue(MAX_BET)),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Record leaderboard sorted by win percentage (shows Super Bowls)')
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

  if (interaction.commandName === 'stats') {
    const target = interaction.options.getUser('user') || interaction.user;
    const u = await getUser(target.id);
    const embed = new EmbedBuilder()
      .setTitle(`${target.username}'s Full Stats`)
      .setColor(0x0099ff)
      .addFields(
        { name: 'Coins', value: `${u.coins}`, inline: true },
        { name: 'Record', value: `${u.wins}W - ${u.losses}L`, inline: true },
        { name: 'Super Bowls (All-time)', value: `${u.superbowls_alltime || 0}`, inline: true },
        { name: 'Super Bowls (This Season)', value: `${u.superbowls_current || 0}`, inline: true }
      );
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'records') {
    const result = await db.execute(`
      SELECT user_id, wins, losses, superbowls_alltime, superbowls_current
      FROM users
      WHERE wins > 0 OR losses > 0
      ORDER BY wins DESC, (wins * 1.0 / (wins + losses)) DESC
      LIMIT 15
    `);

    if (!result.rows.length) return interaction.reply('No records yet.');

    const lines = [];
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i];
      let name = `<@${row.user_id}>`;
      try {
        const member = await interaction.guild.members.fetch(row.user_id);
        name = member.displayName || member.user.username;
      } catch {}
      const total = row.wins + row.losses;
      const pct = total > 0 ? ((row.wins / total) * 100).toFixed(1) : '0.0';
      const trophies = `🏆 ${row.superbowls_current || 0} current · ${row.superbowls_alltime || 0} all-time`;
      lines.push(`**${i + 1}.** ${name} — ${row.wins}W-${row.losses}L (${pct}%)\n${trophies}`);
    }

    const embed = new EmbedBuilder()
      .setTitle('Record Leaderboard')
      .setDescription(lines.join('\n\n'))
      .setColor(0xffd700)
      .setFooter({ text: 'Sorted by wins, then win %' });
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'win') {
    const target = interaction.options.getUser('user');
    await getUser(target.id);
    await db.execute({ sql: 'UPDATE users SET wins = wins + 1, coins = coins + 100 WHERE user_id = ?', args: [target.id] });
    const u = await getUser(target.id);
    return interaction.reply(`${target} recorded a **WIN** (+100 coins). New balance: ${u.coins}`);
  }

  if (interaction.commandName === 'loss') {
    const target = interaction.options.getUser('user');
    await getUser(target.id);
    await db.execute({ sql: 'UPDATE users SET losses = losses + 1, coins = coins + 50 WHERE user_id = ?', args: [target.id] });
    const u = await getUser(target.id);
    return interaction.reply(`${target} recorded a **LOSS** (+50 coins). New balance: ${u.coins}`);
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
    return interaction.reply(`Updated **${target.username}**: ${coins} coins, ${wins}W - ${losses}L`);
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
    return interaction.reply(`Updated **${target.username}** Super Bowls: ${alltime} all-time, ${current} this season`);
  }

  if (interaction.commandName === 'shop') {
    const items = await db.execute('SELECT * FROM shop ORDER BY price');
    if (!items.rows.length) return interaction.reply('Shop is empty.');
    const lines = items.rows.map(i => `**${i.name}** — ${i.price} coins\n${i.description || ''}`);
    const embed = new EmbedBuilder()
      .setTitle('League Shop')
      .setDescription(lines.join('\n\n'))
      .setColor(0xffaa00)
      .setFooter({ text: 'Use /buy item:<name>' });
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'buy') {
    const itemName = interaction.options.getString('item');
    const itemResult = await db.execute({ sql: 'SELECT * FROM shop WHERE lower(name) = lower(?)', args: [itemName] });
    if (!itemResult.rows.length) return interaction.reply('Item not found. Check /shop');
    const item = itemResult.rows[0];
    const u = await getUser(userId);
    if (u.coins < item.price) return interaction.reply(`Not enough coins. You have ${u.coins}, need ${item.price}.`);
    await db.execute({ sql: 'UPDATE users SET coins = coins - ? WHERE user_id = ?', args: [item.price, userId] });
    await db.execute({
      sql: `INSERT INTO inventory (user_id, item_name, quantity) VALUES (?, ?, 1)
            ON CONFLICT(user_id, item_name) DO UPDATE SET quantity = quantity + 1`,
      args: [userId, item.name]
    });
    const newBal = u.coins - item.price;
    return interaction.reply(`Purchased **${item.name}** for ${item.price} coins. Remaining: ${newBal}`);
  }

  if (interaction.commandName === 'theft') {
    const target = interaction.options.getUser('target');
    if (target.id === userId) return interaction.reply('You can\'t steal from yourself.');
    const inv = await db.execute({ sql: 'SELECT quantity FROM inventory WHERE user_id = ? AND item_name = ?', args: [userId, 'Theft'] });
    if (!inv.rows.length || inv.rows[0].quantity < 1) return interaction.reply('You need a Theft item. Buy one from /shop.');
    const victim = await getUser(target.id);
    if (victim.coins < 1) return interaction.reply(`${target.username} has no coins to steal.`);

    const stealAmount = Math.floor(Math.random() * 200) + 1;
    const actual = Math.min(stealAmount, victim.coins);
    await db.execute({ sql: 'UPDATE users SET coins = coins - ? WHERE user_id = ?', args: [actual, target.id] });
    await addCoins(userId, actual);
    await db.execute({ sql: 'UPDATE inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_name = ?', args: [userId, 'Theft'] });

    return interaction.reply(`You used Theft and stole **${actual}** coins from ${target}!`);
  }

  if (interaction.commandName === 'inventory') {
    const items = await db.execute({ sql: 'SELECT * FROM inventory WHERE user_id = ?', args: [userId] });
    if (!items.rows.length) return interaction.reply('You own nothing yet.');
    const lines = items.rows.map(i => `${i.item_name} x${i.quantity}`);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Your Inventory').setDescription(lines.join('\n'))] });
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

  if (interaction.commandName === 'blackjack') {
    const bet = interaction.options.getInteger('bet');
    if (bet > MAX_BET) return interaction.reply(`Max bet is ${MAX_BET} coins.`);
    const u = await getUser(userId);
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

    await addCoins(userId, payout);
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
    if (bet > MAX_BET) return interaction.reply(`Max bet is ${MAX_BET} coins.`);
    const side = interaction.options.getString('side');
    const u = await getUser(userId);
    if (u.coins < bet) return interaction.reply(`Not enough coins. You have ${u.coins}.`);

    const flip = Math.random() < 0.5 ? 'heads' : 'tails';
    const win = flip === side;
    const payout = win ? bet : -bet;
    await addCoins(userId, payout);

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

  if (interaction.commandName === 'leaderboard') {
    const result = await db.execute('SELECT user_id, wins, losses, superbowls_alltime, superbowls_current FROM users WHERE (wins + losses) > 0');
    if (!result.rows.length) return interaction.reply('No records yet.');

    const sorted = result.rows
      .map(u => {
        const total = u.wins + u.losses;
        const winPct = total > 0 ? (u.wins / total) * 100 : 0;
        return { ...u, winPct, total };
      })
      .sort((a, b) => b.winPct - a.winPct || b.wins - a.wins)
      .slice(0, 15);

    const lines = await Promise.all(sorted.map(async (u, i) => {
      const member = await interaction.guild.members.fetch(u.user_id).catch(() => null);
      const name = member ? member.displayName : `User ${u.user_id.slice(-4)}`;
      const trophies = `🏆${u.superbowls_current || 0} (S) / ${u.superbowls_alltime || 0} (AT)`;
      return `**${i + 1}.** ${name} — ${u.wins}W-${u.losses}L (${u.winPct.toFixed(1)}%) ${trophies}`;
    }));

    const embed = new EmbedBuilder()
      .setTitle('Record Leaderboard')
      .setDescription(lines.join('\n'))
      .setColor(0xffd700)
      .setFooter({ text: 'Sorted by win % • 🏆 = Super Bowls (S = this season, AT = all-time)' });

    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'dice') {
    const bet = interaction.options.getInteger('bet');
    if (bet > MAX_BET) return interaction.reply(`Max bet is ${MAX_BET} coins.`);
    const u = await getUser(userId);
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
    await addCoins(userId, payout);

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
