export default async function handler(req, res) { // line 1
  const { url } = req.query; // line 2
  if (!url) return res.status(400).json({ error: "url kosong" }); // line 3
 // line 4
  try { // line 5
    const r = await fetch("https://co.wuk.sh/api/json", { // <-- GANTI LINE INI
      method: "POST", // line 7
      headers: { "Content-Type": "application/json" }, // line 8
      body: JSON.stringify({ url: url }) // line 9
    }); // line 10
     // line 11
    const data = await r.json(); // line 12
    if(data.status !== "tunnel") throw new Error(data.text); // line 13
 // line 14
    res.status(200).json({ // line 15
      title: "Instagram", // line 16
      author: { nickname: "IG" }, // line 17
      data: [{ type: "video", url: data.url }] // line 18
    }); // line 19
 // line 20
  } catch (err) { // line 21
    res.status(500).json({ error: err.message }); // line 22
  } // line 23
} // line 24
