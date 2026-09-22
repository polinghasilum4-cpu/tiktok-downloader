# Multi Tools Downloader + Games

A modern, fast downloader app with a sleek UI for YouTube and SoundCloud with fun games built in.

## 📁 Project Structure

```
├── index.html              # Frontend (single page)
├── package.json            # Dependencies
├── vercel.json             # Vercel deployment config
└── README.md               # This file
```

## 🚀 Features

- **Fun Games**: Kerang Ajaib (Magic Shell) for predictions
- **Modern UI**: Glassmorphism design with smooth animations
- **CORS Handling**: Backend proxies all requests to avoid browser restrictions
- **Fast API**: Serverless functions on Vercel

## 🔧 Installation & Setup

### Local Development

1. **Clone/download the project**
```bash
git clone <your-repo>
cd multi-tools-downloader
```

2. **Install dependencies**
```bash
npm install
```

3. **Start development server**
```bash
npm start
```
This runs `vercel dev` which creates a local dev environment at `http://localhost:3000`

### Deployment to Vercel

1. **Connect your repository to Vercel**
   - Go to [vercel.com](https://vercel.com)
   - Click "New Project"
   - Import your Git repository
   - Vercel will auto-detect the configuration

2. **Or deploy from CLI**
```bash
npm install -g vercel
vercel login
vercel --prod
```

3. **That's it!** Your app will be live at `your-project.vercel.app`

## 📡 API Endpoints

### POST `/api/youtube`
Download YouTube videos or audio

**Request:**
```json
{
  "url": "https://youtube.com/watch?v=...",
  "type": "video" // or "audio"
}
```

**Response:**
```json
{
  "success": true,
  "downloadUrl": "https://...",
  "filename": "video.mp4",
  "title": "Video Title"
}
```

### POST `/api/soundcloud`
Download SoundCloud tracks

**Request:**
```json
{
  "input": "https://soundcloud.com/... or song title"
}
```

**Response:**
```json
{
  "success": true,
  "downloadUrl": "https://...",
  "filename": "track.mp3",
  "metadata": {
    "title": "Song Title",
    "author": "Artist",
    "thumbnail": "https://...",
    "duration": 240,
    "size": "5.20 MB"
  }
}
```

## 🛠️ Technical Stack

- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Backend**: Node.js with Vercel Serverless Functions
- **Libraries**: 
  - `axios`: HTTP requests
  - `qs`: Query string encoding
- **Hosting**: Vercel (serverless, auto-scaling)

## 🔐 Security & Best Practices

- ✅ CORS enabled for frontend requests
- ✅ Request validation on backend
- ✅ Timeout protection (15-30 seconds)
- ✅ Error handling and user feedback
- ✅ No API keys exposed in frontend code

## ⚡ Performance

- Serverless functions scale automatically
- No server maintenance needed
- Cold start: ~500ms, subsequent requests: <100ms
- Includes request timeout protection

## 📝 Environment Variables (Optional)

Create a `.env.local` for local development (ignored by git):
```
# Add any secret keys here if needed in future
```

## 🎨 Customization

### Change API Base URL
In `index.html`, change:
```javascript
const API_BASE = '/api';
```

### Modify UI Colors
Edit the CSS gradient in `index.html`:
```css
background: linear-gradient(135deg, #ff0050, #ff6b6b);
```

### Add More Tools
1. Create a new endpoint in `api/yourfeature.js`
2. Add menu item in `index.html`
3. Add tool content div and JavaScript handler

## 🐛 Troubleshooting

**CORS errors in browser?**
- Make sure API calls go through `/api/` endpoints
- Backend adds proper CORS headers automatically

**External service failing?**
- YouTube and SoundCloud APIs change frequently
- Check the external service URLs in the code
- May need to update to new endpoints

**404 on API routes?**
- Make sure files are in `api/` folder
- Check `vercel.json` routes configuration
- Run `vercel dev` to test locally first

## 📄 License

Free to use and modify!

## 🤝 Support

If you encounter issues:
1. Check the browser console (F12) for error messages
2. Check Vercel deployment logs
3. Test locally with `npm start` first

---

Made with ❤️ for downloading media
