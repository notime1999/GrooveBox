import { ChatInputCommandInteraction, GuildMember, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { joinVoiceChannel } from '@discordjs/voice';
import { searchSpotify, searchYouTube as searchSpotifyYT, getPlaylistTracks, ensureSpotifyToken } from '../services/spotify';
import spotifyApi from '../services/spotify';
// @ts-ignore
import yts from 'yt-search';
import youtubedl from 'youtube-dl-exec';
import path from 'path';
import GuildPlayer from '../audio/guildPlayer';
import { spawn } from 'child_process';
import { Readable, PassThrough } from 'stream';
// @ts-ignore
import ffmpegPath from 'ffmpeg-static';
import { ChildProcess } from 'child_process';

export const execute = async (interaction: ChatInputCommandInteraction, args: string[] = []) => {
    // DEFER IMMEDIATELY - FIRST THING!
    try {
        await interaction.deferReply();
    } catch (e) {
        console.error('[play] Failed to defer reply:', e);
        return;
    }

    console.log("EXECUTING PLAY", Date.now(), interaction.id, interaction.commandName, args);
    let query = args.join(' ').trim();

    const ytPlaylistMatch = query.match(/[?&]list=([A-Za-z0-9_-]+)/);
    const playlistId = ytPlaylistMatch ? ytPlaylistMatch[1] : null;
    const isYouTubePlaylist = query.includes('youtube.com/playlist') || (query.includes('youtube.com/watch') && query.includes('&list='));
    const isSpotifyPlaylist = query.includes('open.spotify.com') && query.includes('/playlist');
    const isSpotifyArtist = query.includes('open.spotify.com') && /\/artist\//.test(query);

    console.log('[play] query=', query, 'isYouTubePlaylist=', isYouTubePlaylist, 'isSpotifyPlaylist=', isSpotifyPlaylist, 'isSpotifyArtist=', isSpotifyArtist);

    // Check if user is in voice channel AFTER defer
    const member = interaction.member as GuildMember;
    if (!member || !member.voice?.channel) {
        return interaction.editReply('You must be in a voice channel to play music.');
    }

    let replyUpdated = false;

    setTimeout(async () => {
        if (!replyUpdated) {
            try {
                await interaction.deleteReply();
            } catch { }
        }
    }, 60000);

    if (isYouTubePlaylist) {
        console.log('[play] YouTube playlist ID:', playlistId);

        try {
            const gp = GuildPlayer.create(interaction.guild!.id, member.voice.channel);
            
            // Check if this YouTube Mix is already cached
            let videos: any[] = [];
            const isYouTubeMix = playlistId?.startsWith('RD');
            
            if (isYouTubeMix && (GuildPlayer as any).youtubeMixCache?.has(playlistId!)) {
                videos = (GuildPlayer as any).youtubeMixCache.get(playlistId!)!;
                console.log('[play] Using cached YouTube Mix with', videos.length, 'videos');
            } else {
                // Use youtube-dl-exec to get playlist info
                const playlistInfo: any = await youtubedl(query, {
                    dumpSingleJson: true,
                    noWarnings: true,
                    flatPlaylist: true,
                    skipDownload: true,
                    playlistEnd: 50  // LIMIT TO 50 VIDEOS MAX
                });

                videos = playlistInfo?.entries || [];
                console.log('[play] Found', videos.length, 'videos in YouTube playlist');
                
                // Cache YouTube Mix for future use
                if (isYouTubeMix && playlistId && videos.length > 0) {
                    (GuildPlayer as any).youtubeMixCache.set(playlistId, videos);
                    console.log('[play] Cached YouTube Mix:', playlistId);
                }
            }

            if (videos.length === 0) {
                return interaction.editReply('❌ No videos found in playlist.');
            }

            gp.startedBy = interaction.user.username;
            gp.lastAction = `YouTube playlist with ${videos.length} songs`;

            for (const video of videos) {
                if (!video || !video.id) continue;

                // Get best thumbnail URL
                let thumbnail = `https://img.youtube.com/vi/${video.id}/maxresdefault.jpg`;
                if (video.thumbnail) {
                    thumbnail = video.thumbnail;
                } else if (video.thumbnails && video.thumbnails.length > 0) {
                    thumbnail = video.thumbnails[video.thumbnails.length - 1].url;
                }

                const track = {
                    url: `https://www.youtube.com/watch?v=${video.id}`,
                    title: video.title || video.id || 'Unknown Title',
                    requestedBy: interaction.user.username,
                    source: 'YouTube' as const,
                    thumbnail: thumbnail
                };

                gp.enqueue(track, false);
            }

            await gp.playNext();

            // DELETE OLD QUEUE MESSAGE
            await gp.deleteQueueMessage(interaction.client);

            // BUILD EMBED
            const nowPlaying = gp.getCurrent();
            const maxQueueToShow = 10;
            const more = gp.queue.length > maxQueueToShow ? `\n...and ${gp.queue.length - maxQueueToShow} more` : '';
            let queueStr = buildQueueList(gp.queue.slice(0, maxQueueToShow)) + more;
            if (!queueStr.trim()) queueStr = 'No tracks in queue.';
            if (queueStr.length > 1024) queueStr = queueStr.slice(0, 1021) + '...';

            const fields = [
                { name: 'Now playing', value: nowPlaying?.title ?? 'Nothing' },
                { name: 'Queue', value: queueStr },
                { name: 'Started by', value: gp.startedBy || 'Unknown', inline: true }
            ];
            if (gp.lastAction) {
                fields.push({ name: 'Last action', value: gp.lastAction, inline: true });
            }

            const embed = new EmbedBuilder()
                .setTitle('Music Queue')
                .addFields(fields)
                .setColor(0x00FF00);

            // Always set thumbnail from now playing
            if (nowPlaying?.thumbnail) {
                embed.setThumbnail(nowPlaying.thumbnail);
            }

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('shuffle').setLabel('Shuffle').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger)
            );

            await interaction.editReply({ embeds: [embed], components: [row] });
            replyUpdated = true;
            const sent = await interaction.fetchReply();
            gp.queueMessageId = sent.id;
            gp.queueChannelId = sent.channelId;
        } catch (error) {
            console.error('[play] Failed to fetch YouTube playlist:', error);
            return interaction.editReply('❌ Failed to fetch YouTube playlist. Please try again.');
        }
        return;
    }

    if (isSpotifyArtist) {
        const voiceChannel = member.voice.channel;
        const gp = GuildPlayer.get(voiceChannel.guild.id) || GuildPlayer.create(voiceChannel.guild.id, voiceChannel);

        if (!gp.startedBy) {
            gp.startedBy = interaction.member?.user?.username || interaction.user.username;
        }

        if (!gp.ensureVoiceConnection()) {
            return interaction.editReply('Cannot connect to voice channel.');
        }

        // Extract artist ID from URL
        const artistId = extractSpotifyArtistId(query);
        if (!artistId) {
            return interaction.editReply('❌ Invalid Spotify artist URL.');
        }

        let tracks: any[] = [];
        try {
            await ensureSpotifyToken();
            
            // Get artist's top tracks
            const topTracksResponse = await spotifyApi.getArtistTopTracks(artistId, 'US');
            const topTracks = topTracksResponse.body.tracks;
            
            if (!topTracks || topTracks.length === 0) {
                return interaction.editReply('❌ No tracks found for this artist.');
            }

            // Convert to our track format
            tracks = topTracks.map((track: any) => ({
                id: track.id,
                name: track.name,
                artists: track.artists.map((a: any) => a.name),
                album: {
                    images: track.album.images
                },
                url: track.external_urls?.spotify
            }));

            console.log('[Spotify Artist] Found', tracks.length, 'top tracks');
        } catch (err) {
            console.error('[Spotify Artist] Error fetching top tracks:', err);
            return interaction.editReply('❌ Error retrieving artist top tracks.');
        }

        const MAX_TRACKS = 10;
        const tracksToEnqueue: any[] = [];

        for (let i = 0; i < tracks.length && tracksToEnqueue.length < MAX_TRACKS; i++) {
            const t = tracks[i];
            console.log(`[Spotify Artist] Adding track ${tracksToEnqueue.length + 1}/${MAX_TRACKS}: ${t.name} - ${t.artists.join(', ')}`);

            tracksToEnqueue.push({
                url: t.url || `spotify:track:${t.id}`,
                title: `${t.name} - ${t.artists.join(', ')}`,
                spotifyIndex: i,
                spotifyName: t.name,
                spotifyArtists: t.artists,
                spotifyId: t.id,
                requestedBy: interaction.user.tag,
                source: 'Spotify',
                thumbnail: t.album?.images?.[0]?.url
            });
        }

        if (tracksToEnqueue.length === 0) {
            return interaction.editReply('❌ No valid tracks found for this artist.');
        }

        // Enqueue tracks
        console.log(`[play] Enqueuing ${tracksToEnqueue.length} artist tracks`);
        for (const t of tracksToEnqueue) {
            gp.enqueue(t, false);
        }

        // Join voice channel if not connected
        if (!gp.connection) {
            const channel = (interaction.member as any).voice?.channel;
            if (!channel) {
                await interaction.editReply('❌ You need to be in a voice channel!');
                return;
            }

            console.log('[play] Joining voice channel:', channel.name);
            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: interaction.guildId!,
                adapterCreator: interaction.guild!.voiceAdapterCreator as any
            });

            gp.connection = connection;
            connection.subscribe(gp.player);
            
            console.log('[play] Voice connection established');
        }

        // Start playback
        if (!gp.currentTrack) {
            console.log('[play] Starting playback...');
            await gp.playNext();
        }

        await interaction.editReply(`✅ Added **${tracksToEnqueue.length} top tracks** from artist to queue!`);
        replyUpdated = true;

        // Build embed
        await gp.deleteQueueMessage(interaction.client);

        const nowPlaying = gp.getCurrent();
        const maxQueueToShow = 10;
        const more = gp.queue.length > maxQueueToShow ? `\n...and ${gp.queue.length - maxQueueToShow} more` : '';
        let queueStr = buildQueueList(gp.queue.slice(0, maxQueueToShow)) + more;
        if (!queueStr.trim()) queueStr = 'No tracks in queue.';
        if (queueStr.length > 1024) queueStr = queueStr.slice(0, 1021) + '...';

        const requester = interaction.member?.user?.username || interaction.user.username;

        const embed = new EmbedBuilder()
            .setTitle('Music Queue')
            .addFields(
                { name: 'Now playing', value: nowPlaying?.title ?? 'Nothing' },
                { name: 'Queue', value: queueStr },
                { name: 'Requested by', value: requester, inline: true }
            );

        if (nowPlaying?.thumbnail) {
            embed.setThumbnail(nowPlaying.thumbnail);
        }

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('shuffle').setLabel('Shuffle').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger)
        );

        await interaction.editReply({ embeds: [embed], components: [row] });
        const sent = await interaction.fetchReply();
        gp.queueMessageId = sent.id;
        gp.queueChannelId = sent.channelId;
        return;
    }

    if (isSpotifyPlaylist) {
        const voiceChannel = member.voice.channel;
        const gp = GuildPlayer.get(voiceChannel.guild.id) || GuildPlayer.create(voiceChannel.guild.id, voiceChannel);

        if (!gp.startedBy) {
            gp.startedBy = interaction.member?.user?.username || interaction.user.username;
        }

        if (!gp.ensureVoiceConnection()) {
            return interaction.editReply('Cannot connect to voice channel.');
        }

        const playlistId = extractSpotifyPlaylistId(query);
        let tracks: any[] = [];
        try {
            tracks = await getPlaylistTracks(query);
        } catch (err) {
            console.error('[Spotify] getPlaylistTracks error:', err);
            return interaction.editReply('Error retrieving Spotify playlist.');
        }
        console.log('[play] getPlaylistTracks returned', tracks.length, 'tracks');
        if (!tracks || tracks.length === 0) {
            return interaction.editReply('Spotify playlist found but empty or not accessible.');
        }

        const MAX_TRACKS = 10;
        const tracksToEnqueue: any[] = [];

        for (let i = 0; i < tracks.length && tracksToEnqueue.length < MAX_TRACKS; i++) {
            const t = tracks[i];
            console.log(`[Spotify] Adding track ${tracksToEnqueue.length + 1}/${MAX_TRACKS}: ${t.name} - ${t.artists.join(', ')}`);

            tracksToEnqueue.push({
                url: t.url || `spotify:track:${t.id}`,
                title: `${t.name} - ${t.artists.join(', ')}`,
                spotifyPlaylistId: playlistId ?? undefined,
                spotifyIndex: i,
                spotifyName: t.name,
                spotifyArtists: t.artists,
                spotifyId: t.id,
                requestedBy: interaction.user.tag,
                source: 'Spotify',
                thumbnail: t.album?.images?.[0]?.url
            });
        }

        if (tracksToEnqueue.length === 0) {
            return interaction.editReply('No valid tracks in Spotify playlist.');
        }

        // ==========================
        // ENQUEUE TRACKS
        // ==========================
        console.log(`[play] Enqueuing ${tracksToEnqueue.length} tracks`);
        for (const t of tracksToEnqueue) {
            gp.enqueue(t, false); // Don't auto-play yet
        }

        // ==========================
        // JOIN VOICE CHANNEL IF NOT CONNECTED
        // ==========================
        if (!gp.connection) {
            const channel = (interaction.member as any).voice?.channel;
            if (!channel) {
                await interaction.editReply('❌ You need to be in a voice channel!');
                return;
            }

            console.log('[play] Joining voice channel:', channel.name);
            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: interaction.guildId!,
                adapterCreator: interaction.guild!.voiceAdapterCreator as any
            });

            gp.connection = connection;
            connection.subscribe(gp.player);
            
            console.log('[play] Voice connection established');
        }

        // ==========================
        // START PLAYBACK
        // ==========================
        if (!gp.currentTrack) {
            console.log('[play] Starting playback...');
            await gp.playNext();
        }

        // REPLY
        let replyText = `✅ Added **${tracksToEnqueue.length} songs** from Spotify playlist to queue!`;
        await interaction.editReply(replyText);

        gp._playlistTracks = tracks;
        gp._playlistPointer = MAX_TRACKS;
        gp._playlistId = playlistId ?? undefined;
        gp._lastRequester = interaction.user.tag;

        console.log('[Spotify] Final queue:', gp.queue.map((t: any) => ({
            spotifyIndex: t.spotifyIndex,
            title: t.title
        })));

        await gp.deleteQueueMessage(interaction.client);

        const nowPlaying = gp.getCurrent();
        const maxQueueToShow = 10;
        const more = gp.queue.length > maxQueueToShow ? `\n...and ${gp.queue.length - maxQueueToShow} more` : '';
        let queueStr = buildQueueList(gp.queue.slice(0, maxQueueToShow)) + more;
        if (!queueStr.trim()) queueStr = 'No tracks in queue.';
        if (queueStr.length > 1024) queueStr = queueStr.slice(0, 1021) + '...';

        const requester = interaction.member?.user?.username || interaction.user.username;

        const embed = new EmbedBuilder()
            .setTitle('Music Queue')
            .addFields(
                { name: 'Now playing', value: nowPlaying?.title ?? 'Nothing' },
                { name: 'Queue', value: queueStr },
                { name: 'Requested by', value: requester, inline: true }
            );

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

        await interaction.editReply({ embeds: [embed], components: [row] });
        replyUpdated = true;
        const sent = await interaction.fetchReply();
        gp.queueMessageId = sent.id;
        gp.queueChannelId = sent.channelId;
        return;
    }

    let songInfo: { url?: string; title?: string } | null = null;
    songInfo = await searchSpotify(query);
    if (!songInfo) {
        songInfo = await searchSpotifyYT(query);

        if (!songInfo) {
            try {
                const r = await yts(query);
                const v = r.videos?.[0];
                if (v) songInfo = { url: v.url, title: v.title };
            } catch (e) {
                console.error('[play] yts error:', e);
            }
        }
    }

    if (!songInfo || !songInfo.url) {
        return interaction.editReply('Could not find any results for your query.');
    }

    const voiceChannel = member.voice.channel;

    const gp = GuildPlayer.get(voiceChannel.guild.id) || GuildPlayer.create(voiceChannel.guild.id, voiceChannel);
    if (!gp.startedBy) {
        gp.startedBy = interaction.member?.user?.username || interaction.user.username;
    }

    if (!gp.ensureVoiceConnection()) {
        return interaction.editReply('Cannot connect to voice channel.');
    }

    const trackSource = query.includes('spotify.com') ? 'Spotify' : 'YouTube';

    let thumbnail: string | undefined;
    if (trackSource === 'YouTube' && songInfo.url) {
        const videoId = songInfo.url.match(/[?&]v=([^&]+)/)?.[1];
        if (videoId) {
            thumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
        }
    }

    gp.enqueue({
        url: songInfo.url,
        title: songInfo.title ?? songInfo.url,
        requestedBy: interaction.user.tag,
        source: trackSource,
        thumbnail
    }, false);

    const wasPlaying = gp.getCurrent() !== null;

    if (!wasPlaying) {
        console.log('[play] Starting playback for single track');
        await gp.playNext();
    } else {
        console.log('[play] Track added to queue, already playing');
    }

    const nowPlaying = gp.getCurrent();
    const maxQueueToShow = 10;
    const more = gp.queue.length > maxQueueToShow ? `\n...and ${gp.queue.length - maxQueueToShow} more` : '';
    let queueStr = buildQueueList(gp.queue.slice(0, maxQueueToShow)) + more;
    if (!queueStr.trim()) queueStr = 'No tracks in queue.';
    if (queueStr.length > 1024) queueStr = queueStr.slice(0, 1021) + '...';

    const startedBy = gp.startedBy || 'Unknown';

    const fields = [
        { name: 'Now playing', value: nowPlaying?.title ?? 'Nothing' },
        { name: 'Queue', value: queueStr },
        { name: 'Started by', value: startedBy, inline: true }
    ];
    if (gp.lastAction) {
        fields.push({ name: 'Last action', value: gp.lastAction, inline: true });
    }

    const embed = new EmbedBuilder()
        .setTitle('Music Queue')
        .addFields(fields);

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

    await gp.deleteQueueMessage(interaction.client);

    await interaction.editReply({ embeds: [embed], components: [row] });
    replyUpdated = true;
    const sent = await interaction.fetchReply();
    gp.queueMessageId = sent.id;
    gp.queueChannelId = sent.channelId;
};

