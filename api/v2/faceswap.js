/**
 * Face Swap API — Remaker.ai
 */

const axios = require('axios');
const FormData = require('form-data');
const { Readable } = require('stream');
const { formidable } = require('formidable');
const fs = require('fs');

const { sameOriginOnly, rateLimit } = require('../_lib/security');
module.exports.config = {
    api: {
        bodyParser: false,
        sizeLimit: '25mb',
    },
    maxDuration: 60,
};

const BASE_URL = 'https://api.remaker.ai';
const PRODUCT_CODE = '067003';
const PRODUCT_SERIAL = 'd0556055c62201b80a956de9c4ad7d37';
const MODEL_VERSION = '2';

function makeHeaders(extra = {}) {
    return {
        'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
        'origin': 'https://remaker.ai',
        'referer': 'https://remaker.ai/',
        'product-code': PRODUCT_CODE,
        'product-serial': PRODUCT_SERIAL,
        'authorization': '',
        ...extra,
    };
}

// ============================================================
//  DOWNLOAD HASIL dari CDN Remaker → base64
//  (CDN blok akses langsung tanpa Referer, jadi kita fetch dulu)
// ============================================================
async function fetchOutputAsDataUrl(url) {
    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
                              '(KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
                'Referer': 'https://remaker.ai/',
                'Origin': 'https://remaker.ai',
            },
        });
        const buf = Buffer.from(res.data);
        const ct = res.headers['content-type'] || 'image/png';
        return `data:${ct};base64,${buf.toString('base64')}`;
    } catch (err) {
        return null; // gagal fetch, biar client fallback ke URL asli
    }
}

