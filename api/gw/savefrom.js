/**
 * SaveFrom Scraper — Vercel Serverless Function (fixed)
 * Endpoint: POST /api/v2/savefrom
 * 
 * FIXES:
 *   - Removed --single-process & --no-zygote (crash on Vercel)
 *   - Removed duplicate chromium.args
 *   - Removed UA duplication (set via page.setUserAgent)
 *   - Reduced internal timeouts to fit Vercel 60s limit
 * 
 * ENV VARS required in Vercel Dashboard:
 *   AWS_LAMBDA_JS_RUNTIME = nodejs20.x
 * 
 * vercel.json config required:
 *   "api/v2/savefrom.js": { "memory": 1024, "maxDuration": 60 }
 */

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const { sameOriginOnly, rateLimit, assertPublicUrl } = require('../_lib/security');
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {

    if (req.method === 'OPTIONS') return res.status(200).end();
  if (!rateLimit(req, res)) return;
  if (!sameOriginOnly(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    const url = body && body.url;

    if (!url || !/^https?:\/\//.test(url)) {
        return res.status(400).json({ success: false, error: 'URL tidak valid' });
    }

    try {
        await assertPublicUrl(url);
    } catch (e) {
        return res.status(403).json({ success: false, error: e.message });
    }

    console.log('[savefrom] request:', url);
    const startTime = Date.now();
    let browser = null;

    try {
        const execPath = await chromium.executablePath();
        console.log('[savefrom] execPath:', execPath);

        // ============ LAUNCH CHROMIUM ============
        // NOTE: chromium.args sudah include --no-sandbox, --disable-dev-shm-usage,
        //       --single-process (TIDAK — jangan tambah!), --no-zygote (jangan tambah!)
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
            defaultViewport: {
                width: 412,
                height: 915,
                isMobile: true,
                hasTouch: true,
            },
            executablePath: execPath,
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        // ============ SETUP PAGE ============
        const page = await browser.newPage();
        await page.setUserAgent(MOBILE_UA);
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'languages', {
                get: () => ['id-ID', 'id', 'en-US', 'en']
            });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5]
            });
        });

        // ============ OPEN SAVEFROM ============
        console.log('[savefrom] opening savefrom.co.id...');
        await page.goto('https://savefrom.co.id/', {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
        });
        await sleep(1500);

        // ============ FIND INPUT ============
        const inputSelectors = [
            'input#sf_url',
            'input[name="sf_url"]',
            'input[type="url"]',
            'input[type="text"]',
            'input[placeholder*="URL"]',
            'input[placeholder*="link"]',
        ];

        let inputEl = null;
        for (const sel of inputSelectors) {
            try {
                inputEl = await page.$(sel);
                if (inputEl) {
                    console.log('[savefrom] input found:', sel);
                    break;
                }
            } catch (e) { continue; }
        }

        if (!inputEl) {
            throw new Error('Input field SaveFrom tidak ditemukan');
        }

        // ============ FILL & SUBMIT ============
        await inputEl.click();
        await page.evaluate(el => el.value = '', inputEl);
        await inputEl.type(url, { delay: 20 });
        await sleep(300);

        let clicked = false;
        const btnSelectors = [
            'button[type="submit"]',
            'button.sf-btn',
            'input[type="submit"]',
        ];
        for (const sel of btnSelectors) {
            try {
                const btn = await page.$(sel);
                if (btn) {
                    await btn.click();
                    clicked = true;
                    console.log('[savefrom] clicked:', sel);
                    break;
                }
            } catch (e) { continue; }
        }
        if (!clicked) {
            console.log('[savefrom] button not found, pressing Enter');
            await inputEl.press('Enter');
        }

        // ============ POLLING ============
        console.log('[savefrom] waiting for results...');
        const pollStart = Date.now();
        let found = false;
        let hasError = false;

        while (Date.now() - pollStart < 20000) {
            await sleep(1000);
            const status = await page.evaluate(() => {
                const links = document.querySelectorAll('a');
                let hasValidLink = false;
                for (const a of links) {
                    const h = a.href || '';
                    if (h.includes('fbcdn') || h.includes('googlevideo') ||
                        h.includes('.mp4') || h.includes('cdn')) {
                        hasValidLink = true;
                        break;
                    }
                }
                const body = document.body.innerText || '';
                const hasErr = body.includes('Something went wrong') ||
                               body.includes('invalid_request');
                return { hasValidLink, hasErr };
            });

            if (status.hasValidLink) {
                found = true;
                console.log('[savefrom] results appeared!');
                break;
            }
            if (status.hasErr) {
                hasError = true;
                break;
            }
        }

        if (hasError && !found) {
            throw new Error('SaveFrom return error (rate limit / IP block?)');
        }
        if (!found) {
            throw new Error('Timeout: link download gak muncul dalam 20s');
        }

        await sleep(1000);

        // ============ SCRAPE LINKS ============
        console.log('[savefrom] scraping links...');
        const rawLinks = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll('a').forEach(a => {
                const href = a.href || '';
                const text = (a.innerText || a.textContent || '').trim();

                if (href.startsWith('https://savefrom.co.id/') ||
                    href.startsWith('https://downloadhelper.app/')) return;

                const isVideo = href.includes('fbcdn') || href.includes('googlevideo') ||
                                href.includes('.mp4') || href.includes('video') ||
                                href.includes('cdn');
                const isAudio = href.includes('.mp3') || href.includes('audio') ||
                                href.includes('.m4a');

                if (isVideo || isAudio) {
                    out.push({
                        text: text,
                        href: href,
                        type: isAudio ? 'audio' : 'video',
                    });
                }
            });
            return out;
        });

        // ============ BUILD OPTIONS ============
        const options = [];
        const seenBitrates = new Set();

        for (const link of rawLinks) {
            const href = link.href.trim();
            const text = link.text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

            const brMatch = href.match(/bitrate=(\d+)/);
            const bitrate = brMatch ? brMatch[1] : null;
            const brInt = bitrate ? parseInt(bitrate) : 0;

            const tagMatch = href.match(/tag=([^&]+)/);
            const tag = tagMatch ? decodeURIComponent(tagMatch[1]) : '';
            const tagLower = tag.toLowerCase();
            const textUpper = text.toUpperCase();

            let quality = null;

            if (tagLower.includes('1080') || textUpper.includes('1080') || textUpper.includes('FULL HD')) {
                quality = 'Full HD (1080p)';
            } else if (tagLower.includes('720') || textUpper.includes('720')) {
                quality = 'HD (720p)';
            } else if (tagLower.includes('480') || textUpper.includes('480')) {
                quality = '480p';
            } else if (tagLower.includes('360') || textUpper.includes('360')) {
                quality = '360p';
            } else if (tagLower.includes('240') || textUpper.includes('240')) {
                quality = '240p';
            } else if (textUpper.includes('HD') && link.type === 'video') {
                quality = 'HD (720p)';
            }

            if (!quality && brInt > 0) {
                if (brInt >= 1500000) quality = 'Full HD (1080p)';
                else if (brInt >= 500000) quality = 'HD (720p)';
                else if (brInt >= 300000) quality = '480p';
                else if (brInt >= 150000) quality = '360p';
                else if (brInt >= 50000) quality = '240p';
            }

            if (!quality) {
                quality = link.type === 'audio' ? 'Audio (M4A)' : 'MP4';
            }

            const key = bitrate || href.split('?')[0].slice(0, 200);
            if (seenBitrates.has(key)) continue;
            seenBitrates.add(key);

            options.push({
                label: quality,
                text: text,
                url: href,
                type: link.type,
                bitrate: bitrate,
                sizeHint: brInt ? Math.round(brInt * 60 / 8) : null,
            });
        }

        const order = {
            'Full HD (1080p)': 0,
            'HD (720p)': 1,
            '480p': 2,
            '360p': 3,
            '240p': 4,
            'MP4': 5,
            'Audio (M4A)': 6,
        };
        options.sort((a, b) => (order[a.label] ?? 99) - (order[b.label] ?? 99));

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[savefrom] success in ${elapsed}s, ${options.length} options`);

        return res.status(200).json({
            success: true,
            url: url,
            options: options,
            elapsed: parseFloat(elapsed),
        });

    } catch (err) {
        console.error('[savefrom] error:', err.message);
        return res.status(500).json({
            success: false,
            error: err.message || 'Scrape gagal',
            elapsed: parseFloat(((Date.now() - startTime) / 1000).toFixed(1)),
        });
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
    }
};
