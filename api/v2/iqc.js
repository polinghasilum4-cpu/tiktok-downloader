const { sameOriginOnly, rateLimit } = require('../_lib/security');
/* ============================================================
   api/v2/iqc.js — Fake Quote iOS proxy
   Endpoint: GET /api/v2/iqc?text=<QUOTE_TEXT>
   Proxy ke izuka-api canvas, return image langsung
   ============================================================ */

const IZUKA_API = 'https://my.izuka-api.xyz/api/canvas/iqc';

module.exports = async (req, res) => {
  // CORS
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!rateLimit(req, res)) return;
  if (!sameOriginOnly(req, res)) return;


  const text = (req.query.text || '').trim();
  if (!text) {
    return res.status(400).json({ success: false, error: 'Parameter "text" wajib' });
  }
  if (text.length > 500) {
    return res.status(400).json({ success: false, error: 'Text max 500 karakter' });
  }

  const apiUrl = `${IZUKA_API}?text=${encodeURIComponent(text)}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);

    const upstream = await fetch(apiUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
        'accept': 'image/*,*/*',
        'referer': 'https://my.izuka-api.xyz/',
      },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        success: false,
        error: `Upstream HTTP ${upstream.status}`,
      });
    }

    const ct = upstream.headers.get('content-type') || 'image/png';

    // Kalau upstream balikin JSON (error case)
    if (ct.includes('application/json')) {
      const j = await upstream.json();
      return res.status(502).json({ success: false, error: j.error || j.message || 'Upstream error', raw: j });
    }

    // Stream image ke client
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Image-Size', buf.length);
    return res.status(200).send(buf);

  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    return res.status(isTimeout ? 504 : 500).json({
      success: false,
      error: isTimeout ? 'Timeout (25s) — izuka-api gak respon' : err.message,
    });
  }
};
