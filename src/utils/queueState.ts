import fs from 'fs';
import path from 'path';

const STATE_FILE = process.platform === 'win32'
    ? path.join(process.cwd(), 'data', 'queue-state.json')
    : '/app/data/queue-state.json';

export interface QueueState {
    guildId: string;
    voiceChannelId: string;
    queueChannelId: string | null;
    queue: any[];
    currentTrack: any;
    startedBy: string;
    lastAction: string;
    _playlistTracks?: any[];
    _playlistPointer?: number;
    _playlistId?: string;
    _lastRequester?: string;
}

export function saveQueueState(state: QueueState): void {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
        console.log('[queueState] Saved queue state to', STATE_FILE);
    } catch (e) {
        console.error('[queueState] Failed to save queue state:', e);
    }
}

export function loadQueueState(): QueueState | null {
    try {
        if (!fs.existsSync(STATE_FILE)) return null;
        const data = fs.readFileSync(STATE_FILE, 'utf8');
        const state = JSON.parse(data) as QueueState;
        console.log('[queueState] Loaded queue state:', state.guildId, '| tracks:', state.queue.length);
        return state;
    } catch (e) {
        console.error('[queueState] Failed to load queue state:', e);
        return null;
    }
}

export function clearQueueState(): void {
    try {
        if (fs.existsSync(STATE_FILE)) {
            fs.unlinkSync(STATE_FILE);
            console.log('[queueState] Queue state cleared');
        }
    } catch (e) {
        console.error('[queueState] Failed to clear queue state:', e);
    }
}
