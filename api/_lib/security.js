/**
 * api/_lib/security.js — shared hardening (arsitektur SATU PROJECT)
 * =====================================================================
 * Frontend (index.html) dan backend (api/v2/*.js) sekarang satu deployment
 * yang sama, same-origin. Konsekuensinya beda dari versi sebelumnya yang
 * backend-nya kepisah:
 *
 *   - GAK ADA API KEY LAGI. Di arsitektur 3-project yang lama, API key
 *     dipakai biar backend tau request itu dari "server/BFF yang sah".
 *     Sekarang gak ada server terpisah yang perlu dibuktiin — endpoint
 *     ini JUGA JALAN DI DOMAIN PUBLIK yang sama kayak halamannya. Nyimpen
 *     "key rahasia" di sini percuma, karena dia bakal keliatan lagi di
 *     DevTools persis kayak masalah awal lo.
 *   - Proteksi yang realistis buat situasi ini: (1) cek Origin/Referer
 *     match domain sendiri, dipadu (2) rate limit per-IP. Ini NUTUP
 *     browser-browser lain yang nyoba embed/fetch dari situs lain, dan
 *     ngerem bot yang nembak kenceng dari luar. Tapi kalau ada yang niat
 *     bikin script sendiri yang mirip browser (ngirim Origin/Referer yang
 *     dipalsuin persis), itu secara teknis BISA ngelewatin cek ini — gak
 *     ada cara 100% nutup endpoint publik dari scraping niat tanpa sistem
 *     akun/login. Ini batasan yang jujur, bukan dijanjiin "kebal total".
 *   - SSRF guard (assertPublicUrl) TETEP dipake di proxy.js/savefrom.js —
 *     ini gak ada hubungannya sama model auth, tetep relevan.
 */

const dns = require('dns').promises;
const net = require('net');

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------
const SELF_ORIGIN = process.env.SELF_ORIGIN || 'https://xs0cietylabsz.biz.id';

// ---------------------------------------------------------------------
// IP extraction (trust proxy: Cloudflare / Vercel)
// ---------------------------------------------------------------------
function getClientIp(req) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    const xrip = req.headers['x-real-ip'];
    if (xrip) return xrip.trim();
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---------------------------------------------------------------------
// Same-origin guard (gantiin CORS allowlist + API key di arsitektur lama)
// ---------------------------------------------------------------------
function sameOriginOnly(req, res) {
    const origin = req.headers.origin;
    const referer = req.headers.referer || req.headers.referrer;

    if (origin) {
        if (origin === SELF_ORIGIN) return true;
        res.status(403).json({ success: false, error: 'Forbidden: origin tidak diizinkan.' });
        return false;
    }
    if (referer && referer.indexOf(SELF_ORIGIN + '/') === 0) return true;

    res.status(403).json({ success: false, error: 'Forbidden: request tidak dikenali.' });
    return false;
}

// ---------------------------------------------------------------------
// Rate limiting (in-memory, per instance — best effort, lihat catatan
// di SECURITY_AUDIT_SUMMARY soal upgrade ke Upstash kalau perlu presisi)
// ---------------------------------------------------------------------
const buckets = new Map();

function rateLimit(req, res, { windowMs = 60000, max = 30 } = {}) {
    const ip = getClientIp(req);
    const now = Date.now();
    let b = buckets.get(ip);

    if (!b || now - b.start > windowMs) {
        b = { start: now, count: 0 };
        buckets.set(ip, b);
    }
    b.count++;

    if (buckets.size > 5000) {
        for (const [k, v] of buckets) {
            if (now - v.start > windowMs * 5) buckets.delete(k);
        }
    }

    if (b.count > max) {
        res.setHeader('Retry-After', Math.ceil((b.start + windowMs - now) / 1000));
        res.status(429).json({ success: false, error: 'Terlalu banyak request, coba lagi sebentar lagi.' });
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------
// SSRF guard — validasi URL + resolve DNS, tolak kalau mengarah ke IP
// privat (RFC1918, loopback, link-local 169.254.0.0/16 termasuk metadata
// 169.254.169.254). Dipakai di proxy.js & savefrom.js.
// ---------------------------------------------------------------------
function isPrivateIp(ip) {
    if (net.isIPv6(ip)) {
        const low = ip.toLowerCase();
        return low === '::1' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('::ffff:127.');
    }
    return /^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.)/.test(ip);
}

async function assertPublicUrl(urlStr) {
    let u;
    try { u = new URL(urlStr); } catch { throw new Error('URL tidak valid'); }

    if (!['http:', 'https:'].includes(u.protocol)) {
        throw new Error(`Protocol ${u.protocol} tidak diizinkan`);
    }

    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
        throw new Error('Hostname tidak diizinkan');
    }

    if (net.isIP(host)) {
        if (isPrivateIp(host)) throw new Error('Private/internal IP tidak diizinkan');
        return u;
    }

    let addrs = [];
    try {
        addrs = await dns.resolve4(host);
    } catch {
        try { addrs = await dns.resolve6(host); } catch { /* biarin fetch/axios yg nentuin gagal/nggaknya */ }
    }
    for (const addr of addrs) {
        if (isPrivateIp(addr)) {
            throw new Error('Domain resolve ke private/internal IP (diblokir, anti-SSRF)');
        }
    }
    return u;
}

module.exports = {
    getClientIp,
    sameOriginOnly,
    rateLimit,
    isPrivateIp,
    assertPublicUrl,
    SELF_ORIGIN,
};
