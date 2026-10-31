/**
 * X2Twitter Downloader — Vercel Serverless Function
 * =================================================
 * GET  /api/twitter?url=<tweet_url>&lang=id
 * POST /api/twitter  {"url": "...", "lang": "id"}
 *
 * Environment (opsional):
 *   PROXY_URL=http://user:pass@host:port
 */

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const { HttpsProxyAgent } = require('https-proxy-agent');


const { sameOriginOnly, rateLimit } = require('../_lib/security');
// ======================================================================
// Config
// ======================================================================
const BASE_URL = 'https://x2twitter.com';
const API_VERIFY = `${BASE_URL}/api/userverify`;
const API_SEARCH = `${BASE_URL}/api/ajaxSearch`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
  'Origin': BASE_URL,
  'Referer': `${BASE_URL}/id3`,
  'sec-ch-ua': '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};


// ======================================================================
// Proxy (opsional)
// ======================================================================
function makeProxyAgent() {
  const proxyUrl = process.env.PROXY_URL;
  if (!proxyUrl) return null;
  try {
    return new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    console.warn('Proxy invalid, skip:', e.message);
    return null;
  }
}


// ======================================================================
// Client
// ======================================================================
class X2Twitter {
  constructor() {
    this.jar = new CookieJar();

    const config = {
      jar: this.jar,
      headers: HEADERS,
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true,
    };

    const agent = makeProxyAgent();
    if (agent) {
      config.httpsAgent = agent;
      config.proxy = false; // biar axios nggak double-proxy
    }

    this.client = wrapper(axios.create(config));
    this.warmedUp = false;
    this.cftoken = null;
  }

  static validateUrl(url) {
    const pattern = /^https?:\/\/(www\.)?(x\.com|twitter\.com|mobile\.twitter\.com|mobile\.x\.com)\/[^/]+\/status\/\d+/i;
    if (!pattern.test(url)) {
      throw new Error(
        'URL tidak valid. Harus link tweet, contoh: https://x.com/user/status/1234567890'
      );
    }
    return url;
  }

  async warmUp() {
    if (this.warmedUp) return;
    const res = await this.client.get(`${BASE_URL}/id3`);
    if (typeof res.data === 'string') {
      const m = res.data.match(/"cftoken"\s*:\s*"([^"]+)"/);
      if (m) this.cftoken = m[1];
    }
    this.warmedUp = true;
  }

  async userVerify(tweetUrl) {
    await this.warmUp();
    const body = new URLSearchParams({ url: tweetUrl }).toString();
    const res = await this.client.post(API_VERIFY, body);

    let data;
    try {
      data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    } catch {
      return null;
    }

    const token = data.cftoken || data.token;
    if (token) this.cftoken = token;
    return token;
  }

  async ajaxSearch(tweetUrl, lang = 'id') {
    if (!this.cftoken) throw new Error('cftoken belum ada');
    const body = new URLSearchParams({
      q: tweetUrl,
      lang,
      cftoken: this.cftoken,
    }).toString();

    const res = await this.client.post(API_SEARCH, body);
    try {
      return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    } catch {
      return null;
    }
  }

  static parseResult(html) {
    if (!html) return null;

    const result = {
      title: null,
      duration: null,
      thumbnail: null,
      twitter_id: null,
      medias: [],
      mp3: null,
      k_exp: null,
      k_token: null,
    };

    let m;

    m = html.match(/<h3>([\s\S]*?)<\/h3>/);
    if (m) result.title = m[1].replace(/<[^>]+>/g, '').trim();

    m = html.match(/<p>(\d+:\d+)<\/p>/);
    if (m) result.duration = m[1];

    m = html.match(/<img src="([^"]+)"/);
    if (m) result.thumbnail = m[1];

    m = html.match(/id="TwitterId"\s+value="(\d+)"/);
    if (m) result.twitter_id = m[1];

    const re = /<a[^>]+href="(https:\/\/dl\.snapcdn\.app\/get\?token=[^"]+)"[^>]*>[\s\S]*?<i class="icon icon-[^"]+"><\/i>\s*([^<]+)<\/a>/g;
    let match;
    while ((match = re.exec(html)) !== null) {
      result.medias.push({
        label: match[2].trim(),
        url: match[1],
      });
    }

    m = html.match(/data-audioUrl="([^"]+)"/);
    if (m) result.mp3 = m[1];

    m = html.match(/k_exp\s*=\s*"(\d+)"/);
    if (m) result.k_exp = m[1];

    m = html.match(/k_token\s*=\s*"([a-f0-9]+)"/);
    if (m) result.k_token = m[1];

    return result;
  }

  async download(tweetUrl, lang = 'id') {
    X2Twitter.validateUrl(tweetUrl);

    let token = await this.userVerify(tweetUrl);
    if (!token) {
      this.warmedUp = false;
      token = await this.userVerify(tweetUrl);
    }

    const raw = await this.ajaxSearch(tweetUrl, lang);
    if (!raw || raw.status !== 'ok') return null;

    const html = raw.data;
    if (!html) return null;

    return X2Twitter.parseResult(html);
  }
}


// ======================================================================
// Singleton (reuse cookie antar warm invocation)
// ======================================================================
let _client = null;
function getClient() {
  if (!_client) _client = new X2Twitter();
  return _client;
}


// ======================================================================
// Helpers
// ======================================================================
function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      // fallback: form-urlencoded
      const params = new URLSearchParams(req.body);
      return Object.fromEntries(params);
    }
  }
  return req.body;
}


// ======================================================================
// Handler
// ======================================================================
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!rateLimit(req, res)) return;
  if (!sameOriginOnly(req, res)) return;


  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Ambil URL dari query atau body
  let url = req.query?.url;
  let lang = req.query?.lang || 'id';

  if (!url) {
    const body = parseBody(req);
    url = body.url;
    lang = body.lang || lang;
  }

  // Health check
  if (!url) {
    return res.status(200).json({
      success: true,
      service: 'x2twitter',
      status: 'ok',
      usage: {
        GET: '/api/twitter?url=<tweet_url>&lang=id',
        POST: '{"url": "...", "lang": "id"}',
      },
    });
  }

  // Validasi
  try {
    X2Twitter.validateUrl(url);
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }

  // Proses
  try {
    const client = getClient();
    const result = await client.download(url, lang);

    if (!result) {
      return res.status(502).json({ success: false, error: 'Gagal mengambil data dari sumber' });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (e) {
    console.error('[x2twitter] error:', e.message);
    return res.status(502).json({ success: false, error: `Upstream error: ${e.message}` });
  }
};
