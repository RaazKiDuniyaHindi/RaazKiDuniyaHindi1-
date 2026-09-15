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
const HF_SPACE_URL =
  'https://frameai4687-omni-video-factory.hf.space';

fs.mkdirSync(path.join(root, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(root, 'renders'), { recursive: true });

app.use(express.json());
app.use(express.static(root));
app.use(
  '/renders',
  express.static(path.join(root, 'renders'))
);

app.get('/', (req, res) => {
  res.sendFile(path.join(root, 'index.html'));
});

let GRADIO_CLIENT = null;

async function getClient() {
  if (!GRADIO_CLIENT) {
    GRADIO_CLIENT = await Client.connect(SPACE);
  }

  return GRADIO_CLIENT;
}

/* -------------------------------------------------- */
/* Find Omni Text-to-Video endpoint                   */
/* -------------------------------------------------- */

function findT2VEndpoint(api) {
  const all = {
    ...(api.named_endpoints || {}),
    ...(api.unnamed_endpoints || {})
  };

  for (const [endpoint, info] of Object.entries(all)) {
    const text = JSON.stringify(info).toLowerCase();

    if (
      text.includes('scene count') &&
      text.includes('seconds per scene') &&
      text.includes('aspect ratio') &&
      text.includes('base prompt')
    ) {
      return [endpoint, info];
    }
  }

  return null;
}

/* -------------------------------------------------- */
/* Convert Gradio FileData / URL / path to video URL  */
/* -------------------------------------------------- */

function extractVideo(value, seen = new Set()) {
  if (value == null) {
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
      text.startsWith('/gradio_api/file=') ||
      text.startsWith('/file=')
    ) {
      return HF_SPACE_URL + text;
    }

    if (
      /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(text)
    ) {
      return (
        HF_SPACE_URL +
        '/gradio_api/file=' +
        encodeURIComponent(text)
      );
    }

    return null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }

  seen.add(value);

  /* Gradio FileData.url */
  if (typeof value.url === 'string') {
    const u = value.url.trim();

    if (/^https?:\/\//i.test(u)) {
      return u;
    }

    if (
      u.startsWith('/gradio_api/file=') ||
      u.startsWith('/file=')
    ) {
      return HF_SPACE_URL + u;
    }
  }

  /* Search common FileData/output properties */
  const keys = [
    'video',
    'url',
    'path',
    'file',
    'data',
    'value',
    'output',
    'outputs',
    'result'
  ];

  for (const key of keys) {
    if (!(key in value)) {
      continue;
    }

    const found = extractVideo(value[key], seen);

    if (found) {
      return found;
    }
  }

  /* Arrays / unknown nested objects */
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractVideo(item, seen);

      if (found) {
        return found;
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key)) {
      continue;
    }

    const found = extractVideo(child, seen);

    if (found) {
      return found;
    }
  }

  return null;
}

/* -------------------------------------------------- */
/* Build Omni parameters                              */
/* -------------------------------------------------- */

function buildParameters(endpointInfo, body) {
  const parameters =
    endpointInfo.parameters || [];

  return parameters.map((param) => {
    const label = String(
      param.label ||
      param.name ||
      param.parameter_name ||
      ''
    ).toLowerCase();

    /* Scene count */
    if (label.includes('scene count')) {
      return 1;
    }

    /* Seconds per scene */
    if (
      label.includes('seconds per scene') ||
      label.includes('seconds')
    ) {
      return 3;
    }

    /* Resolution */
    if (label.includes('resolution')) {
      return 384;
    }

    /* Aspect ratio */
    if (label.includes('aspect ratio')) {
      return body.format || '9:16';
    }

    /* Base prompt */
    if (label.includes('base prompt')) {
      return (
        `Create a cinematic ${body.style || 'Mystery'} ` +
        `realistic video. High quality visual storytelling.`
      );
    }

    /* Scene prompts */
    if (
      label.includes('scene prompt 1') ||
      label.includes('scene 1') ||
      label.startsWith('s1')
    ) {
      return body.script;
    }

    if (
      label.includes('scene prompt 2') ||
      label.includes('scene 2') ||
      label.startsWith('s2')
    ) {
      return '';
    }

    if (
      label.includes('scene prompt 3') ||
      label.includes('scene 3') ||
      label.startsWith('s3')
    ) {
      return '';
    }

    if (
      label.includes('scene prompt 4') ||
      label.includes('scene 4') ||
      label.startsWith('s4')
    ) {
      return '';
    }

    return null;
  });
}

/* -------------------------------------------------- */
/* Generate AI video                                  */
/* -------------------------------------------------- */

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
      return res
        .status(400)
        .json({
          error: 'Script डालें।'
        });
    }

    const jobId =
      Date.now().toString();

    jobs.set(jobId, {
      status: 'generating',
      progress: 5,
      scenes: []
    });

    res.json({
      jobId,
      sceneCount: 1
    });

    try {
      const client =
        await getClient();

      console.log(
        'Connecting to Omni Video Factory...'
      );

      const api =
        await client.view_api(true);

      const endpoint =
        findT2VEndpoint(api);

      if (!endpoint) {
        throw new Error(
          'Omni T2V endpoint नहीं मिला।'
        );
      }

      const endpointName =
        endpoint[0];

      const endpointInfo =
        endpoint[1];

      console.log(
        'OMNI T2V ENDPOINT:',
        endpointName
      );

      const values =
        buildParameters(
          endpointInfo,
          {
            script,
            format:
              req.body.format || '9:16',
            style:
              req.body.style || 'Mystery'
          }
        );

      console.log(
        'OMNI INPUT COUNT:',
        values.length
      );

      /*
       * IMPORTANT:
       * Use predict() so we receive the
       * completed Gradio result directly.
       */
      const response =
        await client.predict(
          endpointName,
          values
        );

      console.log(
        'OMNI RESPONSE:',
        JSON.stringify(response).slice(
          0,
          10000
        )
      );

      const videoUrl =
        extractVideo(response);

      if (!videoUrl) {
        throw new Error(
          'AI ने video output नहीं दिया। Omni response में video file नहीं मिली।'
        );
      }

      console.log(
        'OMNI VIDEO URL:',
        videoUrl
      );

      jobs.set(jobId, {
        status: 'ready',
        progress: 100,
        scenes: [videoUrl]
      });

    } catch (error) {
      console.error(
        'OMNI ERROR:',
        error
      );

      jobs.set(jobId, {
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

/* -------------------------------------------------- */
/* Job status                                         */
/* -------------------------------------------------- */

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

/* -------------------------------------------------- */
/* Final render with voice/music                      */
/* -------------------------------------------------- */

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
      return res
        .status(400)
        .json({
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

      const buffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      fs.writeFileSync(
        output,
        buffer
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

      res
        .status(500)
        .json({
          error:
            error?.message ||
            String(error)
        });
    }
  }
);

/* -------------------------------------------------- */
/* Start server                                       */
/* -------------------------------------------------- */

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