function extractSpotifyArtistId(url: string): string | null {
    try {
        // Remove language/region prefix like /intl-it/
        url = url.replace(/\/intl-[a-z]{2}\//, '/');
        
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const idx = parts.findIndex(p => p === 'artist');
        if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    } catch (e) {
        // Fallback regex that handles intl URLs
        const m = url.match(/\/artist\/([A-Za-z0-9_-]+)/);
        if (m && m[1]) return m[1];
    }
    return null;
}

function extractSpotifyPlaylistId(url: string): string | null {
    try {
        // Remove language/region prefix like /intl-it/
        url = url.replace(/\/intl-[a-z]{2}\//, '/');
        
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const idx = parts.findIndex(p => p === 'playlist');
        if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    } catch (e) {
        // Fallback regex that handles intl URLs
        const m = url.match(/\/playlist\/([A-Za-z0-9_-]+)/);
        if (m && m[1]) return m[1];
    }
    return null;
}

export function buildQueueList(tracks: any[]): string {
    return tracks.map((t, i) => {
        const urlDisplay = (t.url && !t.url.startsWith('spotify:')) ? `` : '';
        const sourceTag = t.source ? ` [${t.source}]` : '';
        return `${i + 1}. ${t.title}${sourceTag}${urlDisplay}`;
    }).join('\n');
}

export async function streamWithYoutubeDl(videoUrl: string): Promise<{ stream: Readable; title: string; ytdlpProcess: ChildProcess; ffmpegProcess: ChildProcess }> {
    try {
        const isWindows = process.platform === 'win32';
        const ytdlpBinaryPath = isWindows
            ? path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe')
            : '/usr/local/bin/yt-dlp';

        console.log('[play] Extracting direct URL for:', videoUrl);

        // Step 1: get direct stream URL from yt-dlp
        const directUrl = await new Promise<string>((resolve, reject) => {
            const proc = spawn(ytdlpBinaryPath, [
                '-f', '18',
                '--extractor-args', 'youtube:player_client=android_vr',
                '--get-url',
                '--no-warnings',
                videoUrl,
            ], { stdio: ['ignore', 'pipe', 'pipe'] });

            let out = '';
            proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
            proc.stderr.on('data', (d: Buffer) => {
                const msg = d.toString().trim();
                if (msg) console.error('[yt-dlp get-url]', msg);
            });
            proc.on('close', (code) => {
                if (code !== 0 || !out.trim()) return reject(new Error(`yt-dlp get-url failed with code ${code}`));
                resolve(out.trim().split('\n')[0]);
            });
            proc.on('error', reject);
        });

        console.log('[play] Got direct URL, starting ffmpeg');

        // Step 2: ffmpeg reads directly from the URL and encodes to OGG Opus
        const ffmpegArgs = [
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-i', directUrl,
            '-vn',
            '-acodec', 'libopus',
            '-b:a', '128k',
            '-ar', '48000',
            '-ac', '2',
            '-f', 'ogg',
            'pipe:1'
        ];

        const ffmpegCmd = process.platform === 'win32' ? (ffmpegPath ?? 'ffmpeg') : 'ffmpeg';
        const ffmpegProcess = spawn(ffmpegCmd, ffmpegArgs, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        // Dummy ytdlpProcess per compatibilità con il tipo di ritorno
        const ytdlpProcess = ffmpegProcess;

        const outputStream = new PassThrough({
            highWaterMark: 1024 * 1024 * 5
        });

        outputStream.on('error', () => {});
        ffmpegProcess.stdout.on('error', () => {});

        ffmpegProcess.stdout.pipe(outputStream);

        ffmpegProcess.stderr.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) console.error('[ffmpeg stderr]', msg);
        });

        ffmpegProcess.on('error', (err) => {
            console.error('[ffmpeg process error]', err);
            outputStream.destroy();
        });

        ffmpegProcess.on('close', (code) => {
            if (code !== 0 && code !== null) console.error('[ffmpeg] Process exited with code', code);
        });

        console.log('[play] ffmpeg stream started (direct URL)');

        return {
            stream: outputStream,
            title: 'Playing',
            ytdlpProcess,
            ffmpegProcess
        };
    } catch (err: any) {
        console.error('[play] yt-dlp failed:', err?.message || err);

        const isAuthError = err?.message?.includes('Sign in to confirm') || err?.message?.includes('Sign in');
        if (isAuthError) {
            throw new Error('NOT_AUTHENTICATED');
        }

        throw new Error(`Failed to get YouTube stream: ${err?.message || 'Unknown error'}`);
    }
}