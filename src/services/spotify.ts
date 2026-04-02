const SPOTIFY_API_URL = 'https://api.spotify.com/v1';
const SPOTIFY_TOKEN = process.env.SPOTIFY_TOKEN;

import SpotifyWebApi from 'spotify-web-api-node';
import yts from 'yt-search';

const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

let spotifyTokenObtainedAt = 0;
let spotifyTokenTtl = 0;

export async function ensureSpotifyToken() {
    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
        console.warn('[spotify] missing CLIENT_ID/SECRET');
        throw new Error('Missing Spotify credentials');
    }
    const now = Date.now();
    if (spotifyTokenObtainedAt + (spotifyTokenTtl - 60000) > now) return;
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body['access_token']);
    spotifyTokenObtainedAt = Date.now();
    spotifyTokenTtl = (data.body['expires_in'] || 3600) * 1000;
    console.log('[spotify] token obtained, expires in', data.body['expires_in']);
}

function extractSpotifyId(url: string) {
    if (!url) return null;
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const idx = parts.findIndex(p => ['track', 'playlist', 'album'].includes(p));
        if (idx >= 0 && parts[idx + 1]) {
            return { type: parts[idx], id: parts[idx + 1] };
        }
    } catch (e) {}
    const m = url.match(/(?:track|playlist|album)[:\/]([A-Za-z0-9]+)/);
    if (m) return { type: url.includes('track') ? 'track' : url.includes('playlist') ? 'playlist' : 'album', id: m[1] };
    return null;
}

export async function searchSpotify(query: string): Promise<{ url?: string; title?: string } | null> {
    try {
        if (/spotify\.com/.test(query)) {
            const info = extractSpotifyId(query);
            if (!info) return null;
            await ensureSpotifyToken();

            if (info.type === 'track') {
                const res = await spotifyApi.getTrack(info.id);
                const track = res.body;
                const q = `${track.name} ${track.artists.map((a: any) => a.name).join(' ')}`;
                const r = await yts(q);
                const v = r?.videos?.[0];
                if (v) return { url: v.url, title: `${track.name} - ${track.artists.map((a: any) => a.name).join(', ')}` };
            }

            if (info.type === 'playlist') {
                const res = await spotifyApi.getPlaylist(info.id, { limit: 1 });
                const first = res.body.tracks?.items?.[0]?.track;
                if (first) {
                    const q = `${first.name} ${first.artists.map((a: any) => a.name).join(' ')}`;
                    const r = await yts(q);
                    const v = r?.videos?.[0];
                    if (v) return { url: v.url, title: `${first.name} - ${first.artists.map((a: any) => a.name).join(', ')}` };
                }
            }

            if (info.type === 'album') {
                const res = await spotifyApi.getAlbumTracks(info.id, { limit: 1 });
                const first = res.body.items?.[0];
                if (first) {
                    const q = `${first.name} ${first.artists?.map((a: any) => a.name).join(' ') ?? ''}`;
                    const r = await yts(q);
                    const v = r?.videos?.[0];
                    if (v) return { url: v.url, title: first.name };
                }
            }

            return null;
        }

        return null;
    } catch (err) {
        console.error('[spotify] search error', err);
        return null;
    }
}

export async function searchYouTube(query: string): Promise<{ url?: string; title?: string } | null> {
    try {
        const r = await yts(query);
        const v = r?.videos?.[0];
        if (v) return { url: v.url, title: v.title };
        return null;
    } catch (err) {
        console.error('[youtube] search error', err);
        return null;
    }
}

export async function getPlaylistTracks(urlOrId: string): Promise<any[]> {
    let playlistId = urlOrId;
    const m = urlOrId.match(/playlist\/([A-Za-z0-9]+)/);
    if (m && m[1]) playlistId = m[1];

    await ensureSpotifyToken();

    const limit = 100;
    let offset = 0;
    const results: any[] = [];

    while (true) {
        let res: any;
        try {
            res = await spotifyApi.getPlaylistTracks(playlistId, { limit, offset });
        } catch (err) {
            console.error('[spotify] getPlaylistTracks error', err);
            break;
        }

        const items = res.body?.items ?? [];
        for (const it of items) {
            const track = it.track;
            if (!track) continue;
            results.push({
                id: track.id,
                name: track.name,
                artists: (track.artists ?? []).map((a: any) => a.name),
                url: track.external_urls?.spotify,
                album: track.album
            });
        }

        if (!res.body.next || items.length < limit) break;
        offset += limit;
    }

    return results;
}

export async function getPlaylistSummary(urlOrId: string): Promise<{ total: number; first?: { name: string; artists: string[] } }> {
    const info = extractSpotifyId(urlOrId);
    if (!info || info.type !== 'playlist') return { total: 0 };

    await ensureSpotifyToken();

    try {
        const res: any = await spotifyApi.getPlaylist(info.id, { limit: 1 });
        const total = res.body?.tracks?.total ?? 0;
        const firstItem = res.body?.tracks?.items?.[0]?.track;
        if (firstItem) {
            return { total, first: { name: firstItem.name, artists: (firstItem.artists ?? []).map((a: any) => a.name) } };
        }
        return { total };
    } catch (err) {
        console.error('[spotify] getPlaylistSummary error', err);
        return { total: 0 };
    }
}

export async function getPlaylistTrackAt(urlOrId: string, index: number): Promise<{ name: string; artists: string[] } | null> {
    const info = extractSpotifyId(urlOrId);
    if (!info || info.type !== 'playlist') return null;
    await ensureSpotifyToken();
    try {
        const res: any = await spotifyApi.getPlaylistTracks(info.id, { limit: 1, offset: index });
        const item = res.body?.items?.[0]?.track;
        if (!item) return null;
        return { name: item.name, artists: (item.artists ?? []).map((a: any) => a.name) };
    } catch (err) {
        console.error('[spotify] getPlaylistTrackAt error', err);
        return null;
    }
}

export default spotifyApi;