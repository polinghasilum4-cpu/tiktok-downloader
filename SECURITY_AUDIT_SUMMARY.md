# Security Hardening Summary — tools-downloader (satu project, same-origin)

Ini versi final: frontend (`index.html`) dan semua backend (`api/v2/*.js`)
digabung jadi **satu project Vercel**, satu domain (`xs0cietylabsz.biz.id`).
Gak ada lagi project terpisah, gak ada lagi API key yang bisa bocor lewat
DevTools — karena gak ada lagi "server lain" yang perlu dibuktiin
identitasnya pakai key.

## Kenapa modelnya berubah dari versi sebelumnya

Versi sebelumnya: 3 backend terpisah + 1 frontend+BFF proxy = 4 project,
dihubungkan pakai API key di ENV. Itu valid, tapi ribet buat di-deploy
(4 project, 4 set ENV, harus nyambung-nyambungin URL).

Versi ini: semua jadi 1 project. Konsekuensinya:
- `applyCors()` + `requireApiKey()` (model lama) **dihapus**, diganti
  `sameOriginOnly()` (cek header `Origin`/`Referer` cocok domain sendiri)
  + `rateLimit()` yang udah ada. Lihat `api/_lib/security.js`.
- Gak ada ENV wajib. `.env.example` cuma punya `SELF_ORIGIN` (opsional).

## Status per item (12-layer checklist)

| # | Layer | Status | Keterangan |
|---|---|---|---|
| 1 | SQL injection / parameterized query | **N/A** | Tidak ada database/SQL di codebase ini. |
| 2 | Bind backend ke 127.0.0.1 | **N/A** | Serverless function (Vercel), bukan server persisten. |
| 3 | CORS allowlist + cookie httpOnly/secure/sameSite | **Diganti model same-origin** | Karena frontend & backend satu domain sekarang, gak perlu header CORS sama sekali — browser otomatis izinin same-origin fetch. `sameOriginOnly()` di tiap handler tetap nolak kalau ada header `Origin` yang gak cocok (jaga-jaga ada yang nyoba embed dari domain lain). Tidak ada cookie/session dipakai di manapun. |
| 4 | Rate limiting + trust proxy | **Diterapkan** | `rateLimit()` di semua 15 handler, baca `cf-connecting-ip` → `x-forwarded-for` → `x-real-ip`. In-memory per instance (best-effort — lihat Keterbatasan). |
| 5 | Hilangkan innerHTML / sanitize DOM | **N/A** | Tidak ada DOM-injection pattern berbahaya; ini backend API + satu halaman statis. |
| 6 | Block akses .env/.db/.sqlite/config | **Diterapkan (defense-in-depth)** | Vercel gak nge-serve file repo selain lewat `/api/*` dan asset statis yang memang dimaksudkan publik. `.gitignore`/`.env.example` dijaga biar secret gak ke-commit (walau sekarang gak ada secret wajib). |
| 7 | Verifikasi signature webhook (timing-safe) | **N/A** | Tidak ada endpoint webhook di repo ini. |
| 8 | Upload: magic bytes + UUID rename + private storage | **Diterapkan (upload.js)** | Validasi magic-byte (bukan percaya `mimetype` client), nama file di-UUID-kan sebelum diteruskan ke Litterbox. Endpoint lain yang nerima file (`faceswap.js`, `voice-changer.js`, `faceswap-video.js`, `pxbee.js`) forward ke API pihak ketiga, gak nyimpen lokal. |
| 9 | Anti-SSRF outbound fetch | **Diterapkan** | `proxy.js` & `savefrom.js` pakai `assertPublicUrl()` — resolve DNS beneran (anti DNS-rebinding), plus validasi ulang tiap redirect di `proxy.js` (anti bypass 302 ke IP internal). |
| 10 | Hilangkan IDOR | **N/A** | Tidak ada object/record bermilik user di sistem ini. |
| 11 | Atomic update anti race-condition (saldo/kupon/stok) | **N/A** | Tidak ada fitur saldo/kupon/stok. |
| 12 | Ringkasan checklist | Dokumen ini. |

## Model proteksi yang realistis (baca ini, jangan cuma percaya checklist)

Karena sekarang backend dan frontend satu domain publik yang sama, **gak ada
secret apapun yang bisa disembunyiin** dari orang yang niat — dan itu
sebenarnya OK, karena memang gak ada secret yang perlu disembunyiin lagi.
Proteksi yang ada sekarang:

1. **`sameOriginOnly()`** — nolak request yang header `Origin`-nya bukan
   `https://xs0cietylabsz.biz.id`. Ini ngeblok browser lain yang nyoba
   fetch/embed API ini dari situs lain. **Tapi** script/curl bisa
   mempalsukan header `Referer`/`Origin` dengan bebas (bukan dari browser
   beneran) — jadi ini meredam, bukan menghilangkan sepenuhnya, request
   otomatis dari luar.
2. **`rateLimit()`** — 30 request/menit per IP, biar satu sumber gak bisa
   nge-hajar berkali-kali.
3. **SSRF guard** di `proxy.js`/`savefrom.js` — ini independen dari soal
   auth, tetap full diterapkan.

Kalau target lo beneran "nol persen bisa di-scrape sama sekali", itu cuma
bisa dicapai dengan sistem akun+login (user harus sign in, baru boleh
pakai fitur) — di luar lingkup perubahan yang diminta sejauh ini. Dengan
setup sekarang, realistisnya ini udah cukup buat nyusahin bot/scraper
casual, tapi bukan tembok mutlak buat yang niat teknis tinggi.

## Dependency yang digabung

`package.json` sekarang gabungan dari 3 backend lama:
`axios`, `axios-cookiejar-support`, `form-data`, `formidable`,
`https-proxy-agent`, `qrcode`, `tough-cookie`, `validator` (dari project
instagram), plus `puppeteer-core` + `@sparticuz/chromium` (dipakai
`savefrom.js` buat scraping headless browser). `fluent-ffmpeg` dan
`@ffmpeg-installer/ffmpeg` yang ada di `package.json` soundcloud asli
**dibuang** karena gak ada handler manapun yang benar-benar makainya
(dependency nganggur dari repo asli).

## File yang berubah dari paket sebelumnya
- **Dihapus total**: folder `api/gw/` (BFF proxy), `README_BFF_GATEWAY.md`,
  konsep `API_KEYS`/`BACKEND_API_KEY`/`*_API_BASE`.
- `api/_lib/security.js` — ditulis ulang: `applyCors`+`requireApiKey`
  diganti `sameOriginOnly`. `rateLimit` dan `assertPublicUrl` dipertahankan
  persis.
- 15 file di `api/v2/*.js` — dipindah dari 3 project lama ke satu folder,
  guard-nya di-migrasi ke `sameOriginOnly`.
- `index.html` — semua pemanggilan `/api/gw/<nama>` diganti `/api/v2/<nama>`
  langsung (same-origin, gak perlu header apapun lagi).
- `package.json` — digabung dependency dari 3 project lama.
- `vercel.json` — `functions` block nunjuk ke `api/v2/*.js`, header
  CSP/security yang udah ada dari project asli **tidak diubah**.
- `.env.example` — disederhanain, cuma `SELF_ORIGIN` (opsional).
