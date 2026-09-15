import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';

const __dirname =
  path.dirname(fileURLToPath(import.meta.url));

const root =
  path.join(__dirname, '..');

const app = express();

const PORT =
  Number(process.env.PORT || 3000);

const uploadsDir =
  path.join(root, 'uploads');

const rendersDir =
  path.join(root, 'renders');

fs.mkdirSync(
  uploadsDir,
  { recursive: true }
);

fs.mkdirSync(
  rendersDir,
  { recursive: true }
);

const upload =
  multer({
    dest: uploadsDir
  });

app.use(
  express.json({
    limit: '5mb'
  })
);

app.use(
  express.static(
    path.join(root, 'public')
  )
);

app.use(
  '/renders',
  express.static(rendersDir)
);

const apiKey =
  process.env.RUNWAYML_API_SECRET?.trim();

const jobs =
  new Map();

const RUNWAY_BASE =
  'https://api.dev.runwayml.com';

const RUNWAY_VERSION =
  '2024-11-06';

function splitScenes(script) {
  const clean =
    String(script || '')
      .replace(/\s+/g, ' ')
      .trim();

  if (!clean) {
    return [];
  }

  const parts =
    clean
      .split(
        /(?<=[.!?।])\s+/
      )
      .filter(Boolean);

  return (
    parts.length
      ? parts
      : [clean]
  ).slice(0, 20);
}

function setJob(id, patch) {
  const old =
    jobs.get(id) || {};

  jobs.set(id, {
    ...old,
    ...patch,
    updatedAt: Date.now()
  });
}

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

function errorText(error) {
  if (!error) {
    return 'Unknown error';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error.message) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function friendlyRunwayError(error) {
  const raw =
    errorText(error);

  const lower =
    raw.toLowerCase();

  if (
    lower.includes(
      'not have enough credits'
    ) ||
    lower.includes(
      'insufficient'
    ) ||
    lower.includes(
      'credit'
    )
  ) {
    return (
      'Runway credits पर्याप्त नहीं हैं। ' +
      'Credits जोड़ने के बाद ही AI scene generate होगा।'
    );
  }

  if (
    lower.includes('validation of body')
  ) {
    return (
      'Runway request validation failed: ' +
      raw
    );
  }

  if (
    lower.includes('401') ||
    lower.includes('unauthorized')
  ) {
    return (
      'Runway API key गलत या expired है। ' +
      'RUNWAYML_API_SECRET जाँचें।'
    );
  }

  if (
    lower.includes('502') ||
    lower.includes('bad gateway') ||
    lower.includes('<html') ||
    lower.includes('<!doctype')
  ) {
    return (
      'Runway job-status server ने अस्थायी HTTP 502 response दिया।'
    );
  }

  return raw;
}

/*
 * Runway API से JSON response लेना.
 *
 * HTML या empty response मिलने पर
 * उसे JSON मानकर parse नहीं करेंगे.
 */
async function runwayRequest(
  url,
  options = {}
) {
  const response =
    await fetch(
      url,
      {
        ...options,
        headers: {
          Authorization:
            `Bearer ${apiKey}`,

          'Content-Type':
            'application/json',

          'X-Runway-Version':
            RUNWAY_VERSION,

          ...(options.headers || {})
        }
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    const error =
      new Error(
        `HTTP ${response.status} — ${text.slice(0, 1000)}`
      );

    error.status =
      response.status;

    error.responseText =
      text;

    throw error;
  }

  if (!text.trim()) {
    throw new Error(
      'Runway server ने empty response दिया।'
    );
  }

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    const error =
      new Error(
        `Runway server ने JSON की जगह HTML/अन्य response भेजा। HTTP ${response.status} — ${text.slice(0, 500)}`
      );

    error.status =
      response.status;

    error.responseText =
      text;

    throw error;
  }

  return data;
}

/*
 * नया text-to-video task.
 *
 * Official Runway endpoint:
 * POST /v1/text_to_video
 */
async function createRunwayTask(
  prompt,
  ratio
) {
  const body = {
    model: 'gen4.5',
    promptText: prompt,
    ratio,
    duration: 5
  };

  console.log(
    'Creating Runway text-to-video task...'
  );

  console.log(
    'Runway request:',
    JSON.stringify(body)
  );

  return await runwayRequest(
    `${RUNWAY_BASE}/v1/text_to_video`,
    {
      method: 'POST',
      body:
        JSON.stringify(body)
    }
  );
}

/*
 * Existing Runway task का status.
 *
 * 502 / 503 / 504 / network error पर
 * उसी task को retry किया जाएगा.
 *
 * नया task नहीं बनाया जाएगा.
 */
async function getRunwayTask(
  taskId
) {
  const maxAttempts = 8;

  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;

    try {
      const task =
        await runwayRequest(
          `${RUNWAY_BASE}/v1/tasks/${taskId}`,
          {
            method: 'GET',
            headers: {
              'Content-Type':
                'application/json'
            }
          }
        );

      return task;

    } catch (error) {
      const status =
        Number(error?.status || 0);

      const raw =
        errorText(error)
          .toLowerCase();

      const temporary =
        status === 502 ||
        status === 503 ||
        status === 504 ||
        raw.includes(
          'bad gateway'
        ) ||
        raw.includes(
          'gateway'
        ) ||
        raw.includes(
          'network'
        ) ||
        raw.includes(
          'fetch failed'
        ) ||
        raw.includes(
          'timeout'
        ) ||
        raw.includes(
          '<html'
        ) ||
        raw.includes(
          '<!doctype'
        );

      if (
        !temporary ||
        attempt >= maxAttempts
      ) {
        throw error;
      }

      const backoff =
        Math.min(
          30000,
          5000 *
            Math.pow(
              2,
              attempt - 1
            )
        );

      const jitter =
        Math.floor(
          Math.random() * 2000
        );

      const wait =
        backoff + jitter;

      console.warn(
        `Runway status ${status || 'temporary'} error. Retry ${attempt}/${maxAttempts} in ${wait}ms`
      );

      await sleep(wait);
    }
  }

  throw new Error(
    'Runway task status check failed after retries.'
  );
}

