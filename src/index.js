import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Client } from '@gradio/client';
import ffmpeg from 'fluent-ffmpeg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

const app = express();

const upload = multer({
  dest: path.join(root, 'uploads')
});

const jobs = new Map();

const SPACE = 'FrameAI4687/Omni-Video-Factory';
const HF = 'https://frameai4687-omni-video-factory.hf.space';

fs.mkdirSync(path.join(root, 'uploads'), {
  recursive: true
});

fs.mkdirSync(path.join(root, 'renders'), {
  recursive: true
});

app.use(express.json());
app.use(express.static(root));
app.use(
  '/renders',
  express.static(path.join(root, 'renders'))
);

app.get('/', (req, res) => {
  res.sendFile(path.join(root, 'index.html'));
});

let C = null;

async function client() {
  if (!C) {
    C = await Client.connect(SPACE);
  }

  return C;
}

/* ================================
   FIND OMNI T2V
================================ */

function findT2V(api) {
  const all = {
    ...(api.named_endpoints || {}),
    ...(api.unnamed_endpoints || {})
  };

  for (const [name, info] of Object.entries(all)) {
    const params = info?.parameters || [];

    const labels = params.map(x =>
      String(
        x.label ||
        x.name ||
        x.parameter_name ||
        ''
      ).toLowerCase()
    );

    const joined = labels.join(' | ');

    const sceneCount = labels.some(x =>
      x.includes('scene count')
    );

    const seconds = labels.some(x =>
      x.includes('seconds')
    );

    const resolution = labels.some(x =>
      x.includes('resolution')
    );

    const aspect = labels.some(x =>
      x.includes('aspect ratio')
    );

    const basePrompt = labels.some(x =>
      x.includes('base prompt')
    );

    const scene1 = labels.some(x =>
      x.includes('scene 1') ||
      x.includes('s1')
    );

    const hasImageInput =
      labels.some(x =>
        x.includes('image file') ||
        x.includes('input image') ||
        x === 'image' ||
        x.includes('start image')
      );

    console.log(
      'OMNI ENDPOINT:',
      name,
      'PARAMS:',
      params.length,
      joined
    );

    if (
      params.length === 9 &&
      sceneCount &&
      seconds &&
      resolution &&
      aspect &&
      basePrompt &&
      scene1 &&
      !hasImageInput
    ) {
      console.log(
        'OMNI T2V FOUND:',
        name
      );

      return [name, info];
    }
  }

  return null;
}

/* ================================
   EXTRACT VIDEO
================================ */

