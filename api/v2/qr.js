const QRCode = require('qrcode');
const validator = require('validator');

const { sameOriginOnly, rateLimit } = require('../_lib/security');
// Manual parser untuk body JSON (Vercel kadang gak auto-parse)
function parseBody(req) {
    return new Promise((resolve, reject) => {
        // Kalau Vercel sudah parse, pakai langsung
        if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
            return resolve(req.body);
        }
        if (typeof req.body === 'string') {
            try {
                return resolve(JSON.parse(req.body));
            } catch {
                return resolve({});
            }
        }

        // Manual parse dari stream
        let data = '';
        req.on('data', chunk => {
            data += chunk.toString('utf8');
            if (data.length > 1e6) {
                req.destroy();
                reject(new Error('Body terlalu besar'));
            }
        });
        req.on('end', () => {
            if (!data) return resolve({});
            try {
                resolve(JSON.parse(data));
            } catch {
                // Fallback: coba URL-encoded
                try {
                    const params = new URLSearchParams(data);
                    resolve(Object.fromEntries(params));
                } catch {
                    resolve({});
                }
            }
        });
        req.on('error', reject);
    });
}

module.exports = async (req, res) => {
    // CORS

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
  if (!rateLimit(req, res)) return;
  if (!sameOriginOnly(req, res)) return;


    if (req.method !== 'POST') {
        return res.status(405).json({
            status: 'error',
            message: 'Method tidak diizinkan. Gunakan POST!'
        });
    }

    try {
        // 🎯 Parse body manual
        const body = await parseBody(req);
        console.log('[qr] body:', JSON.stringify(body));

        let { link, qrTitle } = body || {};

        // Fallback: cek query string juga
        if (!link && req.query && req.query.link) {
            link = req.query.link;
            qrTitle = qrTitle || req.query.qrTitle;
        }

        if (!link || typeof link !== 'string') {
            return res.status(400).json({
                status: 'error',
                message: 'Parameter "link" wajib diisi!',
                debug: {
                    bodyReceived: body,
                    contentType: req.headers['content-type'],
                    method: req.method,
                }
            });
        }

        link = link.trim();

        // Auto-prepend https kalau gak ada protocol
        if (!/^https?:\/\//i.test(link)) {
            link = 'https://' + link;
        }

        if (!validator.isURL(link, { require_protocol: true })) {
            return res.status(400).json({
                status: 'error',
                message: 'URL tidak valid! Wajib menyertakan http:// atau https://'
            });
        }

        const qrDataUrl = await QRCode.toDataURL(link, {
            errorCorrectionLevel: 'H',
            type: 'image/png',
            margin: 2,
            width: 300
        });

        return res.status(200).json({
            status: 'success',
            title: qrTitle || 'QR Code',
            target_link: link,
            qr_image: qrDataUrl
        });

    } catch (error) {
        console.error('[qr] error:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Gagal membuat QR Code',
            detail: error.message
        });
    }
};