/*
 * Task को पूरा होने तक poll करना.
 */
async function waitForRunwayTask(
  taskId
) {
  const started =
    Date.now();

  const timeoutMs =
    12 * 60 * 1000;

  while (
    Date.now() - started <
    timeoutMs
  ) {
    const task =
      await getRunwayTask(
        taskId
      );

    const status =
      String(
        task?.status || ''
      ).toUpperCase();

    console.log(
      `Runway task ${taskId}: ${status}`
    );

    if (
      status === 'SUCCEEDED'
    ) {
      return task;
    }

    if (
      status === 'FAILED' ||
      status === 'CANCELED'
    ) {
      const error =
        new Error(
          task?.failure ||
          task?.failureCode ||
          `Runway task ${status}.`
        );

      error.taskDetails =
        task;

      throw error;
    }

    /*
     * Runway recommends 5 seconds or more
     * between status requests.
     */
    const jitter =
      Math.floor(
        Math.random() * 1500
      );

    await sleep(
      5000 + jitter
    );
  }

  throw new Error(
    'Runway task polling timeout: 12 मिनट में task पूरा नहीं हुआ।'
  );
}

app.get(
  '/api/status',
  (req, res) => {
    res.json({
      ok: true,
      runwayConfigured:
        Boolean(apiKey),
      ffmpeg: true
    });
  }
);

