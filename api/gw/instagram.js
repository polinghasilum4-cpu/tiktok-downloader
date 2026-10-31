const { sameOriginOnly, rateLimit } = require('../_lib/security');
/* ============================================================
 *  Instagram Downloader API — by xs0ciety
 *  Auto-scrape token dari savefromins.com
 *  Endpoint: GET /api/v2/instagram?url=<instagram_url>
 * ============================================================ */

const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";
const BASE = "https://savefromins.com";

// Token cache
let cachedToken = null;
let cachedAt = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 menit

// ============================================================
//  SCRAPE TOKEN
// ============================================================
async function scrapeToken() {
  console.log("[ig] Scrape token dari savefromins...");
  try {
    const htmlRes = await fetch(BASE + "/", {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    const html = await htmlRes.text();

    const jsUrls = [];
    const regex = /<script[^>]+src="([^"]+)"/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      let u = m[1];
      if (!u.startsWith("http")) {
        u = BASE + (u.startsWith("/") ? "" : "/") + u;
      }
      jsUrls.push(u);
    }

    console.log(`[ig] Found ${jsUrls.length} JS files`);

    const patterns = [
      /auth["']?\s*[:=]\s*["'](2025\d{4}[a-z0-9]{6,})["']/i,
      /["'](2025\d{4}[a-z0-9]{6,})["']/i,
      /(2025\d{4}[a-z0-9]{6,})/i,
    ];

    for (const u of jsUrls) {
      try {
        const jsRes = await fetch(u, {
          headers: { "user-agent": UA },
          signal: AbortSignal.timeout(5000),
        });
        const js = await jsRes.text();

        for (const p of patterns) {
          const match = js.match(p);
          if (match && match[1]) {
            console.log(`[ig] ✓ Token: ${match[1]}`);
            return match[1];
          }
        }
      } catch (e) {}
    }
  } catch (e) {
    console.warn("[ig] Scrape error:", e.message);
  }
  return null;
}

// ============================================================
//  GET TOKEN
// ============================================================
async function getToken(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh && cachedToken && (now - cachedAt) < CACHE_TTL) {
    return cachedToken;
  }

  const fresh = await scrapeToken();
  if (fresh) {
    cachedToken = fresh;
    cachedAt = now;
    return fresh;
  }

  if (cachedToken) return cachedToken;

  cachedToken = "20250901majwlqo";
  cachedAt = now;
  return cachedToken;
}

// ============================================================
//  PARSE IG
// ============================================================
async function parseIg(igUrl, token) {
  const body = new URLSearchParams({
    auth: token,
    domain: "api-ak.savefromins.com",
    origin: "source",
    link: igUrl,
  });

  const headers = {
    "accept": "*/*",
    "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/x-www-form-urlencoded",
    "origin": BASE,
    "referer": BASE + "/",
    "user-agent": UA,
    "sec-ch-ua": '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "priority": "u=1, i",
    // Spoof IP Indonesia
    "x-forwarded-for": "103.47.132.1",
    "x-real-ip": "103.47.132.1",
  };

  const r = await fetch("https://api.savefromins.com/api/contentsite_api/media/parse", {
    method: "POST",
    headers,
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  });

  const text = await r.text();
  try {
    return { status: r.status, data: JSON.parse(text) };
  } catch (e) {
    return { status: r.status, data: null, raw: text.slice(0, 500) };
  }
}

// ============================================================
//  HANDLER
// ============================================================
module.exports = async (req, res) => {
  // CORS
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!rateLimit(req, res)) return;
  if (!sameOriginOnly(req, res)) return;


  const igUrl = req.query.url;
  if (!igUrl) {
    return res.status(400).json({ status: false, error: "Parameter 'url' wajib diisi" });
  }
  if (!igUrl.includes("instagram.com")) {
    return res.status(400).json({ status: false, error: "URL harus dari Instagram" });
  }

  try {
    // Attempt 1
    let token = await getToken();
    let result = await parseIg(igUrl, token);
    console.log(`[ig] Attempt 1: status=${result.status}, code=${result.data?.status_code}`);

    // Attempt 2 — refresh token
    if (!result.data || result.data.status_code !== "success") {
      console.log("[ig] Refresh token & retry...");
      token = await getToken(true);
      await new Promise(r => setTimeout(r, 800));
      result = await parseIg(igUrl, token);
      console.log(`[ig] Attempt 2: status=${result.status}, code=${result.data?.status_code}`);
    }

    // Gagal
    if (!result.data || result.data.status_code !== "success") {
      return res.status(502).json({
        status: false,
        error: result.data?.msg || "analyze failed",
        upstream_status: result.status,
        upstream_code: result.data?.status_code || null,
        token_used: token ? token.slice(0, 12) + "..." : null,
      });
    }

    // Success
    const info = result.data.data;
    let resources = info.resources || [];

    if (resources.length === 0 && Array.isArray(info.media)) {
      for (const m of info.media) {
        if (Array.isArray(m.resources)) resources.push(...m.resources);
      }
    }

    if (resources.length === 0) {
      return res.status(404).json({ status: false, error: "Tidak ada media ditemukan" });
    }

    const mapped = resources
  .filter((r) => r.download_url && r.download_url.startsWith("http"))
  .map((r) => ({
    download_url: r.download_url,
    format: (r.format || "").toLowerCase() || (r.download_url.includes(".mp4") ? "mp4" : "jpg"),
    quality: r.quality || null,
    size: r.size || null,
  }));

// Kalau MP3 kosong URL-nya, skip. Kalau video ada, prioritaskan.

    // Video mp4 duluan
    mapped.sort((a, b) => (b.format === "mp4" ? 1 : -1));

    return res.status(200).json({
      status: true,
      data: {
        title: (info.title || "Instagram Media").trim().slice(0, 120),
        thumbnail: info.thumbnail || mapped[0]?.download_url || "",
        like_count: info.like_count || 0,
        comment_count: info.comment_count || 0,
        username: info.user_item?.nickname || "unknown",
        total: mapped.length,
        resources: mapped,
      },
    });
  } catch (e) {
    console.error("[ig] Error:", e);
    return res.status(500).json({ status: false, error: e.message });
  }
};
