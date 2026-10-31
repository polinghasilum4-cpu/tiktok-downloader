/**
 * Proxy Stream Endpoint — bypass CORS (hardened)
 * ===============================================
 * GET /api/v2/proxy?url=...&filename=...
 * 
 * Security: SSRF protection, size limit, safe filename
 */

const axios = require('axios');
const { URL } = require('url');

const { sameOriginOnly, rateLimit, assertPublicUrl } = require('../_lib/security');

// Dipakai di beforeRedirect (sync, gak bisa resolve DNS di situ) buat nolak
// redirect yang literal nunjuk ke private IP / localhost / metadata endpoint.
const PRIVATE_IP_LITERAL = /^(?:127\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0$|\[?::1\]?$|localhost$)/i;

// NOTE: assertPublicUrl() resolves DNS dan cek IP hasil resolve-nya, bukan cuma
// nge-regex hostname. Ini nutup celah DNS-rebinding: domain publik yang
// di-rebind ke 127.0.0.1/169.254.169.254/private range bakal ketolak juga,
// bukan cuma hostname literal "localhost"/"127.0.0.1".
async function isSafeUrl(urlStr) {
    try {
        const parsed = await assertPublicUrl(urlStr);
        return { safe: true, hostname: parsed.hostname.toLowerCase() };
    } catch (e) {
        return { safe: false, reason: e.message };
    }
}

function getReferer(hostname) {
    // TikTok / TikWM — tikwm WAJIB punya referer dari domain mereka sendiri
    if (/\.tikwm\.com$/.test(hostname)) return 'https://www.tikwm.com/';
    if (/\.tiktokcdn\.com$|\.tiktok\.com$/.test(hostname)) return 'https://www.tiktok.com/';

    // Facebook
    if (/\.fbcdn\.net$|\.facebook\.com$/.test(hostname)) return 'https://www.facebook.com/';

    // YouTube
    if (/\.googlevideo\.com$|\.youtube\.com$/.test(hostname)) return 'https://www.youtube.com/';

    // Instagram
    if (/\.cdninstagram\.com$|\.instagram\.com$/.test(hostname)) return 'https://www.instagram.com/';

    // Twitter/X
    if (/\.twimg\.com$|\.twitter\.com$|\.x\.com$/.test(hostname)) return 'https://twitter.com/';

    // SoundCloud
    if (/\.sndcdn\.com$|\.soundcloud\.com$/.test(hostname)) return 'https://soundcloud.com/';

    // Spotify
    if (/\.scdn\.co$|\.spotify\.com$/.test(hostname)) return 'https://open.spotify.com/';

    return 'https://www.google.com/';
}

function buildContentDisposition(filename) {
    // ASCII-safe fallback
    const asciiSafe = String(filename || 'download')
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/["\\\/]/g, '_')
        .slice(0, 100);
    // RFC 5987 UTF-8 version
    const utf8 = encodeURIComponent(String(filename || 'download').slice(0, 100));
    return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${utf8}`;
}

module.exports = async (req, res) => {

    if (req.method === 'OPTIONS') return res.status(204).end();
  if (!rateLimit(req, res)) return;
  if (!sameOriginOnly(req, res)) return;

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { url, filename } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'Missing "url" parameter' });
    }

    // ============ SSRF CHECK ============
    const check = await isSafeUrl(url);
    if (!check.safe) {
        return res.status(403).json({ error: 'URL ditolak', reason: check.reason });
    }

    const referer = getReferer(check.hostname);
    console.log('[proxy] streaming:', check.hostname, '| referer:', referer);

    try {
        const upstream = await axios.get(url, {
            responseType: 'stream',
            timeout: 55000,          // ← turun dari 120s biar aman sama Vercel 60s
            maxRedirects: 3,         // ← turun, redirect berlebihan = suspicious
            maxContentLength: 500 * 1024 * 1024, // 500 MB cap
            maxBodyLength: 500 * 1024 * 1024,
            validateStatus: () => true, // ← biar bisa handle 4xx/5xx gracefully
            // Anti-SSRF: redirect ke IP privat/metadata ditolak juga, bukan cuma URL awal.
            beforeRedirect: (options) => {
                const h = (options.hostname || options.host || '').toLowerCase();
                if (PRIVATE_IP_LITERAL.test(h) || h === 'localhost') {
                    throw new Error('Redirect ke private/internal address diblokir (anti-SSRF)');
                }
            },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
                'Referer': referer,
                'Accept': '*/*',
                'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
            },
        });

        // ============ HANDLE UPSTREAM ERROR ============
        if (upstream.status >= 400) {
            // Consume & discard stream biar gak nyangkut
            upstream.data.resume();
            return res.status(upstream.status).json({
                error: 'Upstream error',
                status: upstream.status,
                statusText: upstream.statusText,
            });
        }

        // ============ SIZE LIMIT CHECK ============
        const contentLength = parseInt(upstream.headers['content-length'] || '0', 10);
        const MAX_SIZE = 500 * 1024 * 1024; // 500 MB
        if (contentLength > MAX_SIZE) {
            upstream.data.destroy();
            return res.status(413).json({
                error: 'File terlalu besar',
                size: contentLength,
                max: MAX_SIZE,
            });
        }

        // ============ SET RESPONSE HEADERS ============
        const ct = upstream.headers['content-type'] || 'application/octet-stream';
        res.setHeader('Content-Type', ct);
        res.setHeader('Content-Disposition', buildContentDisposition(filename));
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (contentLength > 0) res.setHeader('Content-Length', String(contentLength));

        // ============ HANDLE CLIENT DISCONNECT ============
        // Kalau client putus di tengah, abort upstream stream biar gak buang bandwidth
        req.on('close', () => {
            if (!upstream.data.destroyed) {
                console.log('[proxy] client disconnected, aborting upstream');
                upstream.data.destroy();
            }
        });

        // ============ HANDLE UPSTREAM STREAM ERROR ============
        upstream.data.on('error', (err) => {
            console.error('[proxy] upstream stream error:', err.message);
            if (!res.headersSent) {
                res.status(502).json({ error: 'Upstream stream error' });
            } else {
                res.end();
            }
        });

        // ============ PIPE ============
        upstream.data.pipe(res);

    } catch (err) {
        console.error('[proxy] error:', err.message, err.code || '');
        
        // Timeout
        if (err.code === 'ECONNABORTED') {
            return res.status(504).json({ error: 'Timeout fetching upstream' });
        }
        // DNS / network
        if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
            return res.status(502).json({ error: 'Upstream tidak bisa diakses' });
        }
        // Generic
        return res.status(err.response?.status || 500).json({
            error: 'Proxy failed',
            message: err.message,
        });
    }
};
