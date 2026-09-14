# Raz Ki Duniya — FIXED v2

यह package उस समस्या को ठीक करता है जिसमें `AI scenes: 0%` पर UI अटका रहता था।

## क्या ठीक किया गया
- Frontend अब सच में `POST /api/generate` को FormData के साथ call करता है।
- Job ID मिलने के बाद frontend `/api/job/:id` को poll करता है।
- Runway scene progress UI में दिखता है।
- Error अब स्क्रीन पर साफ दिखाई देगा।
- AI scenes ready होने के बाद `/api/render` call होता है।
- FFmpeg के लिए `ffmpeg-static` जोड़ा गया है।
- Runway Gen-4.5 text-to-video backend रखा गया है।

## Render पर सेटअप
1. GitHub में इस ZIP की files upload करें और पुरानी project files replace करें।
2. Render service में **Build Command**:
   `npm install`
3. **Start Command**:
   `npm start`
4. Environment में:
   `RUNWAYML_API_SECRET` = आपकी existing secret value
5. Deploy करें।
6. Deploy के बाद:
   `/api/status`
   खोलकर `runwayConfigured: true` और `ffmpegConfigured: true` देखें।

## जरूरी
API key को ZIP/GitHub में मत डालना। Render Environment में ही रखना।

## Runway
यह package official Runway Node SDK और Gen-4.5 text-to-video flow का उपयोग करता है।
