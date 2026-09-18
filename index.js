import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import RunwayML, { TaskFailedError } from '@runwayml/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const publicDir = path.join(root, 'public');
const uploadDir = path.join(root, 'uploads');
const renderDir = path.join(root, 'renders');

for (const dir of [uploadDir, renderDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/renders', express.static(renderDir));
app.use(express.static(publicDir));

const upload = multer({ dest: uploadDir });

const runway = new RunwayML({
  apiKey: process.env.RUNWAYML_API_SECRET
});

const jobs = new Map();

function makeId() {
  return Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8);
}

function getRatio(format) {
  return String(format || '').includes('16:9')
    ? '1280:768'
    : '768:1280';
}

function makePrompt(script, style) {
  const text = String(script || '')
    .replace(/\s+/g, ' ')
    .trim();

  const prompt =
    `${style || 'Mystery'} cinematic documentary scene, ` +
    `realistic atmosphere, dramatic lighting. ${text}`;

  return prompt.slice(0, 950);
}

function imageDataUri(file) {
  const ext = path.extname(
    file.originalname || ''
  ).toLowerCase();

  let mime = 'image/jpeg';

  if (ext === '.png') mime = 'image/png';
  if (ext === '.webp') mime = 'image/webp';

  const base64 = fs
    .readFileSync(file.path)
    .toString('base64');

  return `data:${mime};base64,${base64}`;
}

function isMedia(file) {
  return !!file &&
    /^(audio|video)\//.test(file.mimetype || '');
}

function absoluteRenderUrl(req, name) {
  return `${req.protocol}://${req.get('host')}/renders/${encodeURIComponent(name)}`;
}

async function generateVideo(job) {
  try {
    job.status = 'generating';
    job.progress = 5;

    const input = {
      model: 'gen4.5',
      promptText: makePrompt(
        job.script,
        job.style
      ),
      ratio: getRatio(job.format),
      duration: 5
    };

    if (job.characterImage) {
      input.promptImage =
        imageDataUri(job.characterImage);
    }

    const task =
      await runway.imageToVideo.create(input);

    job.taskId = task.id;
    job.status = 'waiting';
    job.progress = 10;

    let result = null;

    for (let i = 0; i < 90; i++) {
      await new Promise(resolve =>
        setTimeout(resolve, 4000)
      );

      const current =
        await runway.tasks.retrieve(job.taskId);

      if (current.status === 'SUCCEEDED') {
        result = current;
        break;
      }

      if (current.status === 'FAILED') {
        throw new Error(
          current.failure ||
          'Runway video generation failed.'
        );
      }

      job.progress =
        Math.min(
          95,
          10 + Math.round((i + 1) * 85 / 90)
        );
    }

    if (!result || !result.output?.[
