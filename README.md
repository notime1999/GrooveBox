# GrooveBox — Discord Music Bot

Discord music bot with YouTube and Spotify support, interactive queue controls, and audio streaming via yt-dlp and ffmpeg.

> This bot must run on a local machine or home server. It will not work correctly on datacenter/cloud hosts because YouTube actively blocks requests from datacenter IP ranges.

## Features

- YouTube: videos, playlists (up to 50 tracks), direct links, text search
- Spotify: tracks, playlists (first 10 tracks), artist top 10 — played via YouTube
- Interactive queue: Shuffle / Skip / Stop buttons on every queue message
- Auto-advance: plays next track automatically, disconnects after 2 minutes of inactivity

## Commands

| Command | Description |
|---------|-------------|
| `/play <query>` | Play a YouTube/Spotify URL or search by text |
| `/skip` | Skip the current track |
| `/stop` | Stop playback and clear the queue |
| `/queue` | Show the current queue |

`/play` accepts YouTube video/playlist URLs, Spotify track/playlist/artist URLs, and plain text search.

## Setup

### Requirements

- Node.js 20+
- Discord bot token with `bot` and `applications.commands` scopes and voice permissions
- Spotify API credentials — free at developer.spotify.com

### Installation

```bash
git clone <repo-url>
cd sexyMusic4SexyServerPublic
npm install
```

Copy `.env.example` to `.env` and fill in your credentials:

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_app_id
DISCORD_GUILD_ID=your_server_id
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
```

Deploy slash commands (once):
```bash
npm run deploy
```

Build and start:
```bash
npm start
```

### Docker

```bash
docker build -t groovebox:latest .
```

Use `docker-compose.yml` as a reference. Fill in environment variables directly in your container manager (Dockge, Portainer, etc.) — do not hardcode credentials in the compose file.

### Deploy script (optional)

`deploy.example.ps1` is a PowerShell script that automates the full deploy flow: build, export tar, upload to server via SCP, load image via SSH, and prompt to restart the stack.

Create and copy it to `deploy.ps1` and fill in your values:

```powershell
.\deploy.ps1            # build only if sources changed
.\deploy.ps1 -ForceBuild   # force rebuild
.\deploy.ps1 -SetupSudoers # one-time: configure passwordless sudo for docker on the server
```

Tested on Synology NAS with Container Manager and Dockge. Other Linux servers should work but may require adjusting `DockerBin` to match the docker binary path on your system.

## Logging with Graylog (optional)

The bot supports GELF log shipping to a Graylog instance. Graylog can be used to:

- Centralize and search all bot logs
- Set up alerts triggered by error patterns (e.g. `[ERROR]`, crashes, unhandled rejections)
- Send alert notifications to Telegram, email, Discord, or any HTTP webhook

To enable GELF log shipping, uncomment the `logging` section in `docker-compose.yml` and point it to your Graylog instance:

```yaml
logging:
  driver: gelf
  options:
    gelf-address: "udp://<your-graylog-ip>:12201"
    tag: "groovebox"
```

The bot also exposes an HTTP endpoint on port `3000` (`/alert?message=...`) that Graylog can call via HTTP Notification to post alert messages directly into a Discord channel.

## Troubleshooting

**No audio / voice connection stuck**
- Make sure `sodium-native` or `libsodium-wrappers` is installed — required for Discord DAVE encryption
- Check that outbound UDP is allowed on your host

**yt-dlp errors**
- Update yt-dlp: `yt-dlp -U`
- If running in Docker the container updates yt-dlp automatically on startup

**Spotify not working**
- Verify credentials in `.env`
- Playlist must be public

## License

MIT
