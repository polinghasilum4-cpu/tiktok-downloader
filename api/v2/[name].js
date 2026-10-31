/**
 * api/v2/[name].js — SATU serverless function buat semua endpoint /api/v2/*
 * ============================================================================
 * Vercel Hobby plan cuma boleh 12 Serverless Function per deployment. Kalau
 * tiap endpoint jadi file sendiri (15 file), itu 15 function → ke-block
 * ("No more than 12 Serverless Functions..."). Dynamic route [name].js ini
 * nampung SEMUA 15 endpoint jadi 1 function doang — Vercel otomatis routing
 * /api/v2/instagram, /api/v2/twitter, dst ke file INI, dengan req.query.name
 * = 'instagram' / 'twitter' / dst. URL yang dipanggil index.html GAK BERUBAH
 * sama sekali.
 *
 * Handler asli tiap endpoint dipindah ke api/_handlers/*.js (folder berawalan
 * underscore = otomatis gak dihitung Vercel sebagai function sendiri).
 *
 * Body parsing: file ini matiin bodyParser Vercel secara global (perlu,
 * biar formidable di faceswap/upload/pxbee/voice-changer/faceswap-video bisa
 * baca raw multipart stream). Buat endpoint yang butuh JSON body (qr,
 * pinterest, savefrom, mail), kita parse manual di bawah SEBELUM handler-nya
 * dipanggil, lalu taruh hasilnya di req.body — jadi dari sudut pandang
 * handler, gak ada bedanya sama sebelum digabung.
 */

module.exports.config = { api: { bodyParser: false } };

// Lazy-load TAPI tiap require() tetep pakai string literal (bukan variabel)
// biar bundler Vercel (Node File Trace) bisa ngikutin dependency-nya pas
// build — kalau pakai require(variabel) bisa gagal ke-trace dan handler-nya
// ilang pas deploy. Dibungkus arrow function biar baru dieksekusi pas
// beneran dipanggil (gak eager-load semua 15 handler tiap cold start).
const HANDLER_LOADERS = {
    'instagram':      () => require('../_handlers/instagram'),
    'twitter':         () => require('../_handlers/twitter'),
    'pinterest':       () => require('../_handlers/pinterest'),
    'qr':              () => require('../_handlers/qr'),
    'pxbee':           () => require('../_handlers/pxbee'),
    'faceswap-video':  () => require('../_handlers/faceswap-video'),
    'proxy':           () => require('../_handlers/proxy'),
    'spotify':         () => require('../_handlers/spotify'),
    'soundcloud':      () => require('../_handlers/soundcloud'),
    'faceswap':        () => require('../_handlers/faceswap'),
    'voice-changer':   () => require('../_handlers/voice-changer'),
    'upload':          () => require('../_handlers/upload'),
    'iqc':             () => require('../_handlers/iqc'),
    'savefrom':        () => require('../_handlers/savefrom'),
    'mail':            () => require('../_handlers/mail'),
};

// Endpoint yang handler aslinya ngarepin req.body UDAH jadi object JS
// (dulu di-auto-parse sama bodyParser bawaan Vercel). Kita parse manual di
// sini SEBELUM manggil handler-nya.
const JSON_BODY_ROUTES = new Set(['qr', 'pinterest', 'savefrom', 'mail']);

async function readRawBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
    const name = req.query && req.query.name;
    const loadHandler = HANDLER_LOADERS[name];

    if (!loadHandler) {
        return res.status(404).json({ success: false, error: 'Endpoint tidak ditemukan.' });
    }

    let handler;
    try {
        handler = loadHandler();
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Gagal load handler: ' + e.message });
    }

    if (JSON_BODY_ROUTES.has(name) && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        try {
            const raw = await readRawBody(req);
            const text = raw.toString('utf8').trim();
            req.body = text ? JSON.parse(text) : {};
        } catch (e) {
            return res.status(400).json({ success: false, error: 'Body JSON tidak valid.' });
        }
    }
    // Endpoint lain (upload/faceswap/voice-changer/pxbee/faceswap-video) gak
    // disentuh raw stream-nya sama sekali di sini — biar formidable di dalem
    // handler masing-masing yang baca langsung dari req.

    try {
        return await handler(req, res);
    } catch (e) {
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: 'Internal error: ' + e.message });
        }
    }
};
