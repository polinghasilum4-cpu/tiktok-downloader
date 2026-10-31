/**
 * PXBee Text Remover — Vercel Serverless Function
 * ================================================
 * Endpoint:
 *   GET  /api/pxbee                       → health check
 *   POST /api/pxbee (multipart image)     → upload & process
 *   POST /api/pxbee {"imageUrl":"..."}    → process by URL
 *   GET  /api/pxbee?url=<image_url>       → process by URL (simple)
 *
 * Response:
 *   { success: true, data: { url, taskId, elapsed, ... } }
 */

const axios = require('axios');
const crypto = require('crypto');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const { sameOriginOnly, rateLimit } = require('../_lib/security');
// Fix formidable v3 export (CJS/ESM dual)
const formidableModule = require('formidable');
const IncomingForm =
    formidableModule.IncomingForm ||
    formidableModule.default ||
    formidableModule.formidable ||
    formidableModule;


// ======================================================================
// Vercel config — disable body parser untuk multipart
// ======================================================================
const vercelConfig = {
    api: {
        bodyParser: false,
    },
};
module.exports.config = vercelConfig;


// ======================================================================
// Config
// ======================================================================
const SITE = 'https://www.pxbee.com/';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';

const UPLOAD_GATEWAY = 'https://api.fotor.com';
const TASK_GATEWAY = 'https://api.pxbee.com';

const SIGN_PATH = '/api/resource/images/uploader/commonSign';
const UPLOAD_APP_ID = 'app-fotor-web';
const TASK_APP_ID = 'app-pxbee-web';

const MAX_FILE_SIZE = 10 * 1024 * 1024;   // 10 MB
const MAX_POLL_ATTEMPTS = 25;              // 25 × 2s = 50s
const POLL_INTERVAL_MS = 2000;


// ======================================================================
// Utils
// ======================================================================
const uuid = () => crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function deepFind(obj, keys, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const v = deepFind(item, keys, depth + 1);
            if (v) return v;
        }
        return null;
    }
    for (const k of keys) {
        if (obj[k] != null && obj[k] !== '') return obj[k];
    }
    for (const v of Object.values(obj)) {
        const found = deepFind(v, keys, depth + 1);
        if (found) return found;
    }
    return null;
}

function guessMimeFromExt(ext) {
    return {
        'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'webp': 'image/webp', 'gif': 'image/gif', 'bmp': 'image/bmp',
    }[(ext || '').toLowerCase()] || 'image/jpeg';
}

function detectExtFromBuffer(buf) {
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
    if (buf[8] === 0x57 && buf[9] === 0x45) return 'webp';
    return 'jpg';
}


// ======================================================================
// PXBee Client
// ======================================================================
class PXBee {
    constructor() {
        this.jar = new CookieJar();
        this.http = wrapper(axios.create({
            jar: this.jar,
            timeout: 30000,
            headers: {
                'User-Agent': UA,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': SITE.slice(0, -1),
                'Referer': SITE,
            },
            validateStatus: () => true,
        }));
        this.initialized = false;
    }

