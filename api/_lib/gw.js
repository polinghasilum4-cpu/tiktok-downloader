/**
 * api/_lib/gw.js — Backend-for-Frontend (BFF) shared helper
 * ============================================================
 * Fungsi file ini:
 *  1. Mastiin request yang masuk beneran dari halaman web sendiri
 *     (sameOriginOnly) — bukan jaminan 100% (lihat catatan di bawah),
 *     tapi nutup jalur paling gampang (curl/script asal nembak domain ini).
 *  2. Rate limit per-IP (best effort, in-memory per instance).
 *  3. forward() — nerusin request browser ke backend API asli (project
 *     api-instagram-main / api-spotify-main / api.soundcloud-main) sambil
 *     nempelin API key dari ENV SERVER INI. Key ini TIDAK PERNAH dikirim
 *     ke browser — browser cuma liat endpoint /api/gw/... di domain
 *     sendiri, gak pernah liat key atau domain backend asli.
 *
 * ENV yang wajib diisi di Vercel project FRONTEND ini (bukan di 3 project
 * backend):
 *   BACKEND_API_KEY   = salah satu value yang ada di API_KEYS 3 backend itu
 *   INSTAGRAM_API_BASE  = https://<url-deploy-api-instagram-main>.vercel.app
 *   SPOTIFY_API_BASE    = https://<url-deploy-api-spotify-main>.vercel.app
 *   SOUNDCLOUD_API_BASE = https://<url-deploy-api-soundcloud-main>.vercel.app
 *   SELF_ORIGIN (opsional) = https://xs0cietylabsz.biz.id  (default kalau kosong)
 *
 * CATATAN JUJUR soal batasan:
 *  - sameOriginOnly cuma ngecek header Origin/Referer, yang BISA dipalsuin
 *    kalau orang manggil pakai curl/script (bukan browser beneran). Tapi ini
 *    tetep jauh lebih baik dari sebelumnya: orang itu HARUS nemuin dulu
 *    struktur endpoint /api/gw/* dan nebak field yang dikirim — gak ada key
 *    rahasia yang langsung kepake kalau dicopy dari DevTools, karena
 *    memang gak ada key apapun yang dikirim ke browser lagi.
 *  - Request body di-buffer penuh sebelum diterusin (bukan streaming),
 *    tunduk ke limit payload platform Vercel (~4.5 MB per request untuk
 *    Serverless Functions standar). File besar (audio/video upload) bisa
 *    kena 413 kalau lewat batas ini — lihat catatan di README.
 */

const SELF_ORIGIN = process.env.SELF_ORIGIN || 'https://xs0cietylabsz.biz.id';

// ---------------------------------------------------------------------
// Rate limiting (in-memory, per instance — sama kayak di 3 backend)
// ---------------------------------------------------------------------
const buckets = new Map();

function getClientIp(req) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

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
// Same-origin guard
// ---------------------------------------------------------------------
function sameOriginOnly(req, res) {
    const origin = req.headers.origin;
    const referer = req.headers.referer || req.headers.referrer;

    if (origin) {
        if (origin === SELF_ORIGIN) return true;
        res.status(403).json({ success: false, error: 'Forbidden: origin tidak diizinkan.' });
        return false;
    }
    // Banyak browser gak nyertain header Origin di same-origin GET biasa,
    // jadi fallback ke Referer (lebih sering ada).
    if (referer && referer.indexOf(SELF_ORIGIN + '/') === 0) return true;

    res.status(403).json({ success: false, error: 'Forbidden: request tidak dikenali.' });
    return false;
}

// ---------------------------------------------------------------------
// Generic forwarder
// ---------------------------------------------------------------------
async function readRawBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function forward({ req, res, baseUrl, path }) {
    if (!baseUrl) {
        res.status(500).json({ success: false, error: 'Backend base URL belum di-set di ENV server.' });
        return;
    }
    const apiKey = process.env.BACKEND_API_KEY;
    if (!apiKey) {
        res.status(500).json({ success: false, error: 'BACKEND_API_KEY belum di-set di ENV server.' });
        return;
    }

    const qs = req.query && Object.keys(req.query).length
        ? '?' + new URLSearchParams(req.query).toString()
        : '';
    const url = `${baseUrl}${path}${qs}`;

    const headers = { 'X-Api-Key': apiKey };
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        body = await readRawBody(req);
        if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    }

    let upstream;
    try {
        upstream = await fetch(url, { method: req.method, headers, body });
    } catch (e) {
        res.status(502).json({ success: false, error: 'Gagal menghubungi backend: ' + e.message });
        return;
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.send(buf);
}

module.exports = { rateLimit, sameOriginOnly, forward, getClientIp, SELF_ORIGIN };
