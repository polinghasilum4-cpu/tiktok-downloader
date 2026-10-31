const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const FormData = require('form-data');
const crypto = require('crypto');
const formidableModule = require('formidable');
const { sameOriginOnly, rateLimit } = require('../_lib/security');
const IncomingForm = formidableModule.IncomingForm || formidableModule.default || formidableModule.formidable || formidableModule;

const BASE = 'https://easyfaceswap.com';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
const MAX_FILE = 30 * 1024 * 1024;

// Public CORS proxy — dipakai kalau IP Vercel ditolak
const PROXIES = [
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?url=',
    'https://api.codetabs.com/v1/proxy?quest=',
];

module.exports.config = { api: { bodyParser: false } };

// Cache device + ticket (module-level, persist antar warm invocation)
let CACHE = { deviceId: null, ticket: null, expiresAt: 0 };

const ok = (res, data) => { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json({ success: true, data }); };
const err = (res, msg, status = 400, extra = {}) => { res.setHeader('Cache-Control', 'no-store'); return res.status(status).json({ success: false, error: msg, ...extra }); };
const trace = () => crypto.randomUUID();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function deepFind(obj, keys, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    for (const k of keys) if (obj[k] != null && obj[k] !== '') return obj[k];
    for (const v of Object.values(obj)) {
        const f = deepFind(v, keys, depth + 1);
        if (f) return f;
    }
    return null;
}

function newHttp(jar) {
    return wrapper(axios.create({
        jar,
        headers: {
            'User-Agent': UA,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Origin': BASE,
            'Referer': `${BASE}/video-face-swap/`,
        },
        validateStatus: () => true,
        timeout: 60000,
    }));
}

// Request via proxy (kalau IP Vercel ditolak)
async function proxyPost(proxy, url, body, extraHeaders = {}) {
    const fullUrl = proxy + encodeURIComponent(url);
    const res = await axios.post(fullUrl, body, {
        headers: {
            'User-Agent': UA,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...extraHeaders,
        },
        timeout: 60000,
        validateStatus: () => true,
        maxBodyLength: Infinity,
    });
    let data = res.data;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch {}
    }
    return { status: res.status, data };
}

async function proxyGet(proxy, url) {
    const fullUrl = proxy + encodeURIComponent(url);
    const res = await axios.get(fullUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        timeout: 60000,
        validateStatus: () => true,
    });
    let data = res.data;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch {}
    }
    return { status: res.status, data };
}

// ── Ambil device + ticket dengan auto-proxy fallback ──
async function getSession() {
    if (CACHE.deviceId && CACHE.ticket && Date.now() < CACHE.expiresAt) {
        return CACHE;
    }

    // Coba langsung dulu
    for (let i = 0; i < 3; i++) {
        try {
            const jar = new CookieJar();
            const http = newHttp(jar);

            await http.get(`${BASE}/video-face-swap/`);

            const sess = await http.get(`${BASE}/api/device/session`, {
                headers: { 'x-workbench-kind': 'face-video', 'x-workbench-trace-id': trace() },
            });
            const deviceId = deepFind(sess.data, ['anonymousDeviceId', 'deviceId']);
            if (!deviceId) continue;

            await jar.setCookie(`fj_device=${deviceId}; Path=/; Domain=.easyfaceswap.com`, BASE);
            await sleep(1500);

            const auth = await http.post(`${BASE}/api/face-video/authorize`, {
                anonymousDeviceId: deviceId,
                requestId: crypto.randomUUID(),
            }, {
                headers: {
                    'x-workbench-kind': 'face-video',
                    'x-workbench-trace-id': trace(),
                    'x-anonymous-device-id': deviceId,
                },
            });

            const ticket = deepFind(auth.data, ['ticket']);
            if (ticket) {
                CACHE = { deviceId, ticket, expiresAt: Date.now() + 5 * 60 * 1000 };
                return CACHE;
            }
        } catch {}
        await sleep(1000);
    }

    // Fallback: pakai proxy publik
    for (const proxy of PROXIES) {
        try {
            const sess = await proxyGet(proxy, `${BASE}/api/device/session`);
            const deviceId = deepFind(sess.data, ['anonymousDeviceId', 'deviceId']);
            if (!deviceId) continue;

            await sleep(1500);

            const auth = await proxyPost(proxy, `${BASE}/api/face-video/authorize`, {
                anonymousDeviceId: deviceId,
                requestId: crypto.randomUUID(),
            }, {
                'x-workbench-kind': 'face-video',
                'x-workbench-trace-id': trace(),
                'x-anonymous-device-id': deviceId,
                'Cookie': `fj_device=${deviceId}`,
            });

            const ticket = deepFind(auth.data, ['ticket']);
            if (ticket) {
                CACHE = { deviceId, ticket, expiresAt: Date.now() + 5 * 60 * 1000, proxy };
                return CACHE;
            }
        } catch {}
    }

    throw new Error('Gagal ambil ticket. Coba lagi.');
}