    async init() {
        if (this.initialized) return;

        const anonId = `1a${Date.now().toString(16)}-${uuid().split('-').slice(0, 3).join('-')}`;

        const sensorData = encodeURIComponent(JSON.stringify({
            distinct_id: anonId,
            first_id: '',
            props: {
                $latest_traffic_source_type: '自然搜索流量',
                $latest_search_keyword: '未取到值',
                $latest_referrer: 'https://www.google.com/',
            },
            $device_id: anonId,
        }));

        const cookieSets = [
            { url: 'https://www.pxbee.com/', cookies: [
                `locale=en_US; Domain=.pxbee.com; Path=/`,
                `clientLocale=en_US; Domain=.pxbee.com; Path=/`,
                `sajssdk_2015_cross_new_user=1; Domain=.pxbee.com; Path=/`,
                `sensorsdata2015jssdkcross=${sensorData}; Domain=.pxbee.com; Path=/`,
            ]},
            { url: 'https://www.fotor.com/', cookies: [
                `locale=en_US; Domain=.fotor.com; Path=/`,
                `clientLocale=en_US; Domain=.fotor.com; Path=/`,
                `sajssdk_2015_cross_new_user=1; Domain=.fotor.com; Path=/`,
                `sensorsdata2015jssdkcross=${sensorData}; Domain=.fotor.com; Path=/`,
            ]},
            { url: 'https://api.fotor.com/', cookies: [
                `locale=en_US; Domain=.fotor.com; Path=/`,
                `clientLocale=en_US; Domain=.fotor.com; Path=/`,
                `sensorsdata2015jssdkcross=${sensorData}; Domain=.fotor.com; Path=/`,
            ]},
            { url: 'https://api.pxbee.com/', cookies: [
                `locale=en_US; Domain=.pxbee.com; Path=/`,
                `clientLocale=en_US; Domain=.pxbee.com; Path=/`,
                `sensorsdata2015jssdkcross=${sensorData}; Domain=.pxbee.com; Path=/`,
            ]},
        ];

        for (const set of cookieSets) {
            for (const c of set.cookies) {
                try { await this.jar.setCookie(c, set.url); } catch {}
            }
        }

        await this.http.get(SITE, {
            headers: { 'Accept': 'text/html,application/xhtml+xml' },
        });

        this.initialized = true;
    }

    async getPresignedUrl(extension, type = 'image') {
        const url = UPLOAD_GATEWAY + SIGN_PATH;
        const res = await this.http.post(url, { extension, type }, {
            headers: {
                'Content-Type': 'application/json',
                'x-app-id': UPLOAD_APP_ID,
            },
        });

        if (res.status !== 200 || !res.data) {
            throw new Error(`CommonSign HTTP ${res.status}`);
        }

        const d = res.data;
        if (d.code !== '000' && d.code !== 0 && d.code !== 200) {
            throw new Error(`CommonSign error: ${d.msg || d.code}`);
        }

        const uploadUrl = d.data?.uploadUrl;
        const downloadUrl = d.data?.downloadUrl;

        if (!uploadUrl || !downloadUrl) {
            throw new Error('CommonSign: incomplete response');
        }

        return { uploadUrl, downloadUrl, key: d.data?.key };
    }

    async uploadBuffer(buffer, ext, mime) {
        const presigned = await this.getPresignedUrl(ext, 'image');

        const res = await axios.put(presigned.uploadUrl, buffer, {
            headers: {
                'Content-Type': mime,
                'Content-Length': buffer.length,
            },
            timeout: 60000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            validateStatus: () => true,
        });

        if (res.status !== 200 && res.status !== 204) {
            throw new Error(`S3 upload HTTP ${res.status}`);
        }

        return presigned.downloadUrl;
    }

    async submitTask(imageUrl, type = 'textremover') {
        const body = {
            type,
            method: 'free',
            data: { userImageUrl: imageUrl },
        };

        const res = await this.http.post(`${TASK_GATEWAY}/task/submit`, body, {
            headers: {
                'Content-Type': 'application/json',
                'x-app-id': TASK_APP_ID,
            },
        });

        if (res.status !== 200 && res.status !== 201) {
            throw new Error(`Submit HTTP ${res.status}`);
        }

        const d = res.data;

        let taskId = null;
        if (Array.isArray(d.data) && d.data.length > 0) {
            taskId = d.data[0].taskId || d.data[0].id;
        } else if (d.data && typeof d.data === 'object') {
            taskId = d.data.taskId || d.data.id;
        }
        if (!taskId) taskId = d.taskId || d.id;

        if (!taskId) {
            throw new Error(`Submit: no taskId in response`);
        }

        return taskId;
    }

