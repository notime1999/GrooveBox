import http from 'http';
import https from 'https';
import { Client, TextChannel } from 'discord.js';

const ALERT_PORT = 3000;
const ALERT_CHANNEL_NAME = 'bot_channel';

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', () => resolve(''));
    });
}

// Costruisce il messaggio finale: testo statico da env + info chiave estratte dal payload
function buildMessage(queryMessage: string | null, body: string): string {
    const staticText = process.env.ALERT_MESSAGE || 'Errore rilevato! Controlla il bot.';

    // Messaggio diretto via query param (es. Uptime Kuma)
    if (queryMessage) return `${staticText}\n${queryMessage}`;

    // Payload JSON di Graylog
    if (body) {
        try {
            const p = JSON.parse(body);
            const event = p.event || {};
            const ts = event.timestamp
                ? new Date(event.timestamp).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })
                : new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
            const title   = p.event_definition_title || 'N/A';
            const eventMsg = event.message || 'N/A';

            return `${staticText}\nOra: ${ts}\nEvento: ${title}\nMessaggio: ${eventMsg}`;
        } catch {
            return `${staticText}\n${body.slice(0, 300)}`;
        }
    }

    return staticText;
}

function sendTelegram(message: string): Promise<void> {
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return Promise.resolve();

    const body = JSON.stringify({ chat_id: chatId, text: `[ALERT] ${message}` });
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${token}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, () => resolve());
        req.on('error', (e) => { console.error('[alertServer] Telegram error:', e.message); resolve(); });
        req.write(body);
        req.end();
    });
}

export function startAlertServer(client: Client) {
    const server = http.createServer(async (req, res) => {
        if (!req.url?.startsWith('/alert')) {
            res.writeHead(404);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://localhost:${ALERT_PORT}`);
        const rawBody = await readBody(req);
        const message = buildMessage(url.searchParams.get('message'), rawBody);

        try {
            const guild = client.guilds.cache.first();
            if (!guild) throw new Error('Guild not found');

            const channel = guild.channels.cache.find(
                c => c.isTextBased() && c.name === ALERT_CHANNEL_NAME
            ) as TextChannel | undefined;

            if (!channel) throw new Error(`Channel '${ALERT_CHANNEL_NAME}' not found`);

            await Promise.all([
                channel.send(`**[ALERT]**\n${message}`),
                sendTelegram(message),
            ]);

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
