import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import RunwayML, { TaskFailedError } from '@runwayml/sdk';
import ffmpeg from 'fluent-ffmpeg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const app = express();
const PORT = Number(process.env.PORT || 3000);

const uploadsDir = path.join(root, 'uploads');
const rendersDir = path.join(root, 'renders');

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(rendersDir, { recursive: true });

const upload = multer({ dest: uploadsDir });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(root, 'public')));
app.use('/renders', express.static(rendersDir));

const apiKey = process.env.RUNWAYML_API_SECRET?.trim();

const client = apiKey
  ? new RunwayML({ apiKey })
  : null;

const jobs = new Map();

function splitScenes(script) {
  const clean = String(script || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return [];

  const parts = clean
    .split(/(?<=[.!?।])\s+/)
    .filter(Boolean);

  return (parts.length ? parts : [clean]).slice(0, 20);
}

function errorText(error) {
  if (!error) return 'Unknown error';

  const details =
    error.taskDetails ||
    error.error ||
    error.response?.data;

  if (details) {
    if (typeof details === 'string') {
      return details;
    }

    if (details.message) {
      return details.message;
    }

    if (details.error) {
      return typeof details.error === 'string'
        ? details.error
        : JSON.stringify(details.error);
    }

    if (Array.isArray(details.issues)) {
      return details.issues
        .map(x => x?.message || JSON.stringify(x))
        .join('; ');
    }

    try {
      return JSON.stringify(details);
    } catch {}
  }

  return error.message || String(error);
}

function friendlyRunwayError(error) {
  const raw = errorText(error);
  const lower = raw.toLowerCase();

  if (
    lower.includes('not have enough credits') ||
    lower.includes('insufficient') ||
    lower.includes('credit')
  ) {
    return 'Runway credits पर्याप्त नहीं हैं। Credits जोड़ने के बाद ही AI scene generate होगा।';
  }

  if (lower.includes('promptimage')) {
    return 'Runway promptImage validation error मिला। यह text-to-video request बिना promptImage के भेजी जा रही है; server ने कोई image field नहीं भेजा।';
  }

  if (lower.includes('validation of body')) {
    return `Runway request validation failed: ${raw}`;
  }

  if (
    lower.includes('401') ||
    lower.includes('unauthorized')
  ) {
    return 'Runway API key गलत या expired है। RUNWAYML_API_SECRET जाँचें।';
  }

  return raw;
}

function setJob(id, patch) {
  const old = jobs.get(id) || {};

  jobs.set(id, {
    ...old,
    ...patch,
    updatedAt: Date.now()
  });
}

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    runwayConfigured: Boolean(client),
    ffmpeg: true
  });
});

