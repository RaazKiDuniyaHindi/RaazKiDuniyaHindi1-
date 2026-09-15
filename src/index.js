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

const HF_SPACE_URL =
  'https://frameai4687-omni-video-factory.hf.space';

let hfClientPromise = null;
let hfApiPromise = null;

async function getHFClient() {
  if (!hfClientPromise) {
    hfClientPromise =
      Client.connect(
        HF_SPACE,
        process.env.HF_TOKEN
          ? {
              token:
                process.env.HF_TOKEN
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
        name:
          Number.isNaN(Number(name))
            ? name
            : Number(name),
        info
      })
    )
  ];

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

    values.push(null);
  }

  console.log(
    'OMNI T2V INPUT COUNT:',
    values.length
  );

  return values;
}

/*
  Gradio local path को accessible URL में बदलना।
*/
function gradioPathToUrl(value) {
  if (
    typeof value !== 'string'
  ) {
    return null;
  }

  const text =
    value.trim();

  if (!text) {
    return null;
  }

  if (
    /^https?:\/\//i.test(text)
  ) {
    return text;
  }

  /*
    केवल video-looking paths को URL बनाएं।
  */
  if (
    /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(
      text
    )
  ) {
    return (
      `${HF_SPACE_URL}/gradio_api/file=` +
      encodeURIComponent(text)
    );
  }

  return null;
}

/*
  Gradio output से video URL निकालना।
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
    return gradioPathToUrl(
      value
    );
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
    FileData का URL पहले।
  */
  if (
    typeof value.url === 'string' &&
    /^https?:\/\//i.test(
      value.url
    )
  ) {
    return value.url;
  }

  /*
    FileData का path।
  */
  if (
    typeof value.path === 'string'
  ) {
    const pathUrl =
      gradioPathToUrl(
        value.path
      );

    if (pathUrl) {
      return pathUrl;
    }
  }

  /*
    Common nested fields।
  */
  const preferredKeys = [
    'video',
    'file',
    'data',
    'value',
    'output',
    'video_url',
    'videoUrl'
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
    अंतिम recursive fallback।
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

app.post(
  '/api/generate',

  upload.fields([
    {
      name: 'voice',
      maxCount: 1
    },
    {
      name: 'music',
