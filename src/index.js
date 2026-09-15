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

const app = express();

const upload =
  multer({
    dest: path.join(root, 'uploads')
  });

fs.mkdirSync(
  path.join(root, 'uploads'),
  { recursive: true }
);

fs.mkdirSync(
  path.join(root, 'renders'),
  { recursive: true }
);

app.use(
  express.json({
    limit: '5mb'
  })
);

app.use(
  express.static(root)
);

app.get('/', (req, res) => {
  res.sendFile(
    path.join(root, 'index.html')
  );
});

const jobs = new Map();

const HF_SPACE =
  'FrameAI4687/Omni-Video-Factory';

let hfClientPromise = null;
let hfApiPromise = null;

async function getHFClient() {
  if (!hfClientPromise) {
    hfClientPromise =
      Client.connect(
        HF_SPACE,
        process.env.HF_TOKEN
          ? {
              token: process.env.HF_TOKEN
            }
          : undefined
      );
  }

  return hfClientPromise;
}

async function getHFApi() {
  if (!hfApiPromise) {
    hfApiPromise =
      (async () => {
        const client =
          await getHFClient();

        return await client.view_api(
          true
        );
      })();
  }

  return hfApiPromise;
}

function splitScenes(script) {
  return script
    .replace(/\s+/g, ' ')
    .trim()
    .split(
      /(?<=[.!?।])\s+/
    )
    .filter(Boolean)
    .slice(0, 4);
}

/*
  Omni Video Factory के endpoint को
  उसके नाम के बजाय उसके parameters से पहचानें।
*/
function findT2VEndpoint(api) {
  const named =
    api?.named_endpoints || {};

  const unnamed =
    api?.unnamed_endpoints || {};

  const candidates = [
    ...Object.entries(named).map(
      ([name, info]) => ({
        name,
        info
      })
    ),

    ...Object.entries(unnamed).map(
      ([name, info]) => ({
        name: Number.isNaN(Number(name))
          ? name
          : Number(name),
        info
      })
    )
  ];

  /*
    Manual T2V को पहले प्राथमिकता।
  */
  const manual =
    candidates.find(endpoint => {
      const text =
        JSON.stringify(
          endpoint.info || {}
        ).toLowerCase();

      return (
        text.includes('scene count') &&
        text.includes('seconds per scene') &&
        text.includes('aspect ratio') &&
        (
          text.includes('s1') ||
          text.includes('scene 1')
        )
      );
    });

  if (manual) {
    console.log(
      'OMNI T2V ENDPOINT FOUND:',
      manual.name
    );

    return manual;
  }

  /*
    सामान्य T2V endpoint fallback।
  */
  const normal =
    candidates.find(endpoint => {
      const parameters =
        endpoint.info?.parameters || [];

      const labels =
        parameters.map(p =>
          String(
            p?.label ||
            p?.name ||
            ''
          ).toLowerCase()
        );

      return (
        labels.some(x =>
          x.includes('scene count')
        ) &&
        labels.some(x =>
          x.includes('seconds per scene') ||
          x.includes('second per scene')
        ) &&
        labels.some(x =>
          x.includes('aspect ratio')
        ) &&
        labels.some(x =>
          x.includes('base prompt')
        )
      );
    });

  if (normal) {
    console.log(
      'OMNI T2V ENDPOINT FOUND:',
      normal.name
    );

    return normal;
  }

  console.error(
    'OMNI AVAILABLE ENDPOINTS:',
    candidates.map(e => ({
      name: e.name,
      parameters:
        (e.info?.parameters || [])
          .map(p =>
            p?.label ||
            p?.name ||
            ''
          )
    }))
  );

  return null;
}

function buildT2VInputs(
  info,
  {
    sceneCount,
    secondsPerScene,
    resolution,
    aspectRatio,
    basePrompt,
    scenes
  }
) {
  const parameters =
    info?.parameters || [];

  if (!parameters.length) {
    throw new Error(
      'Omni Video Factory का T2V API schema खाली मिला।'
    );
  }

  const values = [];

  for (const parameter of parameters) {
    const label =
      String(
        parameter.label ||
        parameter.name ||
        ''
      ).toLowerCase();

    if (
      label.includes('scene count') ||
      label === 'scenes' ||
      label.includes('number of scene')
    ) {
      values.push(sceneCount);
      continue;
    }

    if (
      label.includes('seconds per scene') ||
      label.includes('second per scene') ||
      label === 'seconds'
    ) {
      values.push(secondsPerScene);
      continue;
    }

    if (
      label.includes('resolution')
    ) {
      values.push(resolution);
      continue;
    }

    if (
      label.includes('aspect ratio') ||
      label === 'aspect'
    ) {
      values.push(aspectRatio);
      continue;
    }

    if (
      label.includes('base prompt')
    ) {
      values.push(basePrompt);
      continue;
    }

    if (
      /^s1\b/.test(label) ||
      /scene 1/.test(label)
    ) {
      values.push(
        scenes[0] || ''
      );
      continue;
    }

    if (
      /^s2\b/.test(label) ||
      /scene 2/.test(label)
    ) {
      values.push(
        scenes[1] || ''
      );
      continue;
    }

    if (
      /^s3\b/.test(label) ||
      /scene 3/.test(label)
    ) {
      values.push(
        scenes[2] || ''
      );
      continue;
    }

    if (
      /^s4\b/.test(label) ||
      /scene 4/.test(label)
    ) {
      values.push(
        scenes[3] || ''
      );
      continue;
    }

    /*
      Unknown parameter के लिए null।
    */
    values.push(null);
  }

  console.log(
    'OMNI T2V INPUT COUNT:',
    values.length
  );

  return values;
}

