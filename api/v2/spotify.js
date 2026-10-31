const { sameOriginOnly, rateLimit } = require('../_lib/security');
/* ============================================================
 *  Spotify Downloader API — by xs0ciety
 *  
 *  Endpoint:
 *    GET /api/v2/spotify?url=https://open.spotify.com/track/xxx
 *  
 *  Response:
 *    {
 *      status: true,
 *      data: {
 *        title, artist, duration, thumbnail,
 *        downloadUrl, ext, format
 *      }
 *    }
 * ============================================================ */

const HEADERS = {
  "accept": "*/*",
  "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
  "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
};

const SAVER_HEADERS = {
  ...HEADERS,
  "referer": "https://spotsaver.net/results/",
  "origin": "https://spotsaver.net",
  "content-type": "application/json",
};

function extractTrackId(url) {
  if (!url) return null;
  let clean = String(url).trim().replace(/\s+/g, "");
  clean = clean.split("?")[0].split("#")[0];

  const patterns = [
    /track\/([a-zA-Z0-9]{22})/,
    /track\/([a-zA-Z0-9]+)/,
    /spotify:track:([a-zA-Z0-9]+)/,
  ];

  for (const p of patterns) {
    const m = clean.match(p);
    if (m) return m[1];
  }
  return null;
}

module.exports = async (req, res) => {
  // CORS — biar HTML dari domain manapun bisa akses
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!rateLimit(req, res)) return;
  if (!sameOriginOnly(req, res)) return;


  const spotifyUrl = req.query.url;
  if (!spotifyUrl) {
    return res.status(400).json({ status: false, error: "Parameter 'url' wajib diisi" });
  }

  const trackId = extractTrackId(spotifyUrl);
  if (!trackId) {
    return res.status(400).json({ status: false, error: "URL Spotify tidak valid" });
  }

  try {
    // ==========================================================
    //  STEP 1 — Info track
    // ==========================================================
    const infoRes = await fetch(
      `https://spotsaver.net/api/spotify/?url=${encodeURIComponent("https://open.spotify.com/track/" + trackId)}`,
      { headers: SAVER_HEADERS }
    );
    if (!infoRes.ok) {
      return res.status(502).json({ status: false, error: `Info gagal (HTTP ${infoRes.status})` });
    }
    const infoData = await infoRes.json();
    const track = (infoData.items || [])[0];
    if (!track) {
      return res.status(404).json({ status: false, error: "Track tidak ditemukan" });
    }

    // ==========================================================
    //  STEP 2 — Cari YouTube video ID
    // ==========================================================
    const idRes = await fetch("https://spotsaver.net/api/get-id/", {
      method: "POST",
      headers: SAVER_HEADERS,
      body: JSON.stringify({ title: track.title, artist: track.artist }),
    });
    if (!idRes.ok) {
      return res.status(502).json({ status: false, error: `Get-ID gagal (HTTP ${idRes.status})` });
    }
    const idData = await idRes.json();
    const videoId = idData.videoId;
    const candidateIds = idData.candidateIds || [];
    if (!videoId) {
      return res.status(404).json({ status: false, error: "Gagal match lagu di YouTube" });
    }

    // ==========================================================
    //  STEP 3 — Minta link download
    // ==========================================================
    const dlRes = await fetch("https://spotsaver.net/api/download/", {
      method: "POST",
      headers: SAVER_HEADERS,
      body: JSON.stringify({
        videoId,
        candidateIds,
        format: "mp3",
        title: track.artist ? `${track.title} - ${track.artist}` : track.title,
      }),
    });
    if (!dlRes.ok) {
      return res.status(502).json({ status: false, error: `Download gagal (HTTP ${dlRes.status})` });
    }
    const dlData = await dlRes.json();
    const downloadUrl =
      dlData.downloadUrl || dlData.url || dlData.fileUrl || dlData.mediaUrl;

    if (!downloadUrl) {
      return res.status(500).json({ status: false, error: "Gagal membuat link download" });
    }

    // ==========================================================
    //  SUCCESS
    // ==========================================================
    return res.status(200).json({
      status: true,
      data: {
        id: track.id || trackId,
        title: track.title || "Spotify Song",
        artist: track.artist || "Unknown Artist",
        album: track.album || "",
        duration: track.duration
          ? `${Math.floor(track.duration / 60)}:${String(track.duration % 60).padStart(2, "0")}`
          : "?",
        thumbnail: track.thumbnail || "",
        format: "mp3",
        ext: "mp3",
        downloadUrl: downloadUrl,
      },
    });
  } catch (e) {
    console.error("[spotify] Error:", e);
    return res.status(500).json({ status: false, error: e.message });
  }
};
