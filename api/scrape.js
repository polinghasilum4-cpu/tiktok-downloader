export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: "url kosong" });

  // Ini endpoint savefromins buat IG
  const endpoint = `https://api.savefromins.com/api/v1/info?url=${encodeURIComponent(url)}`;

  try {
    const response = await fetch(endpoint, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      }
    });

    if(!response.ok) throw new Error("API error");
    const data = await response.json();

    // Format biar sama kayak TikTok lu
    res.status(200).json({
      title: data.title || "Instagram",
      author: { nickname: data.author?.name || "IG User", fullname: data.author?.username || "" },
      data: [
        { type: data.type === 'video'? 'video' : 'photo', url: data.media_url }
      ],
      music_info: { url: "" },
      stats: { views: "0", likes: data.likes || "0", comment: "0", share: "0", download: "0" },
      taken_at: data.date || ""
    });

  } catch (err) {
    res.status(500).json({ error: "Gagal fetch ke API: " + err.message });
  }
}