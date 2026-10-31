/**
 * Pinterest Downloader — Auto-detect Video/Image
 * ===============================================
 * POST /api/v2/pinterest  {"url": "..."}
 * GET  /api/v2/pinterest?url=<pin_url>
 */

const axios = require('axios');

const { sameOriginOnly, rateLimit } = require('../_lib/security');
const PX_BASE = 'https://web--pinsaver-backend--bvs4tz6kpmqp.code.run';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';

const PX_HEADERS = {
    'Origin': 'https://pinsaver.online',
    'Referer': 'https://pinsaver.online/',
    'User-Agent': UA,
    'Accept': '*/*',
};

function ok(res, data) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data });
}

function err(res, msg, status = 400) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json({ success: false, error: msg });
}

async function callPinSaver(pinUrl, type) {
    const qs = type
        ? `?url=${encodeURIComponent(pinUrl)}&content_type=${type}`
        : `?url=${encodeURIComponent(pinUrl)}`;

    const r = await axios.post(PX_BASE + '/api/download' + qs, null, {
        headers: { ...PX_HEADERS, 'Content-Length': '0' },
        timeout: 30000,
        validateStatus: () => true,
    });

    let data = r.data;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { data = { raw: data }; }
    }

    return { status: r.status, data };
}

// Cek response valid atau cuma default share image
function isValidResult(data) {
    if (!data || data.redirect) return false;
    if (!data.downloadUrl) return false;
    // Default share image dari Pinterest — anggap gagal
    if (data.downloadUrl.includes('facebook_share_image')) return false;
    return true;
}

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') { return res.status(204).end(); }
    if (!rateLimit(req, res)) return;
    if (!sameOriginOnly(req, res)) return;

    let pinUrl = req.query.url;

    if (!pinUrl && req.method === 'POST') {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        pinUrl = body.url;
    }

    // Health check
    if (!pinUrl) {
        return res.status(200).json({
            success: true,
            service: 'pinterest-downloader',
            status: 'ok',
            note: 'Auto-detect video/image via PinSaver',
            usage: {
                GET: '/api/v2/pinterest?url=<pin_url>',
                POST: '{"url": "<pin_url>"}',
            },
        });
    }

    if (!/^https?:\/\/(www\.)?(pinterest\.[a-z.]+|pin\.it)\//i.test(pinUrl)) {
        return err(res, 'URL harus Pinterest / pin.it');
    }

    try {
        // ══ Step 1: coba sebagai IMAGE dulu (kemungkinan besar pin gambar) ══
        console.log('[pinterest] 1) try image');
        let r = await callPinSaver(pinUrl, 'image');
        console.log('   →', r.status, JSON.stringify(r.data).slice(0, 200));

        if (r.status === 200 && isValidResult(r.data)) {
            return ok(res, {
                ...r.data,
                source: 'pinsaver',
                type: r.data.content_type || 'image',
            });
        }

        // ══ Step 2: kalau gagal/redirect, coba VIDEO ══
        console.log('[pinterest] 2) try video');
        r = await callPinSaver(pinUrl, 'video');
        console.log('   →', r.status, JSON.stringify(r.data).slice(0, 200));

        if (r.status === 200 && isValidResult(r.data)) {
            return ok(res, {
                ...r.data,
                source: 'pinsaver',
                type: r.data.content_type || 'video',
            });
        }

        // ══ Step 3: fallback tanpa content_type ══
        console.log('[pinterest] 3) fallback (no content_type)');
        r = await callPinSaver(pinUrl, null);
        console.log('   →', r.status, JSON.stringify(r.data).slice(0, 200));

        if (r.status === 200 && isValidResult(r.data)) {
            return ok(res, {
                ...r.data,
                source: 'pinsaver',
                type: r.data.content_type || 'image',
            });
        }

        // ══ Semua gagal ══
        const errMsg = r.data?.message || r.data?.error || 'Pin tidak ditemukan atau format tidak didukung';
        return err(res, errMsg, 502);

    } catch (e) {
        console.error('[pinterest] error:', e.message);
        return err(res, e.message, 502);
    }
};