async function processFaceSwap(videoBuffer, faceBuffer) {
    const { deviceId, ticket, proxy } = await getSession();

    const doUploadSign = async (files) => {
        if (proxy) {
            const r = await proxyPost(proxy, `${BASE}/api/face-video/upload-sign`, {
                functionTag: 'videofaceswap', files,
            }, {
                'x-workbench-kind': 'face-video',
                'x-workbench-trace-id': trace(),
                'x-anonymous-ticket': ticket,
                'x-anonymous-device-id': deviceId,
                'Cookie': `fj_device=${deviceId}`,
            });
            return deepFind(r.data, ['uploads']) || [];
        }
        const jar = new CookieJar();
        const http = newHttp(jar);
        await jar.setCookie(`fj_device=${deviceId}; Path=/; Domain=.easyfaceswap.com`, BASE);
        const r = await http.post(`${BASE}/api/face-video/upload-sign`, {
            functionTag: 'videofaceswap', files,
        }, {
            headers: { 'x-workbench-kind': 'face-video', 'x-workbench-trace-id': trace() },
        });
        return deepFind(r.data, ['uploads']) || [];
    };

    const videoFn = crypto.randomBytes(50).toString('base64url') + '.mp4';
    const faceFn = 'face_' + Date.now() + '.jpg';

    const uploads = await doUploadSign([
        { filename: videoFn, contentType: 'video/mp4', size: videoBuffer.length },
        { filename: faceFn, contentType: 'image/jpeg', size: faceBuffer.length },
    ]);

    if (uploads.length < 2) throw new Error('Upload sign gagal');
    const videoUp = uploads[0], faceUp = uploads[1];

    // Upload ke S3 langsung (gak perlu proxy, S3 gak filter)
    await axios.put(videoUp.uploadUrl, videoBuffer, {
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': videoBuffer.length },
        maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 120000, validateStatus: () => true,
    });
    await axios.put(faceUp.uploadUrl, faceBuffer, {
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': faceBuffer.length },
        maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 120000, validateStatus: () => true,
    });

    const hdrs = {
        'x-workbench-kind': 'face-video',
        'x-workbench-trace-id': trace(),
        'x-anonymous-ticket': ticket,
        'x-anonymous-device-id': deviceId,
        'Cookie': `fj_device=${deviceId}`,
    };

    // UUID
    let uuidRes;
    if (proxy) {
        uuidRes = await proxyPost(proxy, `${BASE}/api/face-video/uuid`, { functionTag: 'videofaceswap' }, hdrs);
    } else {
        const jar = new CookieJar();
        const http = newHttp(jar);
        await jar.setCookie(`fj_device=${deviceId}; Path=/; Domain=.easyfaceswap.com`, BASE);
        uuidRes = await http.post(`${BASE}/api/face-video/uuid`, { functionTag: 'videofaceswap' }, { headers: hdrs });
    }
    const uId = typeof uuidRes.data === 'string' ? uuidRes.data : deepFind(uuidRes.data, ['uId']);
    if (!uId) throw new Error('UUID gagal');

    // Sign
    const signBody = {
        modelfile: videoUp.cdnUrl, imagefile: [faceUp.cdnUrl], imagefile2: [],
        priority: '1', uId, aiFunAction: 'videofaceswap', platFormId: '',
        check: '0', pointId: deviceId, consumeType: 'Customizeswapvideo', requestType: '1',
    };
    let signRes;
    if (proxy) {
        signRes = await proxyPost(proxy, `${BASE}/api/face-video/sign`, signBody, hdrs);
    } else {
        const jar = new CookieJar();
        const http = newHttp(jar);
        await jar.setCookie(`fj_device=${deviceId}; Path=/; Domain=.easyfaceswap.com`, BASE);
        signRes = await http.post(`${BASE}/api/face-video/sign`, signBody, { headers: hdrs });
    }
    const decrypt = deepFind(signRes.data, ['decrypt']);
    const sign = deepFind(signRes.data, ['sign']);
    if (!decrypt || !sign) {
        CACHE = { deviceId: null, ticket: null, expiresAt: 0 };
        throw new Error('Sign gagal');
    }

    // Submit
    const fd = new FormData();
    fd.append('decrypt', decrypt);
    fd.append('pkgName', 'com.enjoy.facejoy.web');
    fd.append('sign', sign);
    fd.append('content', JSON.stringify({ enhancerEnable: false }));
    fd.append('uId', uId);
    fd.append('version', '3');
    fd.append('anonymousDeviceId', deviceId);
    fd.append('uuId', deviceId);
    fd.append('pointId', deviceId);

    const submitHeaders = { ...fd.getHeaders(), ...hdrs, 'Accept': '*/*' };
    let submitRes;
    if (proxy) {
        // Proxy + multipart gak reliable, pakai direct
        const jar = new CookieJar();
        const http = newHttp(jar);
        await jar.setCookie(`fj_device=${deviceId}; Path=/; Domain=.easyfaceswap.com`, BASE);
        submitRes = await http.post(`${BASE}/api/face-video/submit`, fd, { headers: submitHeaders });
    } else {
        const jar = new CookieJar();
        const http = newHttp(jar);
        await jar.setCookie(`fj_device=${deviceId}; Path=/; Domain=.easyfaceswap.com`, BASE);
        submitRes = await http.post(`${BASE}/api/face-video/submit`, fd, { headers: submitHeaders });
    }
    const obtainKey = deepFind(submitRes.data, ['obtainKey']);
    if (!obtainKey) throw new Error('Submit gagal: ' + JSON.stringify(submitRes.data).slice(0, 150));

    // Poll
    for (let i = 0; i < 8; i++) {
        await sleep(5000);
        let r;
        if (proxy) {
            r = await proxyPost(proxy, `${BASE}/api/face-video/result`, { obtainKey }, hdrs);
        } else {
            const jar = new CookieJar();
            const http = newHttp(jar);
            await jar.setCookie(`fj_device=${deviceId}; Path=/; Domain=.easyfaceswap.com`, BASE);
            r = await http.post(`${BASE}/api/face-video/result`, { obtainKey }, { headers: hdrs });
        }
        const url = deepFind(r.data, ['url', 'videoUrl', 'resultUrl']);
        const state = deepFind(r.data, ['state', 'status']);
        if (url) return { url, state, obtainKey };
        if (state === 'failed' || state === 'error') throw new Error('Task failed');
    }
    return { url: null, state: 'processing', obtainKey };
}

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') { return res.status(204).end(); }
    if (!rateLimit(req, res)) return;
    if (!sameOriginOnly(req, res)) return;

    if (req.method === 'GET') {
        return ok(res, { service: 'video-face-swap', status: 'ok', mode: 'auto' });
    }

    if (req.method !== 'POST') return err(res, 'Method not allowed', 405);

    const t0 = Date.now();
    try {
        let videoBuffer, faceBuffer;
        const ct = req.headers['content-type'] || '';

        if (ct.includes('multipart/form-data')) {
            const { files } = await new Promise((resolve, reject) => {
                const form = new IncomingForm({ maxFileSize: MAX_FILE, maxTotalFileSize: MAX_FILE * 2, multiples: true, keepExtensions: true });
                form.parse(req, (e, f, files) => e ? reject(e) : resolve({ fields: f, files }));
            });
            const map = {};
            for (const k of Object.keys(files || {})) {
                const f = Array.isArray(files[k]) ? files[k][0] : files[k];
                map[k.toLowerCase()] = f;
            }
            const vF = map['video'] || map['source'];
            const fF = map['face'] || map['image'];
            if (!vF || !fF) return err(res, 'Wajib upload "video" dan "face"', 400);
            videoBuffer = require('fs').readFileSync(vF.filepath);
            faceBuffer = require('fs').readFileSync(fF.filepath);
            try { require('fs').unlinkSync(vF.filepath); } catch {}
            try { require('fs').unlinkSync(fF.filepath); } catch {}
        } else if (ct.includes('application/json')) {
            let data = '';
            await new Promise(r => { req.on('data', c => data += c); req.on('end', r); });
            const body = JSON.parse(data || '{}');
            const vUrl = body.videoUrl || body.video;
            const fUrl = body.faceUrl || body.face;
            if (!vUrl || !fUrl) return err(res, 'Body butuh "videoUrl" dan "faceUrl"', 400);
            const [vr, fr] = await Promise.all([
                axios.get(vUrl, { responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true, headers: { 'User-Agent': UA } }),
                axios.get(fUrl, { responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true, headers: { 'User-Agent': UA } }),
            ]);
            if (vr.status !== 200) return err(res, `Fetch video HTTP ${vr.status}`, 502);
            if (fr.status !== 200) return err(res, `Fetch face HTTP ${fr.status}`, 502);
            videoBuffer = Buffer.from(vr.data);
            faceBuffer = Buffer.from(fr.data);
        } else {
            return err(res, 'Content-Type harus multipart atau json', 415);
        }

        if (videoBuffer.length > MAX_FILE || faceBuffer.length > MAX_FILE) {
            return err(res, `File max ${MAX_FILE / 1024 / 1024} MB`, 413);
        }

        const result = await processFaceSwap(videoBuffer, faceBuffer);

        return ok(res, {
            url: result.url,
            status: result.url ? 'done' : result.state,
            obtainKey: result.obtainKey,
            elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
        });
    } catch (e) {
        console.error('[faceswap]', e.message);
        return err(res, e.message, 500, { elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s` });
    }
};
