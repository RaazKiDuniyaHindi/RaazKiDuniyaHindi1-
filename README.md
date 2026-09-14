# Raz Ki Duniya — Complete AI Video Maker

This is the next version covering the requested 7 points:
1. Real AI visuals through Runway Gen-4.5
2. Optional talking-character asset hook
3. MP4 rendering
4. Runway API server connection
5. Automatic scene generation from Hindi script
6. Voice input + optional music mix
7. One-click workflow with 9:16 / 16:9 and download

## Important
- This is a complete project, not a fake browser-only demo.
- It needs a server/PC or hosting with Node.js and FFmpeg installed.
- Put your secret in `.env` as `RUNWAYML_API_SECRET=...` and never expose it in the browser.
- Runway charges credits for generation.
- The talking-character portion is an integration hook; actual lip-synced character generation requires a supported Runway character/performance workflow and suitable character/driving assets.

Runway's current developer docs support Gen-4.5 text/image-to-video and a Character Performance API. See official docs.
