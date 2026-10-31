/**
 * Voice Changer API — Murf.ai
 * 
 * POST /api/v2/voice-changer
 * Content-Type: multipart/form-data
 * Fields:
 *   - file      : audio file (max 3 menit / 180 detik)
 *   - voice_id  : voice ID dari list (default: en-US-natalie)
 */

const axios = require('axios');
const FormData = require('form-data');
const { formidable } = require('formidable');
const fs = require('fs');

const { sameOriginOnly, rateLimit } = require('../_lib/security');
module.exports.config = {
    api: { bodyParser: false, sizeLimit: '25mb' },
    maxDuration: 60,
};

const MURF_URL = 'https://api.murf.ai/v1/speech-to-speech/anonymous';

const VALID_VOICES = [
    'en-US-natalie','en-US-marcus','en-US-terrell','en-US-ariana','en-US-miles',
    'en-US-zion','en-US-amara','en-US-cooper','en-US-iris','en-US-daisy',
    'en-US-julia','en-US-daniel','en-US-ronnie','en-US-michelle','en-US-phoebe',
    'en-US-caleb','en-US-charlotte','en-US-dylan','en-US-lucas','en-US-edmund',
    'en-US-wayne','en-US-samantha','en-UK-benedict','en-UK-freddie','en-UK-hazel',
    'en-UK-hugo','en-UK-juliet','en-UK-ruby','en-AU-harper','en-AU-ivy','en-AU-jimm',
];

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(204).end();
  if (!rateLimit(req, res)) return;
  if (!sameOriginOnly(req, res)) return;


    if (req.method === 'GET') {
        return res.json({
            success: true,
            info: 'Voice Changer API — Murf.ai',
            usage: 'POST multipart with field "file" + optional "voice_id"',
            maxDuration: '180 seconds',
            voices: VALID_VOICES,
        });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'POST only' });
    }

    const startedAt = Date.now();

    try {
        // Parse multipart
        const form = formidable({
            maxFileSize: 25 * 1024 * 1024,
            multiples: false,
            filter: (part) => {
                return part.mimetype?.startsWith('audio/') ||
                       part.mimetype === 'application/octet-stream' ||
                       !part.mimetype;
            },
        });

        const { fields, files } = await new Promise((resolve, reject) => {
            form.parse(req, (err, fields, files) => {
                if (err) return reject(err);
                resolve({ fields, files });
            });
        });

        const fileField = files.file || files.audio || files.upload;
        const file = Array.isArray(fileField) ? fileField[0] : fileField;
        if (!file) {
            return res.status(400).json({
                success: false,
                error: 'Butuh file audio. Field: "file"',
            });
        }

        const voiceIdField = fields.voice_id || fields.voiceId || fields.voice;
        const voiceId = Array.isArray(voiceIdField) ? voiceIdField[0] : (voiceIdField || 'en-US-natalie');

        const buffer = fs.readFileSync(file.filepath);
        const filename = file.originalFilename || 'audio.mp3';
        const mimetype = file.mimetype || 'audio/mpeg';

        console.log(`[vc] ${filename} (${(buffer.length / 1024).toFixed(1)} KB) voice=${voiceId}`);

        // Forward ke Murf
        const murfForm = new FormData();
        murfForm.append('file', buffer, { filename, contentType: mimetype });
        murfForm.append('voice_id', voiceId);
        murfForm.append('format', 'MP3');
        murfForm.append('channel_type', 'MONO');

        const murfRes = await axios.post(MURF_URL, murfForm, {
            headers: {
                ...murfForm.getHeaders(),
                'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
                              '(KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
                'accept': 'application/json',
                'origin': 'https://murf.ai',
                'referer': 'https://murf.ai/',
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 55000,
            validateStatus: () => true,
        });

        console.log(`[vc] Murf HTTP ${murfRes.status}`);

        if (murfRes.status !== 200) {
            const errMsg = murfRes.data?.error_message ||
                           murfRes.data?.error ||
                           `HTTP ${murfRes.status}`;
            return res.status(500).json({
                success: false,
                error: errMsg,
                elapsedMs: Date.now() - startedAt,
            });
        }

        const data = murfRes.data;
        const audioUrl = data.audio_file;
        if (!audioUrl) {
            return res.status(500).json({
                success: false,
                error: 'Gak dapet audio_file dari Murf',
                raw: data,
            });
        }

        // Fetch audio buat preview base64
        let outputDataUrl = null;
        try {
            const dl = await axios.get(audioUrl, {
                responseType: 'arraybuffer',
                timeout: 30000,
                maxContentLength: Infinity,
            });
            const audioBuf = Buffer.from(dl.data);
            const ct = dl.headers['content-type'] || 'audio/wav';
            outputDataUrl = `data:${ct};base64,${audioBuf.toString('base64')}`;
        } catch (e) {
            console.log(`[vc] fetch preview gagal: ${e.message}`);
        }

        return res.json({
            success: true,
            data: {
                audioUrl,
                outputDataUrl,
                voiceId,
                filename,
                originalSize: buffer.length,
                elapsedMs: Date.now() - startedAt,
            },
        });
    } catch (err) {
        console.error('[vc]', err.message);
        return res.status(500).json({
            success: false,
            error: err.message || 'Voice changer gagal',
            elapsedMs: Date.now() - startedAt,
        });
    }
};