app.post(
  '/api/generate',
  upload.fields([
    { name: 'voice', maxCount: 1 },
    { name: 'music', maxCount: 1 },
    { name: 'characterImage', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      if (!client) {
        return res.status(400).json({
          ok: false,
          error:
            'Runway API key is not configured. Put RUNWAYML_API_SECRET in .env on the server.'
        });
      }

      const script = String(
        req.body?.script || ''
      ).trim();

      const format =
        req.body?.format || '9:16';

      const style = String(
        req.body?.style || 'Mystery'
      ).trim();

      const characterMode =
        req.body?.characterMode || 'off';

      if (!script) {
        return res.status(400).json({
          ok: false,
          error: 'Script is required.'
        });
      }

      const scenes = splitScenes(script);

      if (!scenes.length) {
        return res.status(400).json({
          ok: false,
          error: 'No scenes found in script.'
        });
      }

      const id =
        `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

      setJob(id, {
        status: 'generating',
        progress: 1,
        sceneCount: scenes.length,
        completedScenes: 0,
        scenes: [],
        characterMode
      });

      res.status(202).json({
        ok: true,
        jobId: id,
        sceneCount: scenes.length
      });

      void (async () => {
        const urls = [];

        try {
          const ratio =
            format === '16:9'
              ? '1280:720'
              : '720:1280';

          for (let i = 0; i < scenes.length; i++) {
            const prompt =
              `Cinematic Hindi mystery documentary scene. ` +
              `Style: ${style}. ` +
              `No text, no subtitles, no logos. ` +
              `Visualize this narration naturally and realistically: ` +
              `${scenes[i]}`;

            /*
             * IMPORTANT:
             * This is TEXT-TO-VIDEO.
             * promptImage is intentionally NOT included.
             */
            const taskRequest =
              client.imageToVideo.create({
                model: 'gen4.5',
                promptText: prompt,
                ratio,
                duration: 5
              });

            const task =
              await taskRequest.waitForTaskOutput({
                timeout: 12 * 60
              });

            const url =
              task?.output?.[0];

            if (!url) {
              throw new Error(
                'Runway task succeeded but returned no video URL.'
              );
            }

            urls.push(url);

            const pct =
              5 +
              Math.round(
                ((i + 1) / scenes.length) * 85
              );

            setJob(id, {
              status:
                i + 1 === scenes.length
                  ? 'ready'
                  : 'generating',

              progress: pct,

              completedScenes:
                i + 1,

              sceneCount:
                scenes.length,

              scenes: [...urls],

              characterMode
            });
          }
        } catch (error) {
          const message =
            friendlyRunwayError(error);

          setJob(id, {
            status: 'error',
            progress: 0,
            completedScenes: urls.length,
            sceneCount: scenes.length,
            scenes: urls,
            error: message,
            errorType:
              error instanceof TaskFailedError
                ? 'TASK_FAILED'
                : 'REQUEST_FAILED'
          });

          console.error(
            `Runway job ${id} failed:`,
            message
          );
        }
      })();

    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: friendlyRunwayError(error)
      });
    }
  }
);

app.get('/api/job/:id', (req, res) => {
  const job =
    jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      ok: false,
      status: 'not_found',
      error: 'Job not found.'
    });
  }

  res.json({
    ok: true,
    ...job
  });
});

app.post(
  '/api/render',
  upload.fields([
    { name: 'voice', maxCount: 1 },
    { name: 'music', maxCount: 1 }
  ]),
  async (req, res) => {

    const job =
      jobs.get(req.body?.jobId);

    if (
      !job ||
      job.status !== 'ready'
    ) {
      return res.status(400).json({
        ok: false,
        error:
          job?.error ||
          'Generate the AI scenes first.'
      });
    }

    const out =
      path.join(
        rendersDir,
        `${req.body.jobId}.mp4`
      );

    const list =
      path.join(
        rendersDir,
        `${req.body.jobId}.txt`
      );

    try {
      const files = [];

      for (
        let i = 0;
        i < job.scenes.length;
        i++
      ) {
        const p =
          path.join(
            rendersDir,
            `${req.body.jobId}_${i}.mp4`
          );

        const r =
          await fetch(job.scenes[i]);

        if (!r.ok) {
          throw new Error(
            `Could not download Runway scene ${i + 1} (${r.status}).`
          );
        }

        fs.writeFileSync(
          p,
          Buffer.from(
            await r.arrayBuffer()
          )
        );

        files.push(p);
      }

      fs.writeFileSync(
        list,
        files
          .map(
            f =>
              `file '${f.replaceAll(
                "'",
                "'\\''"
              )}'`
          )
          .join('\n')
      );

      await new Promise(
        (resolve, reject) => {
          ffmpeg()
            .input(list)
            .inputOptions([
              '-f',
              'concat',
              '-safe',
              '0'
            ])
            .outputOptions([
              '-c',
              'copy'
            ])
            .save(out)
            .on('end', resolve)
            .on('error', reject);
        }
      );

      const voice =
        req.files?.voice?.[0]?.path;

      const music =
        req.files?.music?.[0]?.path;

      if (!voice && !music) {
        return res.json({
          ok: true,
          video:
            `/renders/${path.basename(out)}`
        });
      }

      const final =
        out.replace(
          '.mp4',
          '_final.mp4'
        );

      const cmd = ffmpeg(out);

      if (voice) {
        cmd.input(voice);
      }

      if (music) {
        cmd.input(music);
      }

      const filters = [];
      let maps = [
        '-map',
        '0:v:0'
      ];

      if (voice && music) {
        filters.push(
          '[1:a]volume=1[a1]',
          '[2:a]volume=0.18[a2]',
          '[a1][a2]amix=inputs=2:duration=first[aout]'
        );

        maps.push(
          '-map',
          '[aout]'
        );

      } else if (voice) {
        maps.push(
          '-map',
          '1:a:0'
        );

      } else {
        maps.push(
          '-map',
          '1:a:0'
        );
      }

      await new Promise(
        (resolve, reject) => {
          cmd
            .outputOptions([
              ...maps,
              '-c:v',
              'libx264',
              '-c:a',
              'aac',
              '-shortest',
              ...(filters.length
                ? [
                    '-filter_complex',
                    filters.join(';')
                  ]
                : [])
            ])
            .save(final)
            .on('end', resolve)
            .on('error', reject);
        }
      );

      res.json({
        ok: true,
        video:
          `/renders/${path.basename(final)}`
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error?.message ||
          String(error)
      });
    }
  }
);

app.use(
  (err, req, res, next) => {
    console.error(err);

    if (res.headersSent) {
      return next(err);
    }

    res.status(500).json({
      ok: false,
      error:
        err?.message ||
        'Server error.'
    });
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Raz Ki Duniya app: http://localhost:${PORT}`
    );
  }
);