function getVideo(value, seen = new Set()) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    const text = value.trim();

    if (!text) {
      return null;
    }

    if (/^https?:\/\//i.test(text)) {
      return text;
    }

    if (
      text.startsWith('/gradio_api/file=')
    ) {
      return HF + text;
    }

    if (
      text.startsWith('/file=')
    ) {
      return HF + text;
    }

    if (
      /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(text)
    ) {
      return (
        HF +
        '/gradio_api/file=' +
        encodeURIComponent(text)
      );
    }

    return null;
  }

  if (
    typeof value !== 'object' ||
    seen.has(value)
  ) {
    return null;
  }

  seen.add(value);

  const directKeys = [
    'url',
    'video',
    'path',
    'file',
    'data',
    'value',
    'output',
    'outputs',
    'result'
  ];

  for (const key of directKeys) {
    if (!(key in value)) {
      continue;
    }

    const found = getVideo(
      value[key],
      seen
    );

    if (found) {
      return found;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = getVideo(
        item,
        seen
      );

      if (found) {
        return found;
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (directKeys.includes(key)) {
      continue;
    }

    const found = getVideo(
      child,
      seen
    );

    if (found) {
      return found;
    }
  }

  return null;
}

/* ================================
   BUILD T2V INPUTS
================================ */

function buildValues(info, body) {
  const params =
    info?.parameters || [];

  return params.map(param => {
    const label = String(
      param.label ||
      param.name ||
      param.parameter_name ||
      ''
    ).toLowerCase();

    if (
      label.includes('scene count')
    ) {
      return 1;
    }

    if (
      label.includes('seconds per scene')
    ) {
      return 3;
    }

    if (
      label.includes('resolution')
    ) {
      return 384;
    }

    if (
      label.includes('aspect ratio')
    ) {
      return body.format || '9:16';
    }

    if (
      label.includes('base prompt')
    ) {
      return (
        `Cinematic ${body.style || 'Mystery'} ` +
        `realistic storytelling video`
      );
    }

    if (
      label.includes('scene 1') ||
      label.startsWith('s1')
    ) {
      return body.script;
    }

    if (
      label.includes('scene 2') ||
      label.startsWith('s2')
    ) {
      return '';
    }

    if (
      label.includes('scene 3') ||
      label.startsWith('s3')
    ) {
      return '';
    }

    if (
      label.includes('scene 4') ||
      label.startsWith('s4')
    ) {
      return '';
    }

    return null;
  });
}

/* ================================
   GENERATE
================================ */

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
    const script =
      req.body?.script?.trim();

    if (!script) {
      return res.status(400).json({
        error: 'Script डालें।'
      });
    }

    const id =
      Date.now().toString();

    jobs.set(id, {
      status: 'generating',
      progress: 5,
      scenes: []
    });

    res.json({
      jobId: id,
      sceneCount: 1
    });

    try {
      const c = await client();

      const api =
        await c.view_api(true);

      const endpoint =
        findT2V(api);

      if (!endpoint) {
        throw new Error(
          'Omni T2V endpoint नहीं मिला।'
        );
      }

      const name = endpoint[0];
      const info = endpoint[1];

      const values =
        buildValues(
          info,
          {
            script,
            format:
              req.body.format || '9:16',
            style:
              req.body.style || 'Mystery'
          }
        );

      console.log(
        'OMNI CALL:',
        name
      );

      console.log(
        'OMNI INPUTS:',
        JSON.stringify(values)
      );

      const job =
        c.submit(
          name,
          values
        );

      let result = null;

      for await (const msg of job) {
        console.log(
          'OMNI MESSAGE:',
          JSON.stringify(msg).slice(
            0,
            5000
          )
        );

        if (
          msg &&
          msg.type === 'data'
        ) {
          result = msg.data;
        }
      }

      console.log(
        'OMNI FINAL:',
        JSON.stringify(result).slice(
          0,
          10000
        )
      );

      const video =
        getVideo(result);

      if (!video) {
        throw new Error(
          'AI ने video output नहीं दिया।'
        );
      }

      console.log(
        'OMNI VIDEO:',
        video
      );

      jobs.set(id, {
        status: 'ready',
        progress: 100,
        scenes: [video]
      });

    } catch (error) {
      console.error(
        'OMNI ERROR:',
        error
      );

      jobs.set(id, {
        status: 'error',
        progress: 0,
        scenes: [],
        error:
          error?.message ||
          String(error)
      });
    }
  }
);

/* ================================
   JOB STATUS
================================ */

app.get(
  '/api/job/:id',
  (req, res) => {
    res.json(
      jobs.get(req.params.id) || {
        status: 'not_found'
      }
    );
  }
);

/* ================================
   RENDER
================================ */

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
      jobs.get(req.body.jobId);

    if (
      !job ||
      job.status !== 'ready'
    ) {
      return res.status(400).json({
        error:
          'पहले AI video generate करें।'
      });
    }

    const output =
      path.join(
        root,
        'renders',
        `${req.body.jobId}.mp4`
      );

    try {
      const response =
        await fetch(
          job.scenes[0]
        );

      if (!response.ok) {
        throw new Error(
          `AI video download failed: HTTP ${response.status}`
        );
      }

      fs.writeFileSync(
        output,
        Buffer.from(
          await response.arrayBuffer()
        )
      );

      const voice =
        req.files?.voice?.[0]?.path;

      const music =
        req.files?.music?.[0]?.path;

      if (!voice && !music) {
        return res.json({
          video:
            '/renders/' +
            path.basename(output)
        });
      }

      const finalOutput =
        output.replace(
          '.mp4',
          '_final.mp4'
        );

      const command =
        ffmpeg(output);

      if (voice) {
        command.input(voice);
      }

      if (music) {
        command.input(music);
      }

      const options = [
        '-map',
        '0:v:0'
      ];

      if (voice && music) {
        options.push(
          '-filter_complex',
          '[1:a]volume=1[a];' +
          '[2:a]volume=.18[b];' +
          '[a][b]amix=2:duration=first[aout]',
          '-map',
          '[aout]'
        );
      } else {
        options.push(
          '-map',
          '1:a:0'
        );
      }

      options.push(
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-shortest'
      );

      await new Promise(
        (resolve, reject) => {
          command
            .outputOptions(options)
            .save(finalOutput)
            .on('end', resolve)
            .on('error', reject);
        }
      );

      res.json({
        video:
          '/renders/' +
          path.basename(finalOutput)
      });

    } catch (error) {
      console.error(
        'RENDER ERROR:',
        error
      );

      res.status(500).json({
        error:
          error?.message ||
          String(error)
      });
    }
  }
);

/* ================================
   START
================================ */

const PORT =
  Number(
    process.env.PORT || 3000
  );

app.listen(
  PORT,
  () => {
    console.log(
      `Raz Ki Duniya started on port ${PORT}`
    );
  }
);
