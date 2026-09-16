import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import RunwayML from '@runwayml/sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

const app = express();

const upload = multer({
  dest: path.join(root, 'uploads')
});

const jobs = new Map();

const runway = new RunwayML({
  apiKey: process.env.RUNWAYML_API_SECRET
});

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
  res.sendFile(
    path.join(root, 'index.html')
  );
});


/* =================================
   IMAGE → DATA URI
================================= */

function imageToDataUri(file) {

  if (!file || !file.path) {
    return null;
  }

  const buffer = fs.readFileSync(
    file.path
  );

  const ext =
    path.extname(file.originalname || '')
      .toLowerCase();

  let mime = 'image/jpeg';

  if (ext === '.png') {
    mime = 'image/png';
  } else if (ext === '.webp') {
    mime = 'image/webp';
  } else if (ext === '.gif') {
    mime = 'image/gif';
  }

  return (
    `data:${mime};base64,` +
    buffer.toString('base64')
  );
}


/* =================================
   PROMPT
================================= */

function buildPrompt(script, style) {

  return [
    `Create a cinematic ${style || 'Mystery'} video.`,
    'Realistic visual storytelling.',
    'Natural character movement.',
    'Detailed environment.',
    'Cinematic lighting.',
    'Smooth camera movement.',
    'Keep the main subject visually consistent.',
    'No subtitles.',
    'No text overlays.',
    'No logos.',
    '',
    'Story:',
    script
  ].join('\n');
}


/* =================================
   RUNWAY GENERATION
================================= */

async function generateRunwayVideo({
  script,
  format,
  style,
  characterImage
}) {

  if (
    !process.env.RUNWAYML_API_SECRET
  ) {
    throw new Error(
      'RUNWAYML_API_SECRET Render Environment में नहीं मिला।'
    );
  }

  const ratio =
    format === '16:9'
      ? '1280:720'
      : '720:1280';

  const promptText =
    buildPrompt(
      script,
      style
    );

  console.log(
    'RUNWAY REQUEST:',
    JSON.stringify({
      model: 'gen4.5',
      ratio,
      duration: 5,
      hasCharacterImage:
        !!characterImage
    })
  );

  const options = {
    model: 'gen4.5',
    promptText,
    ratio,
    duration: 5
  };

  if (characterImage) {

    const dataUri =
      imageToDataUri(
        characterImage
      );

    if (dataUri) {

      options.promptImage =
        dataUri;

      console.log(
        'RUNWAY CHARACTER IMAGE: attached'
      );
    }
  }

  console.log(
    'RUNWAY: creating task...'
  );

  const task =
    await runway.imageToVideo
      .create(options);

  console.log(
    'RUNWAY TASK ID:',
    task?.id
  );

  if (!task?.waitForTaskOutput) {
    throw new Error(
      'Runway task response में waitForTaskOutput नहीं मिला।'
    );
  }

  const result =
    await task.waitForTaskOutput({
      timeout: 10 * 60 * 1000
    });

  console.log(
    'RUNWAY RESULT:',
    JSON.stringify(
      result
    ).slice(0, 10000)
  );

  const videoUrl =
    result?.output?.[0];

  if (!videoUrl) {
    throw new Error(
      'Runway ने video URL नहीं दिया।'
    );
  }

  console.log(
    'RUNWAY VIDEO URL:',
    videoUrl
  );

  return videoUrl;
}


/* =================================
   GENERATE
================================= */

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
        error:
          'Script डालें।'
      });
    }

    const id =
      Date.now().toString();

    jobs.set(id, {
      status: 'generating',
      progress: 5,
      message:
        'Runway AI generation शुरू हो रही है…',
      scenes: []
    });

    res.json({
      jobId: id,
      sceneCount: 1
    });

    try {

      jobs.set(id, {
        status: 'generating',
        progress: 10,
        message:
          'Runway AI video बना रहा है…',
        scenes: []
      });

      const videoUrl =
        await generateRunwayVideo({
          script,
          format:
            req.body?.format || '9:16',
          style:
            req.body?.style || 'Mystery',
          characterImage:
            req.files?.characterImage?.[0] ||
            null
        });

      jobs.set(id, {
        status: 'ready',
        progress: 100,
        message:
          'AI video तैयार है।',
        scenes: [
          videoUrl
        ]
      });

      console.log(
        'JOB READY:',
        id
      );

    } catch (error) {

      console.error(
        'RUNWAY ERROR:',
        error
      );

      const message =
        error?.message ||
        String(error);

      jobs.set(id, {
        status: 'error',
        progress: 0,
        message:
          'AI generation failed.',
        scenes: [],
        error: message
      });

    }
  }
);


/* =================================
   JOB STATUS
================================= */

app.get(
  '/api/job/:id',
  (req, res) => {

    res.json(
      jobs.get(
        req.params.id
      ) || {
        status: 'not_found'
      }
    );
  }
);


/* =================================
   DOWNLOAD RUNWAY VIDEO
================================= */

async function downloadVideo(
  url,
  output
) {

  console.log(
    'DOWNLOADING RUNWAY VIDEO...'
  );

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `AI video download failed: HTTP ${response.status}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  fs.writeFileSync(
    output,
    Buffer.from(arrayBuffer)
  );

  console.log(
    'RUNWAY VIDEO SAVED:',
    output
  );
}


/* =================================
   RENDER
================================= */

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

    if (
      !job.scenes ||
      !job.scenes[0]
    ) {
      return res.status(400).json({
        error:
          'AI video URL उपलब्ध नहीं है।'
      });
    }

    const output =
      path.join(
        root,
        'renders',
        `${req.body.jobId}.mp4`
      );

    try {

      await downloadVideo(
        job.scenes[0],
        output
      );

      const voice =
        req.files?.voice?.[0]?.path;

      const music =
        req.files?.music?.[0]?.path;

      /*
       * No audio
       */
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

      /*
       * Voice + music
       */
      if (voice && music) {

        options.push(
          '-filter_complex',
          '[1:a]volume=1[a];' +
          '[2:a]volume=.18[b];' +
          '[a][b]amix=2:duration=first[aout]',
          '-map',
          '[aout]'
        );

      }

      /*
       * Voice OR music
       */
      else {

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
        '-shortest',
        '-movflags',
        '+faststart'
      );

      await new Promise(
        (resolve, reject) => {

          command
            .outputOptions(
              options
            )
            .save(finalOutput)
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
        video:
          '/renders/' +
          path.basename(
            finalOutput
          )
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


/* =================================
   START
================================= */

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

    console.log(
      'Runway API:',
      process.env.RUNWAYML_API_SECRET
        ? 'configured'
        : 'MISSING'
    );
  }
);
