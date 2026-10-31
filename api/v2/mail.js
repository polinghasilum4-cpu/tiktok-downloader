/**
 * Temp Mail API — proxy ke mail.tm
 * 
 * POST /api/v2/mail
 * Content-Type: application/json
 * 
 * Body:
 *   { action: 'create' }                              → bikin akun baru
 *   { action: 'me',     token: '<jwt>' }              → info user
 *   { action: 'inbox',  token: '<jwt>' }              → list pesan
 *   { action: 'read',   token: '<jwt>', id: '<msgId>'} → baca pesan
 *   { action: 'delete', token: '<jwt>', id: '<msgId>'} → hapus pesan
 * 
 * Response:
 *   { success: true, data: {...} }
 */

const axios = require('axios');

const { sameOriginOnly, rateLimit } = require('../_lib/security');
const MAILTM_API = 'https://api.mail.tm';

// Vercel config
module.exports.config = {
    api: {
        bodyParser: {
            sizeLimit: '1mb',
        },
    },
    maxDuration: 30,
};

// ============================================================
//  HELPERS
// ============================================================
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';

function genUsername() {
    const hex = Array.from({ length: 8 }, () =>
        Math.floor(Math.random() * 16).toString(16)
    ).join('');
    const num = Math.floor(Math.random() * 90) + 10;
    return `${hex}${num}`;
}

function genPassword() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
    let pwd = '';
    for (let i = 0; i < 14; i++) {
        pwd += chars[Math.floor(Math.random() * chars.length)];
    }
    return pwd;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function mailFetch(path, opts = {}) {
    const headers = {
        'accept': 'application/json',
        'user-agent': UA,
        ...(opts.headers || {}),
    };

    const res = await axios({
        url: `${MAILTM_API}${path}`,
        method: opts.method || 'GET',
        headers,
        data: opts.body,
        timeout: 20000,
        validateStatus: () => true,
    });

    return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        data: res.data,
    };
}

// ============================================================
//  ACTIONS
// ============================================================

// -------- CREATE ACCOUNT --------
async function actionCreate() {
    // 1. Get domains
    const domRes = await mailFetch('/domains?page=1');
    if (!domRes.ok) {
        throw new Error(`Get domains gagal: HTTP ${domRes.status}`);
    }

    const members = Array.isArray(domRes.data)
        ? domRes.data
        : (domRes.data['hydra:member'] || []);

    const active = members.filter(d =>
        d && d.isActive !== false && d.is_active !== false
    );

    if (!active.length) {
        throw new Error('Gak ada domain aktif');
    }

    const domain = active[0].domain;

    // 2. Register + login dengan retry
    const maxRetry = 5;
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
        const username = genUsername();
        const password = genPassword();
        const address = `${username}@${domain}`;

        try {
            // Register
            const reg = await mailFetch('/accounts', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: { address, password },
            });

            if (!reg.ok) {
                console.log(`[mail] register attempt ${attempt} fail:`,
                    reg.data?.detail || reg.data?.message || reg.status);
                await sleep(800);
                continue;
            }

            // Login
            const login = await mailFetch('/token', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: { address, password },
            });

            if (!login.ok || !login.data?.token) {
                console.log(`[mail] login attempt ${attempt} fail:`, login.status);
                await sleep(800);
                continue;
            }

            return {
                email: address,
                password: password,
                token: login.data.token,
                id: login.data.id,
                domain: domain,
            };
        } catch (e) {
            console.log(`[mail] attempt ${attempt} error:`, e.message);
            await sleep(800);
        }
    }

    throw new Error(`Gagal bikin akun setelah ${maxRetry} percobaan`);
}

