/**
 * Upload File — via Litterbox (Catbox temporary)
 * 
 * POST /api/v2/upload
 * multipart/form-data:
 *   - file : file (wajib)
 *   - time : 1h / 12h / 24h / 72h (default 24h)
 */

const axios = require('axios');
const FormData = require('form-data');
const { formidable } = require('formidable');
const fs = require('fs');
const crypto = require('crypto');

const { sameOriginOnly, rateLimit } = require('../_lib/security');
module.exports.config = {
    api: { bodyParser: false, sizeLimit: '50mb' },
    maxDuration: 30,
};

const LITTERBOX = 'https://litterbox.catbox.moe/resources/internals/api.php';
const VALID_TIMES = ['1h', '12h', '24h', '72h'];

// ---------------------------------------------------------------------
// Magic-byte allowlist (Anti-RCE): client-supplied mimetype gampang
// dipalsu, jadi kita sniff byte pertama file dan cocokkan ke whitelist
// tipe yang aman buat di-relay. Executable/script (.exe, .sh, .php,
// .html, dll) otomatis ketolak karena gak ada di daftar ini.
// ---------------------------------------------------------------------
const MAGIC_BYTES = [
    { ext: 'jpg', mime: 'image/jpeg', sig: [0xff, 0xd8, 0xff] },
    { ext: 'png', mime: 'image/png', sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { ext: 'gif', mime: 'image/gif', sig: [0x47, 0x49, 0x46, 0x38] },
    { ext: 'webp', mime: 'image/webp', sig: [0x52, 0x49, 0x46, 0x46], offset: 0, skipCheck: (b) => b.slice(8, 12).toString('ascii') === 'WEBP' },
    { ext: 'pdf', mime: 'application/pdf', sig: [0x25, 0x50, 0x44, 0x46] },
    { ext: 'mp3', mime: 'audio/mpeg', sig: [0x49, 0x44, 0x33] }, // ID3
    { ext: 'mp3', mime: 'audio/mpeg', sig: [0xff, 0xfb] },
    { ext: 'ogg', mime: 'audio/ogg', sig: [0x4f, 0x67, 0x67, 0x53] },
    { ext: 'wav', mime: 'audio/wav', sig: [0x52, 0x49, 0x46, 0x46], skipCheck: (b) => b.slice(8, 12).toString('ascii') === 'WAVE' },
    { ext: 'mp4', mime: 'video/mp4', sig: [0x66, 0x74, 0x79, 0x70], offset: 4 },
    { ext: 'zip', mime: 'application/zip', sig: [0x50, 0x4b, 0x03, 0x04] },
];

function detectFileType(buffer) {
    for (const t of MAGIC_BYTES) {
        const off = t.offset || 0;
        const slice = buffer.slice(off, off + t.sig.length);
        const matches = t.sig.every((b, i) => slice[i] === b);
        if (matches && (!t.skipCheck || t.skipCheck(buffer))) {
            return { ext: t.ext, mime: t.mime };
        }
    }
    return null;
}

module.exports = async function handler(req, res) {

    if (req.method === 'OPTIONS') return res.status(204).end();
  if (!rateLimit(req, res)) return;
  if (!sameOriginOnly(req, res)) return;


    // GET = info
    if (req.method === 'GET') {
        return res.json({
            success: true,
            info: 'Upload File API — via Litterbox',
            usage: 'POST multipart: file (wajib) + time (opsional)',
            valid_times: VALID_TIMES,
            max_size: '50 MB',
        });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'POST only' });
    }

    const startedAt = Date.now();

    try {
        const form = formidable({
            maxFileSize: 50 * 1024 * 1024,
            multiples: false,
        });

        const { fields, files } = await new Promise((resolve, reject) => {
            form.parse(req, (err, fields, files) => {
                if (err) return reject(err);
                resolve({ fields, files });
            });
        });

        const fileField = files.file || files.upload || files.image;
        const file = Array.isArray(fileField) ? fileField[0] : fileField;

        if (!file) {
            return res.status(400).json({
                success: false,
                error: 'Butuh file. Field: "file"',
            });
        }

        const timeField = fields.time;
        let time = Array.isArray(timeField) ? timeField[0] : (timeField || '24h');
        time = String(time).toLowerCase();

        if (!VALID_TIMES.includes(time)) {
            return res.status(400).json({
                success: false,
                error: `time invalid. Pilih: ${VALID_TIMES.join(', ')}`,
            });
        }

        const buffer = fs.readFileSync(file.filepath);

        // ============ MAGIC-BYTE VALIDATION (Anti-RCE) ============
        // Jangan percaya file.mimetype (header Content-Type dari client,
        // gampang dipalsu) — sniff isi file beneran.
        const detected = detectFileType(buffer);
        if (!detected) {
            return res.status(415).json({
                success: false,
                error: 'Tipe file tidak didukung/tidak dikenali. Hanya gambar, audio, video, pdf, zip.',
            });
        }

        // ============ SAFE FILENAME (UUID rename) ============
        // Nama asli dari client gak dipakai buat apapun selain display di
        // response — nama yang di-forward ke storage pihak ketiga selalu
        // UUID + ekstensi hasil deteksi magic-byte, biar gak ada celah
        // path traversal / header injection / nama file berbahaya.
        const safeFilename = `${crypto.randomUUID()}.${detected.ext}`;
        const originalFilename = String(file.originalFilename || 'file').slice(0, 200);
        const mimetype = detected.mime;

        console.log(`[upload] ${safeFilename} (orig: ${originalFilename}, ${(buffer.length / 1024).toFixed(1)} KB) time=${time}`);

        // Forward ke Litterbox
        const lb = new FormData();
        lb.append('reqtype', 'fileupload');
        lb.append('time', time);
        lb.append('fileToUpload', buffer, {
            filename: safeFilename,
            contentType: mimetype,
        });

        const lbRes = await axios.post(LITTERBOX, lb, {
            headers: {
                ...lb.getHeaders(),
                'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
                'accept': '*/*',
                'origin': 'https://litterbox.catbox.moe',
                'referer': 'https://litterbox.catbox.moe/',
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 30000,
            validateStatus: () => true,
        });

        const url = String(lbRes.data).trim();

        if (!url.startsWith('http')) {
            throw new Error('Litterbox response invalid: ' + url.slice(0, 200));
        }

        return res.json({
            success: true,
            data: {
                url,
                filename: safeFilename,
                originalFilename,
                size: buffer.length,
                mimetype,
                time,
                elapsedMs: Date.now() - startedAt,
            },
        });
    } catch (err) {
        console.error('[upload]', err.message);
        return res.status(500).json({
            success: false,
            error: err.message || 'Upload gagal',
            elapsedMs: Date.now() - startedAt,
        });
    }
};
