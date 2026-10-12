# Madden Economy Bot

Discord bot for your Madden league with coin economy, shop, and mini-games.

## Features
- Admins award **100 coins** per win, **50 coins** per loss
- `/balance` to check coins
- Configurable shop (`/shop`, `/buy`)
  - Extra Trade, Dev Upgrade, Age Reduction, Contract Reduction (20%)
  - Admins can add items and change prices
- Mini-games: `/blackjack`, `/coinflip`, `/dice` (bet coins)

## Setup
1. Create a Discord application and bot at https://discord.com/developers/applications
2. Enable **Server Members Intent** under Bot → Privileged Gateway Intents
3. Invite the bot with `bot` + `applications.commands` scopes
4. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `CLIENT_ID`, and optional `GUILD_ID`
5. `npm install && npm start`

## Deploy
Push to GitHub and deploy on Render (or any Node host). Set the same environment variables.
