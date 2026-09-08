const { igdl } = require('../lib/instagram');

module.exports = async (req, res) => {
    // Handling CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    // Tangani preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Hanya izinkan method POST
    if (req.method !== 'POST') {
        return res.status(405).json({ status: false, message: 'Method Not Allowed' });
    }

    const { url } = req.body || {};

    if (!url) {
        return res.status(400).json({ status: false, message: 'URL Instagram wajib diisi' });
    }

    try {
        // Memanggil fungsi igdl dari file instagram.js
        const result = await igdl(url);

        if (!result.status) {
            return res.status(400).json({
                status: false,
                message: result.message || 'Gagal mengambil media dari Instagram'
            });
        }

        return res.status(200).json(result);

    } catch (error) {
        return res.status(500).json({
            status: false,
            message: error.message || 'Terjadi kesalahan pada server'
        });
    }
};