/*
  Gradio output से video URL निकालना।
  Omni के nested FileData/object formats को भी संभालता है।
*/
function extractVideoUrl(
  value,
  seen = new Set()
) {
  if (!value) {
    return null;
  }

  if (
    typeof value === 'string'
  ) {
    if (
      /^https?:\/\//i.test(value)
    ) {
      return value;
    }

    return null;
  }

  if (
    typeof value !== 'object'
  ) {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (
      const item of value
    ) {
      const found =
        extractVideoUrl(
          item,
          seen
        );

      if (found) {
        return found;
      }
    }

    return null;
  }

  /*
    Video/FileData में सामान्य fields।
  */
  const preferredKeys = [
    'url',
    'video',
    'file',
    'path',
    'data',
    'value',
    'output',
    'video_url',
    'videoUrl',
    'filename',
    'name'
  ];

  for (
    const key of preferredKeys
  ) {
    if (
      Object.prototype.hasOwnProperty.call(
        value,
        key
      )
    ) {
      const found =
        extractVideoUrl(
          value[key],
          seen
        );

      if (found) {
        return found;
      }
    }
  }

  /*
    आखिरी fallback:
    object की सभी values recursively देखें।
  */
  for (
    const item of Object.values(value)
  ) {
    const found =
      extractVideoUrl(
        item,
        seen
      );

    if (found) {
      return found;
    }
  }

  return null;
}

app.get(
  '/api/status',
  async (req, res) => {
    try {
      const api =
        await getHFApi();

      const endpoint =
        findT2VEndpoint(api);

      res.json({
        backend:
          'Hugging Face Omni Video Factory',

        space:
          HF_SPACE,

        gradio:
          true,

        t2vEndpoint:
          endpoint?.name ?? null,

        ffmpeg:
          true
      });
    } catch (error) {
      res.status(503).json({
        backend:
          'Hugging Face Omni Video Factory',

        error:
          error?.message ||
          String(error)
      });
    }
  }
);

/*
  VIDEO GENERATION
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
      const {
        script,
        format = '9:16',
        style = 'Mystery',
        characterMode = 'off'
      } = req.body;

      if (!script?.trim()) {
        return res.status(400).json({
          error:
            'Script is required.'
        });
      }

      const scenes =
        splitScenes(script);

      if (!scenes.length) {
        return res.status(400).json({
          error:
            'Script में कोई scene नहीं मिला।'
        });
      }

      const id =
        Date.now().toString();

      jobs.set(id, {
        status:
          'generating',

        progress:
          2,

        scenes:
          [],

        characterMode
      });

      res.json({
        jobId:
          id,

        sceneCount:
          scenes.length
      });

      /*
        Background generation.
      */
      (async () => {
        try {
          jobs.set(id, {
            status:
              'generating',

            progress:
              5,

            scenes:
              [],

            characterMode
          });

          const client =
            await getHFClient();

          const api =
            await getHFApi();

          const endpoint =
            findT2VEndpoint(api);

          if (!endpoint) {
            throw new Error(
              'Omni Video Factory का Text-to-Video endpoint नहीं मिला।'
            );
          }

          const sceneCount =
            Math.min(
              Math.max(
                scenes.length,
                1
              ),
              4
            );

          const selectedScenes =
            scenes.slice(
              0,
              sceneCount
            );

          /*
            Omni supported values:
            seconds = 3 or 5
            resolution = 384 or 512
          */
          const secondsPerScene =
            3;

          const resolution =
            384;

          const aspectRatio =
            [
              '16:9',
              '4:3',
              '1:1',
              '3:4',
              '9:16'
            ].includes(format)
              ? format
              : '9:16';

          const basePrompt =
            `Cinematic Hindi mystery documentary. Style: ${style}. No text, no subtitles, no logos. Realistic cinematic visuals.`;

          const inputs =
            buildT2VInputs(
              endpoint.info,
              {
                sceneCount,

                secondsPerScene,

                resolution,

                aspectRatio,

                basePrompt,

                scenes:
                  selectedScenes
              }
            );

          jobs.set(id, {
            status:
              'generating',

            progress:
              10,

            scenes:
              [],

            characterMode
          });

          /*
            Long-running Gradio job.
          */
          const job =
            client.submit(
              endpoint.name,
              inputs
            );

          let lastProgress =
            10;

          let finalData =
            null;

          for await (
            const message of job
          ) {
            console.log(
              'OMNI MESSAGE TYPE:',
              message?.type
            );

            if (
              message?.type ===
              'status'
            ) {
              const status =
                message.status;

              if (
                status ===
                'generating'
              ) {
                lastProgress =
                  Math.min(
                    lastProgress + 2,
                    85
                  );

                jobs.set(id, {
                  status:
                    'generating',

                  progress:
                    lastProgress,

                  scenes:
                    [],

                  characterMode
                });
              }

              if (
                status ===
                'complete'
              ) {
                jobs.set(id, {
                  status:
                    'generating',

                  progress:
                    90,

                  scenes:
                    [],

                  characterMode
                });
              }
            }

            if (
              message?.type ===
              'data'
            ) {
              finalData =
                message.data;

              console.log(
                'OMNI RAW OUTPUT:',
                JSON.stringify(
                  finalData,
                  null,
                  2
                )
              );
            }
          }

          if (!finalData) {
            throw new Error(
              'AI video generation से कोई output नहीं मिला।'
            );
          }

          const videoUrl =
            extractVideoUrl(
              finalData
            );

          console.log(
            'OMNI EXTRACTED VIDEO URL:',
            videoUrl
          );

          if (!videoUrl) {
            throw new Error(
              'AI ने output दिया लेकिन video file URL नहीं मिला।'
            );
          }

          jobs.set(id, {
            status:
              'ready',

            progress:
              95,

            scenes: [
              videoUrl
            ],

            characterMode
          });

          console.log(
            'OMNI VIDEO READY:',
            id
          );

        } catch (error) {
          console.error(
            'T2V ERROR:',
            error
          );

          jobs.set(id, {
            status:
              'error',

            progress:
              0,

            scenes:
              [],

            error:
              error?.message ||
              String(error)
          });
        }
      })();

    } catch (error) {
      return res.status(500).json({
        error:
          error?.message ||
          String(error)
      });
    }
  }
);

