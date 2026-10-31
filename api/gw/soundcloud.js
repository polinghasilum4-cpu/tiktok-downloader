const axios = require("axios");

const { sameOriginOnly, rateLimit } = require('../_lib/security');
module.exports = async (req, res) => {
  // CORS Headers

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (!rateLimit(req, res)) return;
  if (!sameOriginOnly(req, res)) return;


  const scUrl = req.query.url || req.body?.url;

  if (!scUrl) {
    return res.status(400).json({
      status: false,
      message: "Parameter 'url' wajib diisi!",
      example: "/api/v2/soundcloud?url=https://soundcloud.com/artist/track-name"
    });
  }

  try {
    const response = await axios({
      method: "post",
      url: "https://api.toolenium.com/v1/info",
      headers: {
        "accept": "*/*",
        "content-type": "application/json",
        "origin": "https://scload.com",
        "referer": "https://scload.com/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      data: {
        url: scUrl
      },
      timeout: 30000
    });

    const data = response.data;

    if (!data || !data.formats || data.formats.length === 0) {
      return res.status(404).json({
        status: false,
        message: "Gagal mengambil info trek SoundCloud atau trek tidak ditemukan."
      });
    }

    const chosen = data.formats[0];
    let ext = chosen.audio_ext || "mp3";
    if (ext === "none") ext = "mp3";

    return res.status(200).json({
      status: true,
      data: {
        title: data.title || "SoundCloud Track",
        duration: data.duration || "N/A",
        thumbnail: data.thumbnail || "https://i.scdn.co/image/ab67616d0000b273",
        format: chosen.format_id || ext,
        downloadUrl: chosen.url,
        ext: ext
      }
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: "Terjadi kesalahan server.",
      error: error.response?.data || error.message
    });
  }
};
