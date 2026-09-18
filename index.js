import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;

const publicDir = path.join(root, "public");
const uploadsDir = path.join(root, "uploads");
const rendersDir = path.join(root, "renders");
const jobsDir = path.join(rendersDir, "jobs");

for (const dir of [uploadsDir, rendersDir, jobsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const app = express();
const PORT = Number(process.env.PORT || 10000);
const runwayKey = process.env.RUNWAYML_API_SECRET || "";
const jobs = new Map();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safe = String(file.originalname || "upload")
      .replace(/[^a-zA-Z0-9._-]/g, "_");

    cb(
      null,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`
    );
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 3
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir));
app.use("/renders", express.static(rendersDir));

function errorText(error) {
  return error?.message || String(error);
}

function jobFile(id) {
  return path.join(jobsDir, `${id}.json`);
}

function saveJob(id) {
  const job = jobs.get(id);
  if (!job) return;

  const tmp = `${jobFile(id)}.tmp`;

  fs.writeFileSync(
    tmp,
    JSON.stringify(job, null, 2)
  );

  fs.renameSync(tmp, jobFile(id));
}

function setJob(id, patch) {
  jobs.set(id, {
    ...(jobs.get(id) || {}),
    ...patch,
    updatedAt: Date.now()
  });

  saveJob(id);
}

function loadJobs() {
  for (const name of fs.readdirSync(jobsDir)) {
    if (!name.endsWith(".json")) continue;

    try {
      const id = name.slice(0, -5);

      const job = JSON.parse(
        fs.readFileSync(
          path.join(jobsDir, name),
          "utf8"
        )
      );

      jobs.set(id, job);
    } catch (e) {
      console.error("JOB LOAD ERROR:", name, e);
    }
  }
}

function splitScenes(script) {
  const clean = String(script)
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return [];

  const pieces = clean
    .split(/(?<=[.!?।])\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  const scenes = [];

  for (const piece of pieces) {
    if (piece.length <= 430) {
      scenes.push(piece);
    } else {
      for (let i = 0; i < piece.length; i += 400) {
        const part = piece.slice(i, i + 400).trim();

        if (part) {
          scenes.push(part);
        }
      }
    }
  }

  return scenes.slice(0, 8);
}

function publicError(res, status, message) {
  if (!res.headersSent) {
    res.status(status).json({
      error: message
    });
  }
}

async function runwayCreate(prompt, ratio) {
  const response = await fetch(
    "https://api.dev.runwayml.com/v1/image_to_video",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${runwayKey}`,
        "X-Runway-Version": "2024-11-06"
      },
      body: JSON.stringify({
        model: "gen4.5",
        promptText: prompt,
        ratio,
        duration: 5
      })
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Runway ने JSON response नहीं दिया (HTTP ${response.status}).`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Runway API ${response.status}: ${
        data?.error ||
        data?.message ||
        text.slice(0, 500)
      }`
    );
  }

  if (!data?.id) {
    throw new Error("Runway ने task ID नहीं दिया।");
  }

  return data.id;
}

async function runwayStatus(taskId) {
  const response = await fetch(
    `https://api.dev.runwayml.com/v1/tasks/${encodeURIComponent(taskId)}`,
    {
      headers: {
        "Authorization": `Bearer ${runwayKey}`,
        "X-Runway-Version": "2024-11-06"
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Runway status ने JSON response नहीं दिया (HTTP ${response.status}).`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Runway status ${response.status}: ${
        data?.error ||
        data?.message ||
        text.slice(0, 500)
      }`
    );
  }

  return data;
}

async function waitForTask(
  id,
  taskId,
  sceneIndex,
  sceneCount
) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const task = await runwayStatus(taskId);

    if (task.status === "SUCCEEDED") {
      return task;
    }

    if (
      ["FAILED", "CANCELED"].includes(task.status)
    ) {
      throw new Error(
        `Runway task ${task.status}: ${
          task.failure ||
          task.error ||
          "generation failed"
        }`
      );
    }

    setJob(id, {
      status: "generating",
      progress: Math.min(
        74,
        5 +
          Math.round(
            ((sceneIndex + attempt / 24) /
              sceneCount) *
              70
          )
      ),
      message:
        `AI scene ${sceneIndex} तैयार हो रहा है…`,
      currentTaskId: taskId
    });

    await new Promise(r => setTimeout(r, 5000));
  }

  throw new Error(
    `Runway scene ${sceneIndex} timeout हो गया।`
  );
}

