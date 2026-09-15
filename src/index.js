import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import { Client } from '@gradio/client';

const __dirname =
  path.dirname(fileURLToPath(import.meta.url));

const root =
  path.join(__dirname, '..');

const app =
  express();

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

/*
 * Free Hugging Face ZeroGPU LTX Video Space.
 *
 * Runway पूरी तरह हटाया गया है।
 */
const LTX_SPACE =
  process.env.LTX_SPACE ||
  'Lightricks/ltx-video-distilled';

const HF_TOKEN =
  process.env.HF_TOKEN?.trim() ||
  process.env.HUGGINGFACE_TOKEN?.trim() ||
  '';

const jobs =
  new Map();

let ltxClientPromise =
  null;

/*
 * LTX client एक बार connect होगा
 * और फिर सभी scenes के लिए reuse होगा।
 */
async function getLtxClient() {
  if (!ltxClientPromise) {
    ltxClientPromise =
      Client.connect(
        LTX_SPACE,
        HF_TOKEN
          ? { hf_token: HF_TOKEN }
          : undefined
      );
  }

  return await ltxClientPromise;
}

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
    resolve =>
      setTimeout(resolve, ms)
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

function friendlyLtxError(error) {
  const raw =
    errorText(error);

  const lower =
    raw.toLowerCase();

  if (
    lower.includes(
      'gpu quota'
    ) ||
    lower.includes(
      'exceeded your gpu quota'
    ) ||
    lower.includes(
      'no gpu is currently available'
    ) ||
    lower.includes(
      'quota'
    )
  ) {
    return (
      'Free AI GPU अभी उपलब्ध नहीं है या आज की ZeroGPU limit पूरी हो गई है। थोड़ी देर बाद फिर कोशिश करें।'
    );
  }

  if (
    lower.includes(
      'queue'
    ) ||
    lower.includes(
      'timeout'
    )
  ) {
    return (
      'Free AI video queue में बहुत अधिक load है। थोड़ी देर बाद फिर कोशिश करें।'
    );
  }

  if (
    lower.includes(
      'validation'
    )
  ) {
    return (
      'LTX AI request validation failed: ' +
      raw
    );
  }

  return raw;
}

/*
 * LTX के output को URL में बदलना।
 */
function extractVideoUrl(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    if (
      value.startsWith('http://') ||
      value.startsWith('https://')
    ) {
      return value;
    }

    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found =
        extractVideoUrl(item);

      if (found) {
        return found;
      }
    }

    return null;
  }

  if (typeof value === 'object') {
    const candidates = [
      value.url,
      value.path,
      value.video,
      value.file,
      value.name
    ];

    for (const item of candidates) {
      const found =
        extractVideoUrl(item);

      if (found) {
        return found;
      }
    }

    if (value.data) {
      return extractVideoUrl(
        value.data
      );
    }
  }

  return null;
}

/*
 * URL से MP4 download करके
 * local renders folder में रखना।
 */
