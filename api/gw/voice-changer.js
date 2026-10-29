// Auto-generated BFF gateway for /api/v2/voice-changer
// Browser -> (domain sendiri) /api/gw/voice-changer -> backend asli (server-to-server, API key gak pernah ke browser)
const { rateLimit, sameOriginOnly, forward } = require('../_lib/gw');

module.exports.config = { api: { bodyParser: false } };


module.exports = async (req, res) => {
    if (!sameOriginOnly(req, res)) return;
    if (!rateLimit(req, res)) return;
    try {
        await forward({ req, res, baseUrl: process.env.SOUNDCLOUD_API_BASE, path: '/api/v2/voice-changer' });
    } catch (e) {
        res.status(502).json({ success: false, error: 'Gateway error: ' + e.message });
    }
};
