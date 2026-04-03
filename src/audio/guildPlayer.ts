import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayer, AudioPlayerStatus, NoSubscriberBehavior, entersState, VoiceConnection, VoiceConnectionStatus, StreamType, AudioResource } from '@discordjs/voice';
import { VoiceBasedChannel, Client, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { ChildProcess } from 'child_process';
import { saveQueueState } from '../utils/queueState';

export interface Track {
    url: string;
    title: string;
    requestedBy?: string;
    spotifyPlaylistId?: string;
    spotifyIndex?: number;
    spotifyName?: string;
    spotifyArtists?: string[];
    spotifyId?: string;
    source?: 'Spotify' | 'YouTube';
    thumbnail?: string;
}

export default class GuildPlayer {
    private static instances: Map<string, GuildPlayer> = new Map();
    private static youtubeMixCache: Map<string, any[]> = new Map(); // Global cache for YouTube Mix playlists
    
    guildId: string;
    voiceChannel: VoiceBasedChannel;
    connection: VoiceConnection | null = null;
    player: AudioPlayer;
    queue: any[] = [];
    currentTrack: any = null;
    queueMessageId: string | null = null;
    queueChannelId: string | null = null;
    startedBy: string = '';
    lastAction: string = '';
    _playlistTracks?: any[];
    _playlistPointer?: number;
    _playlistId?: string;
    _lastRequester?: string;
    private disconnectTimer?: NodeJS.Timeout;
    private aloneTimer?: NodeJS.Timeout;
    private voiceStateListener?: (...args: any[]) => void;
    private stopped = false;
    private activeYtdlpProcess: ChildProcess | null = null;
    private activeFFmpegProcess: ChildProcess | null = null;
    private consecutiveFailures: number = 0;
    private static readonly RESTART_THRESHOLD = 3;

    private constructor(guildId: string, voiceChannel: VoiceBasedChannel) {
        this.guildId = guildId;
        this.voiceChannel = voiceChannel;
        this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        
        // Setup player listeners ONCE in constructor - never remove them
        this.setupPlayerListeners();
    }

    static get(guildId: string) {
        return this.instances.get(guildId) ?? null;
    }

    static create(guildId: string, voiceChannel: VoiceBasedChannel) {
        let gp = this.instances.get(guildId);
        if (!gp) {
            gp = new GuildPlayer(guildId, voiceChannel);
            this.instances.set(guildId, gp);
        }
        gp.voiceChannel = voiceChannel;
        gp.stopped = false;
        gp.attachIfNeeded(voiceChannel);
        return gp;
    }

    private attachIfNeeded(voiceChannel: VoiceBasedChannel) {
        if (!this.connection) {
            console.log('[GuildPlayer] Creating new voice connection');
            this.connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator as unknown as any,
            });
            this.connection.on('stateChange', (oldState, newState) => {
                console.log(`[VoiceConnection] State: ${oldState.status} -> ${newState.status}`);
                // Log inner networking state if available
                const newNet = (newState as any).networking;
                if (newNet) {
                    console.log(`[VoiceConnection] Networking state:`, newNet.state?.code ?? newNet.state?.status ?? JSON.stringify(newNet.state)?.slice(0, 100));
                }
            });
            this.connection.on('error', (err) => {
                console.error('[VoiceConnection] Error:', err.message);
            });
            (this.connection as any).on('debug', (msg: string) => {
                console.log('[VoiceConnection DEBUG]', msg);
            });
            this.connection.subscribe(this.player);
            this.startAloneDetection();
        }
    }

    private startAloneDetection() {
        const client = this.voiceChannel.client;

        this.voiceStateListener = (_oldState: any, _newState: any) => {
            if (_oldState.guild?.id !== this.guildId && _newState.guild?.id !== this.guildId) return;
            this.checkIfAlone();
        };

        client.on('voiceStateUpdate', this.voiceStateListener);
    }

    private checkIfAlone() {
        const humanMembers = this.voiceChannel.members.filter((m: any) => !m.user.bot);

        if (humanMembers.size === 0) {
            if (!this.aloneTimer) {
                console.log('[GuildPlayer] Bot is alone in voice channel, will disconnect in 2 minutes');
                this.aloneTimer = setTimeout(() => {
                    console.log('[GuildPlayer] Bot was alone for 2 minutes, disconnecting...');
                    this.stop();
                }, 120_000);
            }
        } else {
            if (this.aloneTimer) {
                clearTimeout(this.aloneTimer);
                this.aloneTimer = undefined;
                console.log('[GuildPlayer] User joined back, cancelled alone timer');
            }
        }
    }

    private setupPlayerListeners() {
        console.log('[GuildPlayer] Setting up player listeners for guild:', this.guildId);
        
        this.player.on('stateChange', (oldState, newState) => {
            console.log(`[GuildPlayer] guild=${this.guildId} Player state: ${oldState.status} -> ${newState.status}`);
        });
        
        this.player.on(AudioPlayerStatus.Idle, () => {
            console.log(`[GuildPlayer] guild=${this.guildId} Player Idle detected - calling playNext()`);
            // Don't call playNext if stopped manually
            if (this.stopped || !this.connection) {
                console.log('[GuildPlayer] Bot is stopped or no connection, skipping playNext');
                return;
            }
            this.playNext().catch((e) => {
                console.error('[GuildPlayer] playNext error in Idle handler:', e);
            });
        });
        
        this.player.on('error', (e) => {
            console.error(`[GuildPlayer] guild=${this.guildId} Player error:`, e.message);
            
            // If terminated error, retry the current track
            if (e.message.includes('terminated') && this.currentTrack) {
                console.log(`[GuildPlayer] Stream terminated, re-adding current track to front of queue`);
                this.queue.unshift(this.currentTrack);
            }
            
            // Try to play next track on error
            this.playNext().catch(() => {});
        });
        
        console.log('[GuildPlayer] Listeners registered successfully');
    }

    enqueue(track: Track, autoPlay = true) {
        if (!track.url) {
            console.warn('[GuildPlayer] Tried to enqueue a track without url, skipping:', track);
            return;
        }
        
        // CHECK FOR DUPLICATES
        const isDuplicate = this.queue.some(t => 
            t.url === track.url || 
            (t.title && track.title && t.title.toLowerCase() === track.title.toLowerCase())
        );
        
        if (isDuplicate) {
            console.log('[GuildPlayer] Skipping duplicate:', track.title);
            return;
        }
        
        this.queue.push(track);
        console.log(`[GuildPlayer] Added to queue [${this.queue.length}]: ${track.title}`);
        
        // if nothing playing, start
        if (autoPlay && !this.currentTrack) {
            this.playNext().catch((e) => console.error('[GuildPlayer] playNext error', e));
        }
    }

    private killActiveProcesses() {
        if (this.activeYtdlpProcess) {
            try { this.activeYtdlpProcess.kill('SIGKILL'); } catch { }
            this.activeYtdlpProcess = null;
        }
        if (this.activeFFmpegProcess) {
            try { this.activeFFmpegProcess.kill('SIGKILL'); } catch { }
            this.activeFFmpegProcess = null;
        }
    }

    async stop() {
        console.log('[GuildPlayer] Stopping playback');

        // Clear timers
        if (this.disconnectTimer) {
            clearTimeout(this.disconnectTimer);
            this.disconnectTimer = undefined;
        }
        if (this.aloneTimer) {
            clearTimeout(this.aloneTimer);
            this.aloneTimer = undefined;
        }
        // Remove voiceStateUpdate listener
        if (this.voiceStateListener) {
            this.voiceChannel.client.off('voiceStateUpdate', this.voiceStateListener);
            this.voiceStateListener = undefined;
        }

        this.killActiveProcesses();
        this.queue = [];
        this.currentTrack = null;
        this.player.stop();
        
        if (this.connection) {
            this.connection.destroy();
            this.connection = null;
        }
        
        GuildPlayer.instances.delete(this.guildId);
    }

    async playNext() {
        // Check if stopped or no connection
        if (this.stopped || !this.connection) {
            console.log('[GuildPlayer] Bot is stopped or no connection, cannot play next');
            return;
        }
        
        if (this.queue.length === 0) {
            console.log('[GuildPlayer] Queue is empty');
            
            // DISCONNECT FROM VOICE CHANNEL AFTER 30 SECONDS OF INACTIVITY
            if (this.disconnectTimer) {
                clearTimeout(this.disconnectTimer);
            }
            
            this.disconnectTimer = setTimeout(() => {
                console.log('[GuildPlayer] No songs in queue for 30s, disconnecting...');
                if (this.connection) {
                    this.connection.destroy();
                    this.connection = null;
                }
                GuildPlayer.instances.delete(this.guildId);
            }, 30000);
            
            return;
        }
        
        // Clear disconnect timer if new song is played
        if (this.disconnectTimer) {
            clearTimeout(this.disconnectTimer);
            this.disconnectTimer = undefined;
        }

        // ENSURE CONNECTION AND SUBSCRIPTION BEFORE PLAYING
        if (!this.connection || 
            this.connection.state.status === VoiceConnectionStatus.Disconnected ||
            this.connection.state.status === VoiceConnectionStatus.Destroyed) {
            
            console.log('[GuildPlayer] Reconnecting to voice channel...');
            this.connection = joinVoiceChannel({
                channelId: this.voiceChannel.id,
                guildId: this.voiceChannel.guild.id,
                adapterCreator: this.voiceChannel.guild.voiceAdapterCreator as any,
            });
        }

        // ENSURE SUBSCRIPTION
        if (this.connection && this.player) {
            this.connection.subscribe(this.player);
            console.log('[GuildPlayer] Connection subscribed to player');
        }

        const track = this.queue.shift();
        if (!track) {
            console.log('[GuildPlayer] Track ended, playing next...');
            await this.playNext();
            return;
        }

        this.currentTrack = track;
        console.log('[GuildPlayer] Now playing:', track.title);
        console.log('[GuildPlayer] Track URL:', track.url);

        // VALIDATE URL
        if (!track.url || track.url === 'undefined' || track.url.startsWith('spotify:')) {
            console.error('[GuildPlayer] Invalid or missing URL for track:', track);
            await this.playNext();
            return;
        }

        let resource: AudioResource | null = null;

        if (track.source === 'Spotify' && track.spotifyName && track.spotifyArtists) {
            console.log('[GuildPlayer] Spotify track detected, searching on YouTube...');
            
            const yts = (await import('yt-search')).default;
            const query = `${track.spotifyName} ${track.spotifyArtists.join(' ')} official audio`;
            let info = null;
            
            try {
                const r = await yts(query);
                const v = r?.videos?.[0];
                if (v) info = { url: v.url, title: v.title };
            } catch (e) {
                console.error('[GuildPlayer] Failed to find YouTube URL for Spotify track:', e);
            }
            
            if (info && info.url) {
                track.url = info.url;
                console.log('[GuildPlayer] Found YouTube URL:', info.url);
            } else {
                console.error('[GuildPlayer] Could not find YouTube URL for:', track.title);
                await this.playNext();
                return;
            }
        }

        // VALIDATE URL AGAIN AFTER SPOTIFY SEARCH
        if (!track.url || track.url === 'undefined' || track.url.startsWith('spotify:')) {
            console.error('[GuildPlayer] Still invalid URL after processing:', track.url);
            await this.playNext();
            return;
        }

        // Kill any processes from the previous track before starting new ones
        this.killActiveProcesses();

        // RETRY LOGIC FOR STREAMING
        let retries = 3;

        while (retries > 0) {
            try {
                console.log('[GuildPlayer] Calling streamWithYoutubeDl with URL:', track.url, `(attempt ${4 - retries}/3)`);
                const { streamWithYoutubeDl } = await import('../commands/play');
                const streamResult = await streamWithYoutubeDl(track.url);
                this.activeYtdlpProcess = streamResult.ytdlpProcess;
                this.activeFFmpegProcess = streamResult.ffmpegProcess;
                
                if (!streamResult.stream) {
                    throw new Error('Stream is null or undefined');
                }
                
                resource = createAudioResource(streamResult.stream, {
                    inputType: StreamType.OggOpus,
                });

                // Add error handlers
                streamResult.stream.on('error', (err: any) => {
                    // Ignore "Premature close" errors - these happen during skip and are normal
                    if (err.message?.includes('Premature close')) {
                        return;
                    }
                    console.error('[GuildPlayer] Stream error:', err.message);
                });

                streamResult.stream.on('end', () => {
                    // Stream ended naturally
                });

                streamResult.stream.on('close', () => {
                    // Stream closed
                });

                this.consecutiveFailures = 0; // Reset on success
                console.log('[GuildPlayer] Created audio resource from youtube-dl-exec');
                break; // Success, exit retry loop

            } catch (err: any) {
                retries--;
                console.error(`[GuildPlayer] Attempt ${4 - retries - 1} failed:`, err.message);

                if (retries > 0) {
                    console.log(`[GuildPlayer] Retrying in 2 seconds... (${retries} attempts left)`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } else {
                    this.consecutiveFailures++;
                    console.error(`[GuildPlayer] All retry attempts failed, skipping track (consecutive failures: ${this.consecutiveFailures}/${GuildPlayer.RESTART_THRESHOLD})`);

                    if (this.consecutiveFailures >= GuildPlayer.RESTART_THRESHOLD) {
                        await this.triggerRestart();
                        return;
                    }

                    await this.playNext();
                    return;
                }
            }
        }

        if (!resource) {
            console.error('[GuildPlayer] Failed to create resource after retries');
            await this.playNext();
            return;
        }

        // Wait for voice connection to be ready before playing
        try {
            console.log(`[GuildPlayer] Waiting for voice connection to be Ready... (current: ${this.connection?.state.status})`);
            await entersState(this.connection!, VoiceConnectionStatus.Ready, 20_000);
            console.log('[GuildPlayer] Voice connection is Ready, starting playback');
        } catch (e) {
            console.error('[GuildPlayer] Voice connection NEVER became Ready! Likely a firewall/network issue blocking UDP to Discord.');
            await this.notifyChannel('❌ Il bot non riesce a connettersi al canale vocale. Controlla il firewall di Windows — devi consentire Node.js per le reti private e pubbliche.');
            this.queue = [];
            this.currentTrack = null;
            return;
        }

        this.player.play(resource);
        console.log(`[GuildPlayer] guild=${this.guildId} ▶️ Started playing:`, track.title);
        console.log(`[GuildPlayer] guild=${this.guildId} Player status after play():`, this.player.state.status);
        
        // LOAD ONE MORE TRACK FROM SPOTIFY PLAYLIST IF QUEUE IS LOW
        if (this.queue.length < 10 && this._playlistTracks && this._playlistPointer !== undefined && this._playlistPointer < this._playlistTracks.length) {
            console.log(`[GuildPlayer] Queue has ${this.queue.length} tracks, loading one more from playlist (${this._playlistPointer + 1}/${this._playlistTracks.length})`);
            
            const t = this._playlistTracks[this._playlistPointer];
            const newTrack = {
                url: t.url || `spotify:track:${t.id}`,
                title: `${t.name} - ${t.artists.join(', ')}`,
                spotifyPlaylistId: this._playlistId,
                spotifyIndex: this._playlistPointer,
                spotifyName: t.name,
                spotifyArtists: t.artists,
                spotifyId: t.id,
                requestedBy: this._lastRequester,
                source: 'Spotify' as const,
                thumbnail: t.album?.images?.[0]?.url
            };
            
            this._playlistPointer++;
            this.enqueue(newTrack, false);
            console.log(`[GuildPlayer] Loaded track ${this._playlistPointer}/${this._playlistTracks.length}: ${newTrack.title} (queue now: ${this.queue.length})`);
        }
        
        // Update queue message embed
        await this.updateQueueMessage();
    }

    skip(): Track | null | false {
        if (!this.player) return false;
        try {
            console.log(`[GuildPlayer] Skipping current track. Queue size: ${this.queue.length}, Next: ${this.queue[0]?.title || 'none'}`);
            this.player.stop(true);
            return this.queue[0] ?? null;
        } catch (e) {
            console.error('[GuildPlayer] skip error', e);
            return false;
        }
    }

    getQueue() {
        return this.queue.filter(t => !!t.url && !!t.title && t.title !== 'undefined');
    }

    getCurrent() {
        return this.currentTrack;
    }

    async shuffleQueue(forceSimple = false) {
        if (!this.ensureVoiceConnection()) {
            console.error('[GuildPlayer] Cannot shuffle: not connected to voice channel');
            return;
        }

        if (!forceSimple && this._playlistTracks && Array.isArray(this._playlistTracks) && this._playlistTracks.length > 0) {
            console.log('[GuildPlayer] Shuffling entire Spotify playlist:', this._playlistTracks.length, 'tracks');

            // Shuffle the entire playlist array
            for (let i = this._playlistTracks.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this._playlistTracks[i], this._playlistTracks[j]] = [this._playlistTracks[j], this._playlistTracks[i]];
            }

            // Clear current queue and reload 10 tracks from shuffled playlist
            this.queue = [];
            this._playlistPointer = 0;

            const MAX_TRACKS = 10;
            const tracksToEnqueue: any[] = [];

            for (let i = 0; i < this._playlistTracks.length && tracksToEnqueue.length < MAX_TRACKS; i++) {
                const t = this._playlistTracks[i];
                tracksToEnqueue.push({
                    url: t.url || `spotify:track:${t.id}`,
                    title: `${t.name} - ${t.artists.join(', ')}`,
                    spotifyPlaylistId: this._playlistId,
                    spotifyIndex: i,
                    spotifyName: t.name,
                    spotifyArtists: t.artists,
                    spotifyId: t.id,
                    requestedBy: this._lastRequester,
                    source: 'Spotify',
                    thumbnail: t.album?.images?.[0]?.url
                });

                this._playlistPointer = i + 1;
            }

            for (const track of tracksToEnqueue) {
                this.enqueue(track, false);
            }

            console.log('[GuildPlayer] Shuffled playlist, loaded', tracksToEnqueue.length, 'new tracks from shuffled playlist. Current track continues playing.');
        } else {
            console.log('[GuildPlayer] Shuffling current queue:', this.queue.length, 'tracks');

            for (let i = this.queue.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
            }

            console.log('[GuildPlayer] Queue shuffled. Current track continues playing.');
        }
    }

    public async deleteQueueMessage(client: Client) {
        if (this.queueMessageId && this.queueChannelId) {
            try {
                const channel = await client.channels.fetch(this.queueChannelId);
                if (channel && channel.isTextBased()) {
                    const msg = await channel.messages.fetch(this.queueMessageId);
                    await msg.delete();
                }
            } catch { }
            this.queueMessageId = null;
            this.queueChannelId = null;
        }
    }

    public async updateQueueMessage() {
        if (!this.queueMessageId || !this.queueChannelId) {
            return; // No message to update
        }

        try {
            const client = this.voiceChannel.client as any;
            
            const channel = await client.channels.fetch(this.queueChannelId);
            if (!channel || !channel.isTextBased()) {
                return;
            }

            const msg = await channel.messages.fetch(this.queueMessageId);
            
            // Build updated embed
            const { buildQueueList } = await import('../commands/play');
            
            const nowPlaying = this.getCurrent();
            const maxQueueToShow = 10;
            const more = this.queue.length > maxQueueToShow ? `\n...and ${this.queue.length - maxQueueToShow} more` : '';
            let queueStr = buildQueueList(this.queue.slice(0, maxQueueToShow)) + more;
            if (!queueStr.trim()) queueStr = 'No tracks in queue.';
            if (queueStr.length > 1024) queueStr = queueStr.slice(0, 1021) + '...';

            const fields = [
                { name: 'Now playing', value: nowPlaying?.title ?? 'Nothing' },
                { name: 'Queue', value: queueStr },
                { name: 'Started by', value: this.startedBy || 'Unknown', inline: true }
            ];
            if (this.lastAction) {
                fields.push({ name: 'Last action', value: this.lastAction, inline: true });
            }

            const embed = new EmbedBuilder()
                .setTitle('Music Queue')
                .addFields(fields)
                .setColor(0x00FF00);

            if (nowPlaying?.thumbnail) {
                embed.setThumbnail(nowPlaying.thumbnail);
            } else if (nowPlaying?.url && nowPlaying.url.includes('youtube.com')) {
                const videoId = nowPlaying.url.match(/[?&]v=([^&]+)/)?.[1];
                if (videoId) {
                    embed.setThumbnail(`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`);
                }
            }

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('shuffle').setLabel('Shuffle').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger)
            );

            await msg.edit({ embeds: [embed], components: [row] });
            console.log('[GuildPlayer] Queue message updated');
        } catch (err) {
            console.error('[GuildPlayer] Failed to update queue message:', err);
        }
    }

    private async triggerRestart(): Promise<void> {
        console.log('[GuildPlayer] Too many consecutive failures — saving queue and restarting...');

        // Save remaining queue — skip currentTrack since it's the one that caused failures
        const tracksToSave = [...this.queue];

        saveQueueState({
            guildId: this.guildId,
            voiceChannelId: this.voiceChannel.id,
            queueChannelId: this.queueChannelId,
            queue: tracksToSave,
            currentTrack: null,
            startedBy: this.startedBy,
            lastAction: this.lastAction,
            _playlistTracks: this._playlistTracks,
            _playlistPointer: this._playlistPointer,
            _playlistId: this._playlistId,
            _lastRequester: this._lastRequester,
        });

        await this.notifyChannel(
            '⚠️ **YouTube sta bloccando lo streaming.** Sto riavviando per ripristinare la connessione...\n' +
            '🔁 La coda verrà ripristinata automaticamente tra qualche secondo!'
        );

        // Small delay so the message is sent before we exit
        await new Promise(resolve => setTimeout(resolve, 2000));
        process.exit(1);
    }

    private async notifyChannel(message: string): Promise<void> {
        try {
            if (!this.queueChannelId) return;
            const channel = await this.voiceChannel.client.channels.fetch(this.queueChannelId);
            if (channel && channel.isTextBased()) {
                await (channel as any).send(message);
            }
        } catch (e) {
            console.error('[GuildPlayer] Failed to send channel notification:', e);
        }
    }

    public resetQueue() {
        this.queue = [];
        this.currentTrack = null;
        if (this.player) {
            this.player.stop(true);
        }
    }

    public ensureVoiceConnection(): boolean {
        if (!this.voiceChannel) {
            console.log('[GuildPlayer] No voice channel set');
            return false;
        }

        const currentState = this.connection?.state.status;

        if (!this.connection ||
            currentState === VoiceConnectionStatus.Disconnected ||
            currentState === VoiceConnectionStatus.Destroyed) {

            console.log('[GuildPlayer] Reconnecting to voice channel:', this.voiceChannel.name);

            try {
                this.connection = joinVoiceChannel({
                    channelId: this.voiceChannel.id,
                    guildId: this.voiceChannel.guild.id,
                    adapterCreator: this.voiceChannel.guild.voiceAdapterCreator as any,
                });

                this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    console.log('[GuildPlayer] Voice connection disconnected');
                    try {
                        await Promise.race([
                            entersState(this.connection!, VoiceConnectionStatus.Signalling, 5_000),
                            entersState(this.connection!, VoiceConnectionStatus.Connecting, 5_000),
                        ]);
                    } catch (error) {
                        console.log('[GuildPlayer] Voice connection destroyed after timeout');
                        this.connection?.destroy();
                    }
                });

                if (this.player) {
                    this.connection.subscribe(this.player);
                }
                return true;
            } catch (e) {
                console.error('[GuildPlayer] Failed to reconnect:', e);
                return false;
            }
        }

        return true;
    }
}