async function generateScenes(id) {
  const job = jobs.get(id);

  if (!job) return;

  try {
    const {
      scenes,
      format,
      style
    } = job;

    const ratio =
      format === "16:9"
        ? "1280:720"
        : "720:1280";

    const urls = Array.isArray(job.scenes)
      ? [...job.scenes]
      : [];

    for (
      let i = urls.length;
      i < scenes.length;
      i++
    ) {
      const prompt = (
        `Cinematic Hindi mystery documentary scene. Style: ${style}. ` +
        `No text, subtitles or logos. Realistic cinematic lighting, detailed environment, dramatic camera movement. ` +
        `Visualize: ${scenes[i]}`
      ).slice(0, 900);

      setJob(id, {
        status: "generating",
        progress: Math.max(
          2,
          Math.round((i / scenes.length) * 75)
        ),
        sceneIndex: i + 1,
        sceneCount: scenes.length,
        message:
          `AI scene ${i + 1} of ${scenes.length} शुरू हो रहा है…`,
        error: null
      });

      let taskId = null;

      const currentJob = jobs.get(id);

      if (
        currentJob?.currentTaskId &&
        i === Number(currentJob.currentSceneIndex)
      ) {
        taskId = currentJob.currentTaskId;
      }

      if (!taskId) {
        taskId = await runwayCreate(
          prompt,
          ratio
        );

        setJob(id, {
          currentTaskId: taskId,
          currentSceneIndex: i
        });
      }

      const task = await waitForTask(
        id,
        taskId,
        i + 1,
        scenes.length
      );

      const url = Array.isArray(task.output)
        ? task.output[0]
        : task.output;

      if (
        typeof url !== "string" ||
        !url
      ) {
        throw new Error(
          `Runway ने scene ${i + 1} के लिए video URL नहीं दिया।`
        );
      }

      urls.push(url);

      setJob(id, {
        status: "generating",
        progress: Math.min(
          75,
          Math.round(
            ((i + 1) / scenes.length) * 75
          )
        ),
        sceneIndex: i + 1,
        scenes: [...urls],
        currentTaskId: null,
        currentSceneIndex: null,
        message:
          `Scene ${i + 1} तैयार है।`
      });
    }

    if (!urls.length) {
      throw new Error(
        "AI ने कोई scene video तैयार नहीं किया।"
      );
    }

    setJob(id, {
      status: "ready",
      progress: 75,
      scenes: [...urls],
      currentTaskId: null,
      currentSceneIndex: null,
      message:
        "AI scenes तैयार हैं। Final MP4 बनाया जा सकता है।"
    });
  } catch (error) {
    console.error(
      "GENERATION ERROR:",
      error
    );

    setJob(id, {
      status: "error",
      progress: 0,
      error: errorText(error),
      currentTaskId: null
    });
  }
}

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    runwayConfigured: Boolean(runwayKey),
    ffmpegConfigured: Boolean(ffmpegPath)
  });
});