// ============================================================
//  CREATE JOB
// ============================================================
async function createJob(targetBuffer, swapBuffer) {
    const form = new FormData();

    form.append('target_image', Readable.from(targetBuffer), {
        filename: 'target.jpg',
        contentType: 'image/jpeg',
    });
    form.append('swap_image', Readable.from(swapBuffer), {
        filename: 'source.jpg',
        contentType: 'image/jpeg',
    });
    form.append('version', MODEL_VERSION);

    const res = await axios.post(
        `${BASE_URL}/api/pai/v3/ai-facevary/appapi/create-job`,
        form,
        {
            headers: {
                ...form.getHeaders(),
                ...makeHeaders(),
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 60000,
        }
    );

    const data = res.data;
    if (data.code !== 100000 || !data.result?.job_id) {
        throw new Error(`create-job gagal: ${JSON.stringify(data).slice(0, 250)}`);
    }

    return {
        jobId: data.result.job_id,
        targetUrl: data.result.target_image,
        swapUrl: data.result.swap_image,
    };
}

// ============================================================
//  POLLING JOB
// ============================================================
async function waitForJob(jobId, maxWaitMs = 55000) {
    const start = Date.now();
    let attempt = 0;

    while (Date.now() - start < maxWaitMs) {
        await new Promise(r => setTimeout(r, 4000));
        attempt++;

        try {
            const res = await axios.get(
                `${BASE_URL}/api/pai/v3/ai-facevary/appapi/get-job/${jobId}`,
                { headers: makeHeaders(), timeout: 30000 }
            );

            const d = res.data;
            const result = d.result || {};
            const urls = result.output_image_url;
            const msg = d.message?.en || '';

            if (urls && urls.length > 0) return urls;

            if (
                d.code === 100002 ||
                d.code === 300006 ||
                (d.code === 100000 && !urls)
            ) {
                continue;
            }

            if (
                msg.includes('failed') ||
                msg.includes('not found') ||
                msg.includes('no face') ||
                msg.includes('no human')
            ) {
                throw new Error(`Job gagal: ${msg}`);
            }

            throw new Error(`Job error (code ${d.code}): ${msg}`);
        } catch (e) {
            if (
                e.message.startsWith('Job gagal') ||
                e.message.startsWith('Job error')
            ) {
                throw e;
            }
        }
    }

    throw new Error(`Timeout ${maxWaitMs}ms nunggu job ${jobId}`);
}

// ============================================================
//  FULL FLOW
// ============================================================
async function faceSwap(sourceBuffer, targetBuffer) {
    const { jobId, targetUrl, swapUrl } = await createJob(targetBuffer, sourceBuffer);
    const outputUrls = await waitForJob(jobId);

    // 🔥 Fetch hasilnya jadi base64 biar browser bisa liat
    const outputDataUrl = await fetchOutputAsDataUrl(outputUrls[0]);

    return { jobId, outputUrls, outputDataUrl, targetUrl, swapUrl };
}

// ============================================================
//  PARSING HELPERS
// ============================================================
function parseForm(req) {
    return new Promise((resolve, reject) => {
        const form = formidable({
            maxFileSize: 15 * 1024 * 1024,
            maxTotalFileSize: 25 * 1024 * 1024,
            multiples: false,
            filter: (part) => part.mimetype?.startsWith('image/') ?? true,
        });
        form.parse(req, (err, fields, files) => {
            if (err) return reject(err);
            resolve({ fields, files });
        });
    });
}

function getFile(files, key) {
    const f = files[key];
    if (!f) return null;
    const file = Array.isArray(f) ? f[0] : f;
    if (!file) return null;
    return fs.readFileSync(file.filepath);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > 1_000_000) {
                reject(new Error('Body terlalu besar'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

async function fetchAsBuffer(url) {
    const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
    });
    return Buffer.from(res.data);
}

// ============================================================
//  HANDLER UTAMA
// ============================================================
module.exports = async function handler(req, res) {

    if (req.method === 'OPTIONS') return res.status(204).end();
  if (!rateLimit(req, res)) return;
  if (!sameOriginOnly(req, res)) return;


    if (req.method !== 'POST') {
        return res.status(405).json({
            success: false,
            error: 'Method not allowed. Gunakan POST.',
        });
    }

    const contentType = req.headers['content-type'] || '';
    const startedAt = Date.now();

    try {
        let sourceBuf, targetBuf;

        if (contentType.includes('multipart/form-data')) {
            const { files } = await parseForm(req);
            sourceBuf = getFile(files, 'source');
            targetBuf = getFile(files, 'target');

            if (!sourceBuf || !targetBuf) {
                return res.status(400).json({
                    success: false,
                    error: 'Butuh 2 file: "source" dan "target"',
                });
            }
        } else if (contentType.includes('application/json')) {
            const body = await readJsonBody(req);
            const { source_url, target_url } = body;

            if (!source_url || !target_url) {
                return res.status(400).json({
                    success: false,
                    error: 'Butuh "source_url" dan "target_url"',
                });
            }

            [sourceBuf, targetBuf] = await Promise.all([
                fetchAsBuffer(source_url),
                fetchAsBuffer(target_url),
            ]);
        } else {
            return res.status(400).json({
                success: false,
                error: 'Content-Type harus multipart/form-data atau application/json',
            });
        }

        if (sourceBuf.length > 15_000_000 || targetBuf.length > 15_000_000) {
            return res.status(400).json({
                success: false,
                error: 'Gambar max 15 MB',
            });
        }

        const result = await faceSwap(sourceBuf, targetBuf);

        return res.json({
            success: true,
            data: {
                jobId: result.jobId,
                outputUrls: result.outputUrls,
                outputDataUrl: result.outputDataUrl, // 🔥 base64 buat preview
                targetUrl: result.targetUrl,
                swapUrl: result.swapUrl,
                elapsedMs: Date.now() - startedAt,
            },
        });
    } catch (err) {
        console.error('[faceswap]', err.message);
        return res.status(500).json({
            success: false,
            error: err.message || 'Face swap gagal',
            elapsedMs: Date.now() - startedAt,
        });
    }
};
