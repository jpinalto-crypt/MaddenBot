# Madden League Bot

Custom Discord bot for Madden Franchise leagues. Tracks standings, schedules, advances, teams, and more. Designed to be yours — fork it, add features, deploy anywhere (Railway, Render, VPS, etc.).

## Features (v1)

- Receive data from the **Madden Companion App** export URL
- Automatic advance detection
- Slash commands:
  - `/standings` — current standings
  - `/schedule` — week schedule + results
  - `/teams` — list/assign teams to Discord users
  - `/status` — current week and last update
  - `/gamechannels` — create game channels for the week (optional)
- Modular code so you can add stats leaders, power rankings, trades, awards, notifications, etc. later

## Quick Setup

### 1. Discord Application
1. Create an application at [Discord Developer Portal](https://discord.com/developers/applications)
2. Bot → Create Bot → copy **Token**
3. Copy **Application ID** and **Public Key**
4. OAuth2 → URL Generator → scopes `bot` + `applications.commands` → invite to your server

### 2. Environment
Copy `.env.example` to `.env` and fill in:

```env
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_id
GUILD_ID=your_server_id_optional_for_faster_commands
PORT=3000
```

### 3. Run Locally
```bash
npm install
npm start
```

## Automatic Advance Detection (EA Linking)

The bot can automatically detect when you advance and pull updated data.

1. In Discord run `/link`
2. Open the EA login URL it gives you
3. After login, copy the `code=` value from the browser URL
4. Run `/link code:YOUR_CODE_HERE`
5. (Optional) `/setannounce` to choose a channel that gets notified on advances

Once linked, the bot checks every 10 minutes. Companion App exports still work as a fallback.

> Note: Full automatic roster/schedule pulling requires completing the persona + league ID steps after the initial token exchange. The current version stores the tokens and is ready for that next step; Companion App remains the most reliable import method until then.

### 5. Deploy (Railway recommended)
1. Push this folder to a GitHub repo
2. On Railway: New Project → Deploy from GitHub
3. Set the same environment variables
4. Generate a public domain
5. Set the Interactions Endpoint URL in Discord to:  
   `https://your-railway-url/interactions` (the bot handles verification)

## Adding Features Later

The code is structured so you can easily add:
- Player stats leaders
- Power rankings
- Trade voting
- Custom awards / POTW
- Notifications on advances
- Integration with your other fantasy tools

Look in `src/commands/` and `src/madden/`.

## License
MIT — yours to use and modify.
