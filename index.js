import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import RunwayML from "@runwayml/sdk";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const publicDir = path.join(root, "public");
const uploadsDir = path.join(root, "uploads");
const rendersDir = path.join(root, "renders");

for (const dir of [uploadsDir, rendersDir]) fs.mkdirSync(dir, { recursive: true });

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = Number(process.env.PORT || 10000);
const client = process.env.RUNWAYML_API_SECRET
  ? new RunwayML({ apiKey: process.env.RUNWAYML_API_SECRET })
  : null;

const jobs = new Map();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
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

function splitScenes(script) {
  return script
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?।])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function setJob(id, patch) {
  const old = jobs.get(id) || {};
  jobs.set(id, { ...old, ...patch });
}

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    runwayConfigured: Boolean(client),
    ffmpegConfigured: Boolean(ffmpegPath)
  });
});

app.post(
  "/api/generate",
  upload.fields([
    { name: "voice", maxCount: 1 },
    { name: "music", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      if (!client) {
        return res.status(500).json({
          error: "RUNWAYML_API_SECRET is not configured on the server."
        });
      }

      const script = String(req.body.script || "").trim();
      const format = String(req.body.format || "9:16");
      const style = String(req.body.style || "Mystery");

      if (!script) return res.status(400).json({ error: "Script is required." });

      const scenes = splitScenes(script);
      if (!scenes.length) return res.status(400).json({ error: "Script could not be split into scenes." });

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setJob(id, {
        status: "generating",
        progress: 1,
        sceneIndex: 0,
        sceneCount: scenes.length,
        scenes: [],
        error: null
      });

      // Respond immediately. The browser then polls /api/job/:id.
      res.status(202).json({ jobId: id, sceneCount: scenes.length });

      (async () => {
        try {
          const ratio = format === "16:9" ? "1280:720" : "720:1280";
          const urls = [];

          for (let i = 0; i < scenes.length; i++) {
            setJob(id, {
              status: "generating",
              progress: Math.max(2, Math.round((i / scenes.length) * 75)),
              sceneIndex: i + 1,
              message: `AI scene ${i + 1} of ${scenes.length} बन रहा है…`
            });

            const prompt =
              `Cinematic Hindi mystery documentary scene. ` +
              `Style: ${style}. No text, no subtitles, no logos. ` +
              `Realistic cinematic lighting, detailed environment, dramatic camera movement. ` +
              `Visualize this narration: ${scenes[i].slice(0, 700)}`;

            const task = await client.imageToVideo
              .create({
                model: "gen4.5",
                promptText: prompt,
                ratio,
                duration: 5
              })
              .waitForTaskOutput();

            const url = task.output?.[0];
            if (!url) throw new Error(`Runway returned no video URL for scene ${i + 1}.`);

            urls.push(url);

            setJob(id, {
              status: "generating",
              progress: Math.min(75, Math.round(((i + 1) / scenes.length) * 75)),
              sceneIndex: i + 1,
              scenes: [...urls],
              message: `Scene ${i + 1} तैयार है।`
            });
          }

          setJob(id, {
            status: "ready",
            progress: 75,
            sceneIndex: scenes.length,
            sceneCount: scenes.length,
            scenes: urls,
            message: "AI scenes तैयार हैं। अब final MP4 बनाया जा सकता है।"
          });
        } catch (error) {
          console.error("GENERATION ERROR:", error);
          setJob(id, {
            status: "error",
            progress: 0,
            error: error?.message || String(error)
          });
        }
      })();
    } catch (error) {
      console.error("REQUEST ERROR:", error);
      res.status(500).json({ error: error?.message || String(error) });
    }
  }
);

app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ status: "not_found" });
  res.json(job);
});

async function downloadFile(url, outPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download generated scene (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
}

function ffmpegRun(command) {
  return new Promise((resolve, reject) => {
    command.on("end", resolve).on("error", reject).run();
  });
}

app.post(
  "/api/render",
  upload.fields([
    { name: "voice", maxCount: 1 },
    { name: "music", maxCount: 1 }
  ]),
  async (req, res) => {
    const jobId = String(req.body.jobId || "");
    const job = jobs.get(jobId);

    if (!job || job.status !== "ready") {
      return res.status(400).json({ error: "AI scenes are not ready yet." });
    }

    try {
      setJob(jobId, { status: "rendering", progress: 80, message: "Scenes download हो रहे हैं…" });

      const sceneFiles = [];
      for (let i = 0; i < job.scenes.length; i++) {
        const p = path.join(rendersDir, `${jobId}_${i}.mp4`);
        await downloadFile(job.scenes[i], p);
        sceneFiles.push(p);
        setJob(jobId, {
          status: "rendering",
          progress: 80 + Math.round(((i + 1) / job.scenes.length) * 8),
          message: `Scene ${i + 1} जोड़ रहा हूँ…`
        });
      }

      const listFile = path.join(rendersDir, `${jobId}.txt`);
      fs.writeFileSync(
        listFile,
        sceneFiles.map(f => `file '${f.replaceAll("'", "'\\''")}'`).join("\n")
      );

      const joined = path.join(rendersDir, `${jobId}_joined.mp4`);
      await ffmpegRun(
        ffmpeg()
          .input(listFile)
          .inputOptions(["-f", "concat", "-safe", "0"])
          .outputOptions(["-c", "copy"])
          .output(joined)
      );

      const voice = req.files?.voice?.[0]?.path;
      const music = req.files?.music?.[0]?.path;
      const final = path.join(rendersDir, `${jobId}_final.mp4`);

      if (voice || music) {
        const cmd = ffmpeg(joined);
        const maps = ["-map 0:v:0"];
        const filters = [];

        if (voice && music) {
          cmd.input(voice).input(music);
          filters.push(
            "[1:a]volume=1[a1]",
            "[2:a]volume=0.18[a2]",
            "[a1][a2]amix=inputs=2:duration=first[aout]"
          );
          maps.push("-map", "[aout]");
        } else if (voice) {
          cmd.input(voice);
          maps.push("-map", "1:a:0");
        } else {
          cmd.input(music);
          maps.push("-map", "1:a:0");
        }

        await ffmpegRun(
          cmd.outputOptions([
            ...maps,
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-c:a", "aac",
            "-shortest",
            ...(filters.length ? ["-filter_complex", filters.join(";")] : [])
          ]).output(final)
        );
      } else {
        fs.copyFileSync(joined, final);
      }

      const videoUrl = `/renders/${path.basename(final)}`;
      setJob(jobId, {
        status: "done",
        progress: 100,
        video: videoUrl,
        message: "वीडियो तैयार है!"
      });

      res.json({ video: videoUrl });
    } catch (error) {
      console.error("RENDER ERROR:", error);
      setJob(jobId, {
        status: "error",
        progress: 0,
        error: error?.message || String(error)
      });
      res.status(500).json({ error: error?.message || String(error) });
    }
  }
);

app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Raz Ki Duniya running on port ${PORT}`);
});
