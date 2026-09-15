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

app.use(
  '/renders',
  express.static(
    path.join(
      root,
      'renders'
    )
  )
);

app.get('/', (req, res) => {
  res.sendFile(
    path.join(
      root,
      'index.html'
    )
  );
});

const jobs =
  new Map();

const HF_SPACE =
  'FrameAI4687/Omni-Video-Factory';

const HF_SPACE_URL =
  'https://frameai4687-omni-video-factory.hf.space';

let hfClientPromise =
  null;

let hfApiPromise =
  null;


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
    .replace(
      /\s+/g,
      ' '
    )
    .trim()
    .split(
      /(?<=[.!?।])\s+/
    )
    .filter(Boolean)
    .slice(0, 4);

}


function findT2VEndpoint(api) {

  const named =
    api?.named_endpoints ||
    {};

  const unnamed =
    api?.unnamed_endpoints ||
    {};

  const candidates = [

    ...Object.entries(
      named
    ).map(
      ([name, info]) => ({
        name,
        info
      })
    ),

    ...Object.entries(
      unnamed
    ).map(
      ([name, info]) => ({
        name:
          Number.isNaN(
            Number(name)
          )
            ? name
            : Number(name),
        info
      })
    )

  ];


  const match =
    candidates.find(
      endpoint => {

        const text =
          JSON.stringify(
            endpoint.info ||
            {}
          ).toLowerCase();

        return (
          text.includes(
            'scene count'
          ) &&
          text.includes(
            'seconds per scene'
          ) &&
          text.includes(
            'aspect ratio'
          ) &&
          text.includes(
            'base prompt'
          )
        );

      }
    );


  if (match) {

    console.log(
      'OMNI T2V ENDPOINT FOUND:',
      match.name
    );

    return match;
  }


  console.error(
    'OMNI AVAILABLE ENDPOINTS:',
    candidates.map(
      e => ({
        name:
          e.name,

        parameters:
          (
            e.info?.parameters ||
            []
          ).map(
            p =>
              p?.label ||
              p?.name ||
              ''
          )
      })
    )
  );

  return null;
}


function buildT2VInputs(
  info,
  options
) {

  const {
    sceneCount,
    secondsPerScene,
    resolution,
    aspectRatio,
    basePrompt,
    scenes
  } = options;


  const parameters =
    info?.parameters ||
    [];


  if (
    !parameters.length
  ) {

    throw new Error(
      'Omni Video Factory का T2V API schema खाली मिला।'
    );

  }


  return parameters.map(
    parameter => {

      const label =
        String(
          parameter?.label ||
          parameter?.name ||
          ''
        )
        .toLowerCase()
        .trim();


      if (
        label.includes(
          'scene count'
        ) ||
        label === 'scenes' ||
        label.includes(
          'number of scene'
        )
      ) {
        return sceneCount;
      }


      if (
        label.includes(
          'seconds per scene'
        ) ||
        label.includes(
          'second per scene'
        ) ||
        label === 'seconds'
      ) {
        return secondsPerScene;
      }


      if (
        label.includes(
          'resolution'
        )
      ) {
        return resolution;
      }


      if (
        label.includes(
          'aspect ratio'
        ) ||
        label === 'aspect'
      ) {
        return aspectRatio;
      }


      if (
        label.includes(
          'base prompt'
        )
      ) {
        return basePrompt;
      }


      if (
        /^s1\b/.test(label) ||
        /scene 1/.test(label)
      ) {
        return scenes[0] || '';
      }


      if (
        /^s2\b/.test(label) ||
        /scene 2/.test(label)
      ) {
        return scenes[1] || '';
      }


      if (
        /^s3\b/.test(label) ||
        /scene 3/.test(label)
      ) {
        return scenes[2] || '';
      }


      if (
        /^s4\b/.test(label) ||
        /scene 4/.test(label)
      ) {
        return scenes[3] || '';
      }


      return null;

    }
  );
}


function gradioPathToUrl(
  value
) {

  if (
    typeof value !==
    'string'
  ) {
    return null;
  }


  const text =
    value.trim();


  if (!text) {
    return null;
  }


  if (
    /^https?:\/\//i.test(
      text
    )
  ) {
    return text;
  }


  if (
    /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(
      text
    )
  ) {

    return (
      `${HF_SPACE_URL}/gradio_api/file=` +
      encodeURIComponent(
        text
      )
    );

  }


 