    async pollTask(taskId) {
        const doneStates = ['SUCCESS', 'COMPLETED', 'DONE', 'FINISHED', 'READY'];
        const failStates = ['FAILED', 'ERROR', 'CANCELLED'];

        for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
            const url = `${TASK_GATEWAY}/task/get?ids=${taskId}&taskId=${taskId}`;
            const res = await this.http.get(url, {
                headers: { 'x-app-id': TASK_APP_ID },
            });

            if (res.status !== 200) {
                await sleep(POLL_INTERVAL_MS);
                continue;
            }

            const body = res.data;

            let task = null;
            if (Array.isArray(body.data) && body.data.length > 0) {
                task = body.data[0];
            } else if (body.data && typeof body.data === 'object') {
                task = body.data;
            } else {
                task = body;
            }

            const outputUrl = deepFind(task, [
                'outputImageUrl', 'outputUrl', 'resultUrl', 'resultImageUrl',
                'imageUrl', 'cleanedUrl', 'processedUrl', 'downloadUrl', 'url',
            ]);

            const statusRaw = task.status ?? task.taskStatus ?? task.state;
            let statusLabel;
            if (typeof statusRaw === 'number') {
                if (statusRaw >= 2) statusLabel = 'SUCCESS';
                else if (statusRaw < 0) statusLabel = 'FAILED';
                else statusLabel = 'PROCESSING';
            } else {
                statusLabel = String(statusRaw || 'UNKNOWN').toUpperCase();
            }

            if (outputUrl && typeof outputUrl === 'string' && outputUrl.startsWith('http')) {
                return outputUrl;
            }

            if (doneStates.includes(statusLabel)) {
                return outputUrl || null;
            }

            if (failStates.includes(statusLabel)) {
                throw new Error(`Task ${statusLabel}`);
            }

            await sleep(POLL_INTERVAL_MS);
        }

        throw new Error(`Polling timeout after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`);
    }

    async process(buffer, ext, mime) {
        await this.init();

        const imageUrl = await this.uploadBuffer(buffer, ext, mime);
        const taskId = await this.submitTask(imageUrl);
        const outputUrl = await this.pollTask(taskId);

        return { outputUrl, uploadedUrl: imageUrl, taskId };
    }
}


// ======================================================================
// HTTP helpers
// ======================================================================
function ok(res, data) {
    // Same-origin + cache header; CORS gak perlu di-set (request sekarang selalu same-origin).
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data });
}

function err(res, msg, status = 400) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json({ success: false, error: msg });
}

// Parse multipart form-data pakai formidable v3
function parseMultipart(req) {
    return new Promise((resolve, reject) => {
        const form = new IncomingForm({
            maxFileSize: MAX_FILE_SIZE,
            maxTotalFileSize: MAX_FILE_SIZE,
            multiples: false,
            keepExtensions: true,
        });

        form.parse(req, (e, fields, files) => {
            if (e) return reject(e);
            resolve({ fields, files });
        });
    });
}

