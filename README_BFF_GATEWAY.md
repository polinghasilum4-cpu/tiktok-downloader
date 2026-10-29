# frontend-gw — BFF Proxy buat xs0cietylabsz.biz.id

Isi folder `api/gw/*.js` ini **digabung jadi satu project Vercel yang sama**
dengan `index.html` lo (yang nge-host di `xs0cietylabsz.biz.id`). Jadi
struktur repo frontend lo jadinya:

```
/
├─ index.html              <- punya lo, sudah di-update manggil /api/gw/*
├─ vercel.json              <- dari paket ini
├─ .env.example             <- dari paket ini
├─ .gitignore / .vercelignore
└─ api/
   ├─ _lib/gw.js             <- helper: same-origin check, rate limit, forward
   └─ gw/
      ├─ instagram.js
      ├─ twitter.js
      ├─ pinterest.js
      ├─ qr.js
      ├─ pxbee.js
      ├─ spotify.js
      ├─ soundcloud.js
      ├─ faceswap.js
      ├─ voice-changer.js
      ├─ upload.js
      ├─ iqc.js
      └─ savefrom.js
```

## Kenapa ini lebih aman

Sebelumnya: browser manggil backend asli langsung + bawa `X-Api-Key` →
key kelihatan di DevTools → siapapun bisa copy key itu dan manggil backend
asli dari luar.

Sekarang: browser cuma manggil `/api/gw/<nama>` di domain sendiri, **tanpa
key apapun**. Fungsi `api/gw/*.js` itu yang jalan di server Vercel, baca
`BACKEND_API_KEY` dari ENV server (gak pernah dikirim ke client), terus dia
yang manggil backend asli server-to-server. Orang yang buka DevTools cuma
akan liat `/api/gw/instagram?url=...` — gak ada key, gak ada domain backend
asli.

## Setup

1. Copy folder `api/` + `vercel.json` ke repo frontend lo (yang isinya
   `index-hardened.html` → rename jadi `index.html`).
2. Di Vercel → project frontend → Settings → Environment Variables, isi:
   ```
   BACKEND_API_KEY=<salah satu value API_KEYS di 3 backend>
   INSTAGRAM_API_BASE=https://<url-deploy-api-instagram-main>.vercel.app
   SPOTIFY_API_BASE=https://<url-deploy-api-spotify-main>.vercel.app
   SOUNDCLOUD_API_BASE=https://<url-deploy-api-soundcloud-main>.vercel.app
   ```
3. Pastiin `BACKEND_API_KEY` itu beneran ada di list `API_KEYS` punya
   ketiga project backend (bisa pakai key yang sama buat ketiganya).
4. Deploy. Selesai — `index.html` gak perlu disentuh lagi, dia sudah manggil
   `/api/gw/...` dari awal.

## Keterbatasan yang jujur perlu lo tau

- **sameOriginOnly() bukan proteksi mutlak.** Dia cek header `Origin`/
  `Referer`, yang bisa dipalsuin kalau orang manggil pakai curl/script
  langsung (bukan dari browser beneran). Tapi sekarang orang itu harus:
  nemuin dulu daftar endpoint `/api/gw/*`, format request tiap endpoint,
  DAN bikin header Referer palsu — jauh lebih ribet daripada sebelumnya
  (tinggal copy 1 API key dari DevTools). Yang paling penting: **key asli
  ke 3 backend tetap gak pernah bocor** walau endpoint gateway-nya
  di-hit paksa — paling banter orang itu numpang bandwidth lo, bukan
  ambil alih akses backend.
- **Limit ukuran payload ~4.5 MB** (batas platform Vercel buat Serverless
  Function, bukan sesuatu yang bisa diubah dari kode). Ini bisa kena di
  endpoint yang nerima upload: `faceswap`, `voice-changer`, `upload`,
  `pxbee`. Kalau user upload file > ~4.5 MB bakal dapet error
  (biasanya 413). Kalau ini jadi masalah nyata, langkah lanjutannya:
  pakai Vercel Edge Function/streaming, atau biarin endpoint upload itu
  tetap manggil backend asli langsung dari client (trade-off: key lebih
  gampang kelihatan buat endpoint itu doang).
- Rate limit di sini **in-memory per instance** (sama kayak 3 backend) —
  best-effort, bukan global yang presisi. Kalau butuh yang presisi lintas
  region, upgrade ke Upstash Redis (`@upstash/ratelimit`).
