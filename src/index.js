import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import RunwayML from '@runwayml/sdk';
import ffmpeg from 'fluent-ffmpeg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

const app = express();

const uploadsDir = path.join(root, 'uploads');
const rendersDir = path.join(root, 'renders');

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(rendersDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(root, 'public')));
app.use('/renders', express.static(rendersDir));

const runwayKey = process.env.RUNWAYML_API_SECRET;

const client = runwayKey
  ? new RunwayML({ apiKey: runwayKey })
  : null;

const jobs = new Map();

function splitScenes(script) {
  return script
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?।])\s+/)
    .filter(Boolean)
    .slice(0, 20);
}

function cleanFile(file) {
  if (!file?.path) return;

  try {
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  } catch {}
}

function cleanupFiles(files = []) {
  for (const file of files) {
    cleanFile(file);
  }
}

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    runwayConfigured: Boolean(client),
    ffmpeg: true,
    message: client
      ? 'Raz Ki Duniya server ready'
      : 'RUNWAYML_API_SECRET is not configured'
  });
});

app.post(
  '/api/generate',
  upload.fields([
    { name: 'characterImage', maxCount: 1 },
    { name: 'voice', maxCount: 1 },
    { name: 'music', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      if (!client) {
        cleanupFiles(Object.values(req.files || {}).flat());

        return res.status(400).json({
          error:
            'Runway API key is not configured. Add RUNWAYML_API_SECRET in Render Environment Variables.'
        });
      }

      const script = String(req.body.script || '').trim();
      const format = req.body.format || '9:16';
      const style = req.body.style || 'Mystery';
      const characterMode = req.body.characterMode || 'off';

      if (!script) {
        cleanupFiles(Object.values(req.files || {}).flat());

        return res.status(400).json({
          error: 'Script is required.'
        });
      }

      const scenes = splitScenes(script);

      if (!scenes.length) {
        return res.status(400).json({
          error: 'Script में कोई scene नहीं मिला।'
        });
      }

      const jobId = `${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      jobs.set(jobId, {
        status: 'generating',
        progress: 0,
        scenes: [],
        sceneCount: scenes.length,
        characterMode,
        createdAt: Date.now()
      });

      res.json({
        ok: true,
        jobId,
        sceneCount: scenes.length
      });

      // Background generation
      (async () => {
        try {
          const ratio =
            format === '16:9'
              ? '1280:720'
              : '720:1280';

          const generatedVideos = [];

          for (let i = 0; i < scenes.length; i++) {
            const sceneText = scenes[i];

            const prompt = `
Create a cinematic AI video scene for a Hindi mystery storytelling video.

Style: ${style}

Narration:
${sceneText}

Requirements:
- cinematic realistic visuals
- dramatic atmosphere
- natural camera movement
- detailed environment
- visually match the narration
- no subtitles
- no written text
- no logos
- no watermark
- suitable for YouTube Shorts / social video
`;

            jobs.set(jobId, {
              ...jobs.get(jobId),
              progress: Math.round((i / scenes.length) * 80),
              currentScene: i + 1,
              message: `Generating scene ${i + 1} of ${scenes.length}`
            });

            const task = await client.imageToVideo
              .create({
                model: 'gen4.5',
                promptText: prompt,
                ratio,
                duration: 5
              })
              .waitForTaskOutput();

            const videoUrl = task?.output?.[0];

            if (!videoUrl) {
              throw new Error(
                `Runway ने scene ${i + 1} का video URL नहीं दिया।`
              );
            }

            generatedVideos.push(videoUrl);

            jobs.set(jobId, {
              ...jobs.get(jobId),
              progress: Math.round(
                ((i + 1) / scenes.length) * 80
              ),
              currentScene: i + 1,
              scenes: generatedVideos,
              message: `Scene ${i + 1} completed`
            });
          }

          jobs.set(jobId, {
            ...jobs.get(jobId),
            status: 'ready',
            progress: 80,
            scenes: generatedVideos,
            message: 'All AI scenes generated successfully'
          });
        } catch (error) {
          console.error('GENERATION ERROR:', error);

          jobs.set(jobId, {
            ...jobs.get(jobId),
            status: 'error',
            progress: 0,
            error:
              error?.message ||
              String(error)
          });
        }
      })();
    } catch (error) {
      console.error('API ERROR:', error);

      cleanupFiles(Object.values(req.files || {}).flat());

      res.status(500).json({
        error:
          error?.message ||
          'Video generation request failed.'
      });
    }
  }
);

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      status: 'not_found',
      error: 'Job not found'
    });
  }

  res.json(job);
});

app.post(
  '/api/render',
  upload.fields([
    { name: 'voice', maxCount: 1 },
    { name: 'music', maxCount: 1 }
  ]),
  async (req, res) => {
    const voice = req.files?.voice?.[0];
    const music = req.files?.music?.[0];

    try {
      const jobId = req.body.jobId;
      const job = jobs.get(jobId);

      if (!job || job.status !== 'ready') {
        cleanupFiles([voice, music]);

        return res.status(400).json({
          error: 'पहले AI scenes generate करो।'
        });
      }

      if (!job.scenes?.length) {
        cleanupFiles([voice, music]);

        return res.status(400).json({
          error: 'कोई generated scene नहीं मिला।'
        });
      }

      const sceneFiles = [];

      // Download all generated scenes
      for (let i = 0; i < job.scenes.length; i++) {
        const scenePath = path.join(
          rendersDir,
          `${jobId}_scene_${i}.mp4`
        );

        const response = await fetch(job.scenes[i]);

        if (!response.ok) {
          throw new Error(
            `Scene ${i + 1} download नहीं हो पाया।`
          );
        }

        const buffer = Buffer.from(
          await response.arrayBuffer()
        );

        fs.writeFileSync(scenePath, buffer);

        sceneFiles.push(scenePath);
      }

      const concatFile = path.join(
        rendersDir,
        `${jobId}_concat.txt`
      );

      const outputFile = path.join(
        rendersDir,
        `${jobId}.mp4`
      );

      const finalFile = path.join(
        rendersDir,
        `${jobId}_final.mp4`
      );

      const concatText = sceneFiles
        .map(
          file =>
            `file '${file.replaceAll("'", "'\\''")}'`
        )
        .join('\n');

      fs.writeFileSync(concatFile, concatText);

      // Join scenes
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatFile)
          .inputOptions([
            '-f',
            'concat',
            '-safe',
            '0'
          ])
          .outputOptions([
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-pix_fmt',
            'yuv420p',
            '-an'
          ])
          .save(outputFile)
          .on('end', resolve)
          .on('error', reject);
      });

      // No audio
      if (!voice && !music) {
        cleanupFiles([voice, music]);

        return res.json({
          ok: true,
          video: `/renders/${path.basename(outputFile)}`
        });
      }

      // Voice + music
      if (voice && music) {
        await new Promise((resolve, reject) => {
          ffmpeg(outputFile)
            .input(voice.path)
            .input(music.path)
            .complexFilter([
              '[1:a]volume=1.0[voice]',
              '[2:a]volume=0.18[music]',
              '[voice][music]amix=inputs=2:duration=first[aout]'
            ])
            .outputOptions([
              '-map',
              '0:v:0',
              '-map',
              '[aout]',
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-c:a',
              'aac',
              '-b:a',
              '192k',
              '-shortest',
              '-movflags',
              '+faststart'
            ])
            .save(finalFile)
            .on('end', resolve)
            .on('error', reject);
        });
      }

      // Voice only
      else if (voice) {
        await new Promise((resolve, reject) => {
          ffmpeg(outputFile)
            .input(voice.path)
            .outputOptions([
              '-map',
              '0:v:0',
              '-map',
              '1:a:0',
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-c:a',
              'aac',
              '-b:a',
              '192k',
              '-shortest',
              '-movflags',
              '+faststart'
            ])
            .save(finalFile)
            .on('end', resolve)
            .on('error', reject);
        });
      }

      // Music only
      else if (music) {
        await new Promise((resolve, reject) => {
          ffmpeg(outputFile)
            .input(music.path)
            .outputOptions([
              '-map',
              '0:v:0',
              '-map',
              '1:a:0',
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-c:a',
              'aac',
              '-b:a',
              '192k',
              '-shortest',
              '-movflags',
              '+faststart'
            ])
            .save(finalFile)
            .on('end', resolve)
            .on('error', reject);
        });
      }

      cleanupFiles([voice, music]);

      jobs.set(jobId, {
        ...job,
        status: 'complete',
        progress: 100,
        video: `/renders/${path.basename(finalFile)}`
      });

      res.json({
        ok: true,
        video: `/renders/${path.basename(finalFile)}`
      });
    } catch (error) {
      console.error('RENDER ERROR:', error);

      cleanupFiles([voice, music]);

      res.status(500).json({
        error:
          error?.message ||
          'Final video render failed.'
      });
    }
  }
);

app.get('/', (req, res) => {
  res.sendFile(path.join(root, 'index.html'));
});
  


app.use((error, req, res, next) => {
  console.error('SERVER ERROR:', error);

  res.status(500).json({
    error:
      error?.message ||
      'Internal server error.'
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `Raz Ki Duniya AI Video Maker running on port ${PORT}`
  );
});