async function downloadVideo(
  url,
  destination
) {
  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `LTX video download failed: HTTP ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (!buffer.length) {
    throw new Error(
      'LTX ने empty video file लौटाई।'
    );
  }

  fs.writeFileSync(
    destination,
    buffer
  );

  return destination;
}

/*
 * LTX Text-to-Video.
 *
 * Verified endpoint:
 * /text_to_video
 *
 * LTX source के वास्तविक 13 inputs:
 *
 * 1 prompt
 * 2 negative_prompt
 * 3 image
 * 4 video
 * 5 height
 * 6 width
 * 7 mode
 * 8 duration
 * 9 frames
 * 10 seed
 * 11 randomize_seed
 * 12 guidance_scale
 * 13 improve_texture
 */
async function generateLtxVideo(
  prompt,
  ratio,
  destination,
  sceneNumber
) {
  const client =
    await getLtxClient();

  /*
   * LTX के लिए dimensions 32 के
   * multiple रखना सुरक्षित है।
   *
   * Portrait: 720x1280
   * Landscape: 1280x720
   */
  let height =
    ratio === '16:9'
      ? 720
      : 1280;

  let width =
    ratio === '16:9'
      ? 1280
      : 720;

  /*
   * Free ZeroGPU quota बचाने के लिए
   * प्रत्येक scene लगभग 2 सेकंड।
   *
   * LTX source में duration 0.3–8.5
   * seconds स्वीकार करता है।
   */
  const duration =
    2;

  /*
   * Source code FPS = 30.
   * LTX internally frames को 8n+1
   * format में round करता है।
   */
  const frames =
    61;

  const negativePrompt =
    [
      'text',
      'subtitles',
      'captions',
      'logo',
      'watermark',
      'blurry',
      'low quality',
      'deformed',
      'cartoon',
      'anime',
      'static image'
    ].join(', ');

  console.log(
    `LTX scene ${sceneNumber}: submitting to ZeroGPU...`
  );

  /*
   * Text-to-video में image और video
   * दोनों null रहते हैं।
   *
   * mode EXACT:
   * "text-to-video"
   */
  const result =
    await client.predict(
      '/text_to_video',
      [
        prompt,
        negativePrompt,
        null,
        null,
        height,
        width,
        'text-to-video',
        duration,
        frames,
        -1,
        true,
        1,
        false
      ]
    );

  console.log(
    `LTX scene ${sceneNumber} response received.`
  );

  const videoUrl =
    extractVideoUrl(
      result?.data
    );

  if (!videoUrl) {
    console.error(
      'LTX raw response:',
      JSON.stringify(
        result,
        null,
        2
      )
    );

    throw new Error(
      'LTX ने video URL नहीं लौटाया।'
    );
  }

  await downloadVideo(
    videoUrl,
    destination
  );

  return destination;
}

/*
 * Health/status.
 */
app.get(
  '/api/status',
  async (req, res) => {
    res.json({
      ok: true,
      runwayConfigured:
        false,
      ltxConfigured:
        true,
      ltxSpace:
        LTX_SPACE,
      ffmpeg: true,
      backend:
        'Hugging Face ZeroGPU LTX Video'
    });
  }
);

/*
 * Generate AI scenes.
 */
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

      /*
       * Browser को तुरंत job ID.
       */
      res.status(202).json({
        ok: true,
        jobId: id,
        sceneCount:
          scenes.length
      });

      /*
       * Background generation.
       */
      void (async () => {
        const urls = [];

        try {
          const ratio =
            format === '16:9'
              ? '16:9'
              : '9:16';

          for (
            let i = 0;
            i < scenes.length;
            i++
          ) {
            const sceneFile =
              path.join(
                rendersDir,
                `${id}_${i}.mp4`
              );

            setJob(id, {
              status:
                'generating',

              progress:
                Math.max(
                  2,
                  Math.round(
                    (i /
                      scenes.length) *
                      90
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

            /*
             * प्रत्येक scene को
             * cinematic prompt में बदलना।
             */
            const prompt =
              [
                'Cinematic realistic Hindi mystery documentary scene.',
                `Visual style: ${style}.`,
                'Photorealistic live-action appearance.',
                'Natural human/environment movement.',
                'Cinematic camera movement.',
                'Detailed realistic lighting.',
                'No text on screen.',
                'No subtitles.',
                'No logos.',
                'No watermark.',
                `Scene narration: ${scenes[i]}`
              ].join(' ');

            /*
             * Temporary network failures पर
             * पूरा नया job नहीं बनाया जाएगा।
             */
            let lastError =
              null;

            const maxAttempts =
              3;

            for (
              let attempt = 1;
              attempt <= maxAttempts;
              attempt++
            ) {
              try {
                await generateLtxVideo(
                  prompt,
                  ratio,
                  sceneFile,
                  i + 1
                );

                lastError =
                  null;

                break;

              } catch (error) {
                lastError =
                  error;

                console.error(
                  `LTX scene ${i + 1} attempt ${attempt}/${maxAttempts}:`,
                  error
                );

                if (
                  attempt <
                  maxAttempts
                ) {
                  await sleep(
                    5000 * attempt
                  );
                }
              }
            }

            if (lastError) {
              throw lastError;
            }

            /*
             * Local URL.
             */
            const localUrl =
              `/renders/${path.basename(
                sceneFile
              )}`;

            urls.push(
              localUrl
            );

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
              `LTX scene ${i + 1}/${scenes.length} completed.`
            );
          }

        } catch (error) {
          const message =
            friendlyLtxError(
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
              'LTX_ERROR'
          });

          console.error(
            `LTX job ${id} failed:`,
            error
          );
        }
      })();

    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          friendlyLtxError(
            error
          )
      });
    }
  }
);

/*
 * Job status.
 */
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

    res
      .type(
        'application/json'
      )
      .json({
        ok: true,
        ...job
      });
  }
);

/*
 * Final render.
 *
 * Generated scenes को जोड़ना और
 * optional uploaded voice/music लगाना।
 */
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

      /*
       * Scene URLs अब local हैं,
       * इसलिए सीधे files में जाएँगे।
       */
      for (
        let i = 0;
        i < job.scenes.length;
        i++
      ) {
        const scenePath =
          path.join(
            rendersDir,
            path.basename(
              job.scenes[i]
            )
          );

        if (
          !fs.existsSync(
            scenePath
          )
        ) {
          throw new Error(
            `AI scene ${i + 1} file नहीं मिली।`
          );
        }

        files.push(
          scenePath
        );
      }

      fs.writeFileSync(
        list,
        files
          .map(
            file =>
              `file '${file.replaceAll(
                "'",
                "'\\''"
              )}'`
          )
          .join('\n')
      );

      /*
       * सभी scenes जोड़ना।
       */
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

      /*
       * अगर voice/music नहीं है,
       * तो AI video सीधे वापस।
       */
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

/*
 * Global error handler.
 */
app.use(
  (err, req, res, next) => {
    console.error(err);

    if (
      res.headersSent
    ) {
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

    console.log(
      `AI backend: ${LTX_SPACE}`
    );

    console.log(
      'Runway: DISABLED'
    );
  }
);