// -------- ME --------
async function actionMe(token) {
    if (!token) throw new Error('token wajib');

    const res = await mailFetch('/me', {
        headers: { 'authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
        throw new Error(`Get me gagal: HTTP ${res.status}`);
    }

    return res.data;
}

// -------- INBOX --------
async function actionInbox(token, page = 1) {
    if (!token) throw new Error('token wajib');

    const res = await mailFetch(`/messages?page=${page}`, {
        headers: { 'authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
        throw new Error(`Get inbox gagal: HTTP ${res.status}`);
    }

    const members = Array.isArray(res.data)
        ? res.data
        : (res.data['hydra:member'] || []);

    return {
        count: members.length,
        messages: members.map(m => ({
            id: m.id,
            from: {
                address: m.from?.address || '',
                name: m.from?.name || '',
            },
            subject: m.subject || '(tanpa subjek)',
            intro: m.intro || '',
            createdAt: m.createdAt,
            hasAttachments: m.hasAttachments || false,
            size: m.size || 0,
        })),
    };
}

// -------- READ --------
async function actionRead(token, id) {
    if (!token) throw new Error('token wajib');
    if (!id) throw new Error('id wajib');

    const res = await mailFetch(`/messages/${id}`, {
        headers: { 'authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
        throw new Error(`Read message gagal: HTTP ${res.status}`);
    }

    const m = res.data;

    // Body text — prefer text, fallback strip html
    let body = '';
    if (m.text) {
        body = m.text;
    } else if (m.html) {
        const raw = Array.isArray(m.html) ? m.html.join('') : m.html;
        body = raw.replace(/<[^>]+>/g, ' ')
                  .replace(/&nbsp;/g, ' ')
                  .replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/\s+/g, ' ')
                  .trim();
    }

    return {
        id: m.id,
        from: {
            address: m.from?.address || '',
            name: m.from?.name || '',
        },
        to: (m.to || []).map(t => ({
            address: t.address || '',
            name: t.name || '',
        })),
        subject: m.subject || '(tanpa subjek)',
        body: body || '(pesan kosong)',
        createdAt: m.createdAt,
        hasAttachments: m.hasAttachments || false,
        attachments: (m.attachments || []).map(a => ({
            id: a.id,
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
            downloadUrl: a.downloadUrl,
        })),
    };
}

// -------- DELETE --------
async function actionDelete(token, id) {
    if (!token) throw new Error('token wajib');
    if (!id) throw new Error('id wajib');

    const res = await mailFetch(`/messages/${id}`, {
        method: 'DELETE',
        headers: { 'authorization': `Bearer ${token}` },
    });

    return { deleted: res.ok, status: res.status };
}

// ============================================================
//  HANDLER UTAMA
// ============================================================
module.exports = async function handler(req, res) {
    // CORS

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
  if (!rateLimit(req, res)) return;
  if (!sameOriginOnly(req, res)) return;


    // GET → info endpoint
    if (req.method === 'GET') {
        return res.json({
            success: true,
            info: 'Temp Mail API — proxy ke mail.tm',
            usage: 'POST with JSON body { action, token?, id? }',
            actions: [
                { action: 'create',          body: '{}' },
                { action: 'me',              body: '{ token }' },
                { action: 'inbox',           body: '{ token, page? }' },
                { action: 'read',            body: '{ token, id }' },
                { action: 'delete',          body: '{ token, id }' },
            ],
        });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({
            success: false,
            error: 'Method not allowed. Gunakan POST.',
        });
    }

    const startedAt = Date.now();

    try {
        // Body bisa object (Vercel auto-parse) atau string
        let body = req.body;
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch (_) {
                body = {};
            }
        }
        if (!body || typeof body !== 'object') body = {};

        const { action, token, id, page } = body;

        if (!action) {
            return res.status(400).json({
                success: false,
                error: 'Field "action" wajib. Pilih: create / me / inbox / read / delete',
            });
        }

        let data;

        switch (action) {
            case 'create':
                data = await actionCreate();
                break;

            case 'me':
                data = await actionMe(token);
                break;

            case 'inbox':
                data = await actionInbox(token, page || 1);
                break;

            case 'read':
                data = await actionRead(token, id);
                break;

            case 'delete':
                data = await actionDelete(token, id);
                break;

            default:
                return res.status(400).json({
                    success: false,
                    error: `Action "${action}" gak dikenal. Pilih: create / me / inbox / read / delete`,
                });
        }

        return res.json({
            success: true,
            data,
            elapsedMs: Date.now() - startedAt,
        });
    } catch (err) {
        console.error('[mail]', err.message);
        return res.status(500).json({
            success: false,
            error: err.message || 'Temp mail gagal',
            elapsedMs: Date.now() - startedAt,
        });
    }
};