app.post(
  '/api/generate',
  upload.fields([
    {
      name: 'voice',
      maxCount: 1
    },
    {
      name: 'music',
      maxCount: 1
    },
    {
      name: 'characterImage',
      maxCount: 1
    }
  ]),
  async (req, res) => {
    try {
      if (!apiKey) {
        return res.status(400).json({
          ok: false,
          error:
            'Runway API key is not configured. Put RUNWAYML_API_SECRET in .env on the server.'
        });
      }

      const script =
        String(
          req.body?.script || ''
        ).trim();

      const format =
        req.body?.format ||
        '9:16';

      const style =
        String(
          req.body?.style ||
          'Mystery'
        ).trim();

      const characterMode =
        req.body?.characterMode ||
        'off';

      if (!script) {
        return res.status(400).json({
          ok: false,
          error:
            'Script is required.'
        });
      }

      const scenes =
        splitScenes(script);

      if (!scenes.length) {
        return res.status(400).json({
          ok: false,
          error:
            'No scenes found in script.'
        });
      }

      const id =
        `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

      setJob(id, {
        status:
          'generating',

        progress:
          1,

        sceneCount:
          scenes.length,

        completedScenes:
          0,

        scenes: [],

        characterMode
      });

      res.status(202).json({
        ok: true,
        jobId: id,
        sceneCount:
          scenes.length
      });

      void (async () => {
        const urls = [];

        try {
          const ratio =
            format === '16:9'
              ? '1280:720'
              : '720:1280';

          for (
            let i = 0;
            i < scenes.length;
            i++
          ) {
            /*
             * Scene start.
             */
            setJob(id, {
              status:
                'generating',

              progress:
                Math.max(
                  2,
                  5 +
                    Math.round(
                      (i /
                        scenes.length) *
                        85
                    )
                ),

              completedScenes:
                i,

              sceneCount:
                scenes.length,

              scenes:
                [...urls],

              characterMode
            });

            const prompt =
              `Cinematic Hindi mystery documentary scene. ` +
              `Style: ${style}. ` +
              `No text, no subtitles, no logos. ` +
              `Realistic cinematic visuals, natural camera movement, ` +
              `detailed environment and dramatic lighting. ` +
              `Visualize this narration naturally: ` +
              `${scenes[i]}`;

            /*
             * Direct official text-to-video API.
             */
            const created =
              await createRunwayTask(
                prompt,
                ratio
              );

            const taskId =
              created?.id;

            if (!taskId) {
              throw new Error(
                'Runway ने task ID नहीं दिया।'
              );
            }

            console.log(
              `Runway scene ${i + 1}/${scenes.length} task ID: ${taskId}`
            );

            /*
             * अब उसी task को poll करेंगे.
             */
            const completed =
              await waitForRunwayTask(
                taskId
              );

            const url =
              completed?.output?.[0];

            if (!url) {
              throw new Error(
                'Runway task succeeded but returned no video URL.'
              );
            }

            urls.push(url);

            const progress =
              5 +
              Math.round(
                ((i + 1) /
                  scenes.length) *
                  95
              );

            setJob(id, {
              status:
                i + 1 ===
                scenes.length
                  ? 'ready'
                  : 'generating',

              progress:
                i + 1 ===
                scenes.length
                  ? 100
                  : Math.min(
                      99,
                      progress
                    ),

              completedScenes:
                i + 1,

              sceneCount:
                scenes.length,

              scenes:
                [...urls],

              characterMode
            });

            console.log(
              `Runway scene ${i + 1}/${scenes.length} completed.`
            );
          }

        } catch (error) {
          const message =
            friendlyRunwayError(
              error
            );

          setJob(id, {
            status:
              'error',

            progress:
              0,

            completedScenes:
              urls.length,

            sceneCount:
              scenes.length,

            scenes:
              urls,

            error:
              message,

            errorType:
              'RUNWAY_ERROR'
          });

          console.error(
            `Runway job ${id} failed:`,
            error
          );
        }
      })();

    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          friendlyRunwayError(
            error
          )
      });
    }
  }
);

app.get(
  '/api/job/:id',
  (req, res) => {
    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res.status(404).json({
        ok: false,
        status:
          'not_found',

        error:
          'Job not found.'
      });
    }

    /*
     * हमेशा JSON.
     */
    res
      .type('application/json')
      .json({
        ok: true,
        ...job
      });
  }
);

app.post(
  '/api/render',
  upload.fields([
    {
      name: 'voice',
      maxCount: 1
    },
    {
      name: 'music',
      maxCount: 1
    }
  ]),
  async (req, res) => {
    const job =
      jobs.get(
        req.body?.jobId
      );

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
          await fetch(
            job.scenes[i]
          );

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
            .on(
              'end',
              resolve
            )
            .on(
              'error',
              reject
            );
        }
      );

      const voice =
        req.files?.voice?.[0]?.path;

      const music =
        req.files?.music?.[0]?.path;

      if (
        !voice &&
        !music
      ) {
        return res.json({
          ok: true,
          video:
            `/renders/${path.basename(
              out
            )}`
        });
      }

      const final =
        out.replace(
          '.mp4',
          '_final.mp4'
        );

      const cmd =
        ffmpeg(out);

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

      if (
        voice &&
        music
      ) {
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
            .on(
              'end',
              resolve
            )
            .on(
              'error',
              reject
            );
        }
      );

      res.json({
        ok: true,
        video:
          `/renders/${path.basename(
            final
          )}`
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