app.post(
  "/api/generate",
  upload.fields([
    {
      name: "voice",
      maxCount: 1
    },
    {
      name: "music",
      maxCount: 1
    }
  ]),
  async (req, res) => {
    try {
      if (!runwayKey) {
        return publicError(
          res,
          500,
          "RUNWAYML_API_SECRET is not configured on the server."
        );
      }

      const script = String(
        req.body.script || ""
      ).trim();

      const format = String(
        req.body.format || "9:16"
      );

      const style = String(
        req.body.style || "Mystery"
      );

      if (!script) {
        return publicError(
          res,
          400,
          "Script is required."
        );
      }

      const scenes = splitScenes(script);

      if (!scenes.length) {
        return publicError(
          res,
          400,
          "Script could not be split into scenes."
        );
      }

      const id =
        `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

      const voice =
        req.files?.voice?.[0]?.path || null;

      const music =
        req.files?.music?.[0]?.path || null;

      setJob(id, {
        id,
        status: "generating",
        progress: 1,
        sceneIndex: 0,
        sceneCount: scenes.length,
        scenes: [],
        error: null,
        script,
        format,
        style,
        voice,
        music,
        currentTaskId: null,
        currentSceneIndex: null
      });

      res.status(202).json({
        jobId: id,
        sceneCount: scenes.length
      });

      void generateScenes(id);
    } catch (error) {
      console.error(
        "REQUEST ERROR:",
        error
      );

      publicError(
        res,
        500,
        errorText(error)
      );
    }
  }
);

app.get(
  "/api/job/:id",
  (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job) {
      return res.status(404).json({
        status: "not_found",
        error:
          "Job नहीं मिला। यह पुराना job हो सकता है। नया Generate करें।"
      });
    }

    res.json(job);
  }
);

async function downloadFile(
  url,
  outPath
) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Generated scene download failed (HTTP ${response.status}).`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (!buffer.length) {
    throw new Error(
      "Generated scene खाली है।"
    );
  }

  fs.writeFileSync(
    outPath,
    buffer
  );
}

function ffmpegRun(command) {
  return new Promise(
    (resolve, reject) => {
      command
        .on("end", resolve)
        .on("error", reject)
        .run();
    }
  );
}

async function renderJob(jobId) {
  const job = jobs.get(jobId);

  if (!job) {
    throw new Error(
      "Job नहीं मिला।"
    );
  }

  if (job.status !== "ready") {
    throw new Error(
      `AI scenes अभी ready नहीं हैं। Current status: ${job.status}`
    );
  }

  if (!ffmpegPath) {
    throw new Error(
      "FFmpeg उपलब्ध नहीं है।"
    );
  }

  /*
   * सबसे महत्वपूर्ण FIX:
   * पुराने/stale job में scenes [] हो सकते हैं।
   * ऐसे job को FFmpeg तक जाने नहीं देंगे।
   */
  if (
    !Array.isArray(job.scenes) ||
    job.scenes.length === 0
  ) {
    throw new Error(
      "इस job में कोई AI scene video नहीं है। कृपया नया Generate करें।"
    );
  }

  setJob(jobId, {
    status: "rendering",
    progress: 80,
    message:
      "Scenes download हो रहे हैं…"
  });

  const sceneFiles = [];

  for (
    let i = 0;
    i < job.scenes.length;
    i++
  ) {
    const sceneUrl = job.scenes[i];

    if (
      typeof sceneUrl !== "string" ||
      !sceneUrl
    ) {
      throw new Error(
        `Scene ${i + 1} का video URL खाली है।`
      );
    }

    const p = path.join(
      rendersDir,
      `${jobId}_${i}.mp4`
    );

    if (!fs.existsSync(p)) {
      await downloadFile(
        sceneUrl,
        p
      );
    }

    if (!fs.existsSync(p)) {
      throw new Error(
        `Scene ${i + 1} download नहीं हुई।`
      );
    }

    const stat = fs.statSync(p);

    if (stat.size === 0) {
      throw new Error(
        `Scene ${i + 1} की video file खाली है।`
      );
    }

    sceneFiles.push(p);

    setJob(jobId, {
      progress:
        80 +
        Math.round(
          ((i + 1) /
            job.scenes.length) *
            8
        ),
      message:
        `Scene ${i + 1} download हो गई।`
    });
  }

  /*
   * दूसरा महत्वपूर्ण FIX:
   * FFmpeg को कभी भी n=0 नहीं दिया जाएगा।
   */

  if (sceneFiles.length === 0) {
    throw new Error(
      "कोई scene file उपलब्ध नहीं है।"
    );
  }

  const joined = path.join(
    rendersDir,
    `${jobId}_joined.mp4`
  );

  if (!fs.existsSync(joined)) {

    /*
     * केवल 1 scene है तो concat filter की जरूरत नहीं।
     */
    if (sceneFiles.length === 1) {

      await ffmpegRun(
        ffmpeg(sceneFiles[0])
          .outputOptions([
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart"
          ])
          .output(joined)
      );

    } else {

      /*
       * 2 या उससे अधिक scenes:
       * अब n हमेशा 2,3,4... होगा।
       */
      const joinCommand = ffmpeg();

      for (const sceneFile of sceneFiles) {
        joinCommand.input(sceneFile);
      }

      const inputs = sceneFiles
        .map(
          (_, i) =>
            `[${i}:v:0]`
        )
        .join("");

      const filter =
        `${inputs}concat=n=${sceneFiles.length}:v=1:a=0[v]`;

      await ffmpegRun(
        joinCommand
          .complexFilter(filter)
          .outputOptions([
            "-map",
            "[v]",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart"
          ])
          .output(joined)
      );
    }
  }

  if (!fs.existsSync(joined)) {
    throw new Error(
      "Scenes जोड़ने के बाद joined video नहीं बनी।"
    );
  }

  const voice =
    job.voice &&
    fs.existsSync(job.voice)
      ? job.voice
      : null;

  const music =
    job.music &&
    fs.existsSync(job.music)
      ? job.music
      : null;

  const final = path.join(
    rendersDir,
    `${jobId}_final.mp4`
  );

  if (voice || music) {
    const cmd = ffmpeg(joined);

    const maps = [
      "-map",
      "0:v:0"
    ];

    const filters = [];

    if (voice && music) {
      cmd
        .input(voice)
        .input(music);

      filters.push(
        "[1:a]volume=1[a1]",
        "[2:a]volume=0.18[a2]",
        "[a1][a2]amix=inputs=2:duration=first[aout]"
      );

      maps.push(
        "-map",
        "[aout]"
      );

    } else if (voice) {

      cmd.input(voice);

      maps.push(
        "-map",
        "1:a:0"
      );

    } else {

      cmd.input(music);

      maps.push(
        "-map",
        "1:a:0"
      );
    }

    const outputOptions = [
      ...maps,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-shortest"
    ];

    if (filters.length) {
      outputOptions.push(
        "-filter_complex",
        filters.join(";")
      );
    }

    await ffmpegRun(
      cmd
        .outputOptions(
          outputOptions
        )
        .output(final)
    );

  } else if (!fs.existsSync(final)) {

    fs.copyFileSync(
      joined,
      final
    );
  }

  if (!fs.existsSync(final)) {
    throw new Error(
      "Final video नहीं बनी।"
    );
  }

  const videoUrl =
    `/renders/${path.basename(final)}`;

  setJob(jobId, {
    status: "done",
    progress: 100,
    video: videoUrl,
    message:
      "वीडियो तैयार है!"
  });

  return videoUrl;
}

app.post(
  "/api/render",
  upload.fields([
    {
      name: "voice",
      maxCount: 1
    },
    {
      name: "music",
      maxCount: 1
    }
  ]),
  async (req, res) => {

    const jobId = String(
      req.body.jobId || ""
    );

    const job = jobs.get(jobId);

    if (!job) {
      return publicError(
        res,
        404,
        "Job नहीं मिला। नया Generate करें।"
      );
    }

    try {

      if (
        req.files?.voice?.[0]?.path ||
        req.files?.music?.[0]?.path
      ) {
        setJob(jobId, {
          voice:
            req.files?.voice?.[0]?.path ||
            job.voice ||
            null,

          music:
            req.files?.music?.[0]?.path ||
            job.music ||
            null
        });
      }

      const fresh = jobs.get(jobId);

      /*
       * Render तभी होगा जब scenes मौजूद हों।
       */
      if (
        fresh.status !== "ready" &&
        !(fresh.status === "done" && fresh.video)
      ) {
        return publicError(
          res,
          400,
          `AI scenes अभी तैयार नहीं हैं। Status: ${fresh.status}`
        );
      }

      if (
        fresh.status === "ready" &&
        (!Array.isArray(fresh.scenes) ||
          fresh.scenes.length === 0)
      ) {
        return publicError(
          res,
          400,
          "AI scenes नहीं मिलीं। नया Generate करें।"
        );
      }

      const video =
        fresh.status === "done" &&
        fresh.video
          ? fresh.video
          : await renderJob(jobId);

      res.json({
        video
      });

    } catch (error) {

      console.error(
        "RENDER ERROR:",
        error
      );

      setJob(jobId, {
        status: "error",
        progress: 0,
        error: errorText(error)
      });

      publicError(
        res,
        500,
        errorText(error)
      );
    }
  }
);

app.get(
  "/{*splat}",
  (_req, res) => {

    const index = path.join(
      publicDir,
      "index.html"
    );

    if (!fs.existsSync(index)) {
      return res
        .status(500)
        .send(
          "public/index.html not found on server"
        );
    }

    res.sendFile(index);
  }
);

loadJobs();

for (const [id, job] of jobs) {

  if (
    job.status === "generating" &&
    job.currentTaskId
  ) {
    console.log(
      `Resuming saved Runway job ${id}`
    );

    void generateScenes(id);
  }
}

app.listen(
  PORT,
  "0.0.0.0",
  () =>
    console.log(
      `Raz Ki Duniya running on port ${PORT}`
    )
);

process.on(
  "unhandledRejection",
  error =>
    console.error(
      "UNHANDLED REJECTION:",
      error
    )
);

process.on(
  "uncaughtException",
  error =>
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    )
);