// Parse JSON body manual (karena bodyParser: false)
function parseJson(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
            if (data.length > 1e6) {
                req.destroy();
                reject(new Error('Body too large'));
            }
        });
        req.on('end', () => {
            if (!data) return resolve({});
            try {
                resolve(JSON.parse(data));
            } catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

// Download image dari URL
async function fetchImageBuffer(url) {
    const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: MAX_FILE_SIZE,
        maxBodyLength: MAX_FILE_SIZE,
        validateStatus: () => true,
        headers: { 'User-Agent': UA },
    });

    if (res.status !== 200) {
        throw new Error(`Fetch image HTTP ${res.status}`);
    }

    const buffer = Buffer.from(res.data);
    if (buffer.length > MAX_FILE_SIZE) {
        throw new Error(`Image too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
    }
    if (buffer.length < 100) {
        throw new Error('Image too small / empty');
    }

    return buffer;
}


// ======================================================================
// Vercel Handler
// ======================================================================
module.exports = async function handler(req, res) {
    const t0 = Date.now();

    // ── CORS ──
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    if (!rateLimit(req, res)) return;
    if (!sameOriginOnly(req, res)) return;


    // ── Health check ──
    if (req.method === 'GET' && !req.query.url) {
        return ok(res, {
            service: 'pxbee-text-remover',
            status: 'ok',
            usage: {
                'POST multipart': 'Upload file dengan field "image"',
                'POST json': '{"imageUrl": "https://..."}',
                'GET': '/api/pxbee?url=https://...',
            },
            limits: {
                maxFileSize: `${MAX_FILE_SIZE / 1024 / 1024} MB`,
                maxDuration: `${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`,
            },
        });
    }

    try {
        let buffer = null;
        let ext = 'jpg';
        let mime = 'image/jpeg';

        // ══════════════════════════════════════════════════════════════
        // Mode 1: GET ?url=...
        // ══════════════════════════════════════════════════════════════
        if (req.method === 'GET' && req.query.url) {
            const url = String(req.query.url);
            if (!/^https?:\/\//i.test(url)) {
                return err(res, 'Query "url" harus berupa http(s) URL');
            }
            buffer = await fetchImageBuffer(url);
            ext = detectExtFromBuffer(buffer);
            mime = guessMimeFromExt(ext);
        }

        // ══════════════════════════════════════════════════════════════
        // Mode 2: POST
        // ══════════════════════════════════════════════════════════════
        else if (req.method === 'POST') {
            const contentType = req.headers['content-type'] || '';

            // ── Mode 2a: JSON body { imageUrl: "..." } ──
            if (contentType.includes('application/json')) {
                const body = await parseJson(req);
                const imageUrl = body.imageUrl || body.url;

                if (!imageUrl) {
                    return err(res, 'Body JSON harus punya field "imageUrl" atau "url"');
                }
                if (!/^https?:\/\//i.test(imageUrl)) {
                    return err(res, 'Field "imageUrl" harus berupa http(s) URL');
                }

                buffer = await fetchImageBuffer(imageUrl);
                ext = detectExtFromBuffer(buffer);
                mime = guessMimeFromExt(ext);
            }

            // ── Mode 2b: Multipart form-data ──
            else if (contentType.includes('multipart/form-data')) {
                let parsed;
                try {
                    parsed = await parseMultipart(req);
                } catch (e) {
                    return err(res, `Multipart parse error: ${e.message}`);
                }

                const { files } = parsed;

                // Cari field image/file (case-insensitive)
                const fileKey = Object.keys(files || {}).find(k =>
                    ['image', 'file', 'photo', 'picture'].includes(k.toLowerCase())
                );

                if (!fileKey) {
                    return err(res, 'Field file tidak ditemukan (gunakan "image" atau "file")');
                }

                const f = Array.isArray(files[fileKey]) ? files[fileKey][0] : files[fileKey];

                if (!f) {
                    return err(res, 'File kosong');
                }

                const fileSize = f.size || 0;
                if (fileSize > MAX_FILE_SIZE) {
                    return err(
                        res,
                        `File terlalu besar (${(fileSize / 1024 / 1024).toFixed(1)} MB, max ${MAX_FILE_SIZE / 1024 / 1024} MB)`,
                        413
                    );
                }

                buffer = require('fs').readFileSync(f.filepath);
                ext = detectExtFromBuffer(buffer);
                mime = guessMimeFromExt(ext);

                // Cleanup temp file
                try { require('fs').unlinkSync(f.filepath); } catch {}
            }

            // ── Content-Type tidak didukung ──
            else {
                return err(res, `Content-Type "${contentType}" tidak didukung. Gunakan multipart/form-data atau application/json`);
            }
        }

        // ── Method lain ──
        else {
            return err(res, 'Method not allowed', 405);
        }

        if (!buffer || buffer.length === 0) {
            return err(res, 'Tidak ada image yang diterima');
        }

        // ══════════════════════════════════════════════════════════════
        // Process dengan PXBee
        // ══════════════════════════════════════════════════════════════
        const client = new PXBee();
        const result = await client.process(buffer, ext, mime);

        if (!result.outputUrl) {
            return err(res, 'PXBee tidak mengembalikan output URL', 502);
        }

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

        return ok(res, {
            url: result.outputUrl,
            taskId: result.taskId,
            uploadedUrl: result.uploadedUrl,
            inputSize: buffer.length,
            inputFormat: ext,
            elapsed: `${elapsed}s`,
        });

    } catch (e) {
        console.error('[pxbee] error:', e.message);
        return err(res, e.message || 'Internal error', 500);
    }
};