/*
  JOB STATUS
*/
app.get(
  '/api/job/:id',
  (req, res) => {
    res.json(
      jobs.get(
        req.params.id
      ) || {
        status:
          'not_found'
      }
    );
  }
);

/*
  FINAL RENDER
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
        req.body.jobId
      );

    if (
      !job ||
      job.status !== 'ready'
    ) {
      return res.status(400).json({
        error:
          'पहले AI video generate करें।'
      });
    }

    const out =
      path.join(
        root,
        'renders',
        `${req.body.jobId}.mp4`
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
            root,
            'renders',
            `${req.body.jobId}_${i}.mp4`
          );

        const response =
          await fetch(
            job.scenes[i]
          );

        if (!response.ok) {
          throw new Error(
            'AI video download नहीं हो पाया।'
          );
        }

        fs.writeFileSync(
          p,
          Buffer.from(
            await response.arrayBuffer()
          )
        );

        files.push(p);
      }

      if (
        files.length === 1
      ) {
        fs.copyFileSync(
          files[0],
          out
        );
      } else {
        const list =
          path.join(
            root,
            'renders',
            `${req.body.jobId}.txt`
          );

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
      }

      const voice =
        req.files?.voice?.[0]
          ?.path;

      const music =
        req.files?.music?.[0]
          ?.path;

      /*
        Voice/music mix.
      */
      if (
        voice ||
        music
      ) {
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

        let inputs = [];

        if (
          voice &&
          music
        ) {
          filters.push(
            '[1:a]volume=1[a1]',
            '[2:a]volume=0.18[a2]',
            '[a1][a2]amix=inputs=2:duration=first[aout]'
          );

          inputs = [
            '-map',
            '0:v:0',
            '-map',
            '[aout]'
          ];

        } else if (
          voice
        ) {
          inputs = [
            '-map',
            '0:v:0',
            '-map',
            '1:a:0'
          ];

        } else {
          inputs = [
            '-map',
            '0:v:0',
            '-map',
            '1:a:0'
          ];
        }

        await new Promise(
          (resolve, reject) => {
            cmd
              .outputOptions([
                ...inputs,

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

        return res.json({
          video:
            `/renders/${path.basename(
              final
            )}`
        });
      }

      return res.json({
        video:
          `/renders/${path.basename(
            out
          )}`
      });

    } catch (error) {
      return res.status(500).json({
        error:
          error?.message ||
          String(error)
      });
    }
  }
);

app.use(
  '/renders',
  express.static(
    path.join(
      root,
      'renders'
    )
  )
);

const PORT =
  Number(
    process.env.PORT || 3000
  );

app.listen(
  PORT,
  () => {
    console.log(
      `Raz Ki Duniya app running on port ${PORT}`
    );
  }
);
