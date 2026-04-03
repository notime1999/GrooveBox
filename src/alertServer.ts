import http from 'http';
import { Client, TextChannel } from 'discord.js';

const ALERT_PORT = 3000;
// Change this to the name of the Discord text channel where alerts should be posted
const ALERT_CHANNEL_NAME = 'bot_channel';

export function startAlertServer(client: Client) {
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'GET' || !req.url?.startsWith('/alert')) {
            res.writeHead(404);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://localhost:${ALERT_PORT}`);
        const message = url.searchParams.get('message') || 'Error detected on the bot!';

        try {
            const guild = client.guilds.cache.first();
            if (!guild) throw new Error('Guild not found');

            const channel = guild.channels.cache.find(
                c => c.isTextBased() && c.name === ALERT_CHANNEL_NAME
            ) as TextChannel | undefined;

            if (!channel) throw new Error(`Channel '${ALERT_CHANNEL_NAME}' not found`);

            await channel.send(`**[ALERT]** ${message}`);
            res.writeHead(200);
            res.end('OK');
        } catch (e) {
            console.error('[alertServer] Error sending alert:', e);
            res.writeHead(500);
            res.end('Error');
        }
    });

    server.listen(ALERT_PORT, () => {
        console.log(`[alertServer] Listening on port ${ALERT_PORT}`);
    });
}
