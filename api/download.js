const axios = require('axios');
const qs = require('qs');

module.exports = async (req, res) => {
    // Hanya izinkan method POST
    if (req.method !== 'POST') {
        return res.status(405).json({ status: false, message: 'Method Not Allowed' });
    }

    const { url } = req.body || {};

    if (!url) {
        return res.status(400).json({ status: false, message: 'URL Instagram wajib diisi' });
    }

    try {
        const formData = qs.stringify({
            q: url,
            t: 'media',
            lang: 'en'
        });

        const response = await axios.post('https://indown.ai/api/ajaxSearch', formData, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
                'Referer': 'https://indown.ai/en',
                'X-Requested-With': 'XMLHttpRequest',
                'Cookie': 'fpestid=HY4Y8RFV1KzjvLwnTQyDF5Gu6_AgLlSdKZynPmCLhTRQa2YkmYoCRUTfe7_M2tkIMaGDHA;'
            }
        });

        return res.status(200).json({
            status: true,
            data: response.data
        });

    } catch (error) {
        return res.status(500).json({
            status: false,
            message: error.response ? error.response.data : error.message
        });
    }
};
