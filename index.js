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

for (const dir of [uploadsDir, rendersDir]) fs.mkdirSync(dir, { recursive: true });
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = Number(process.env.PORT || 10000);
const runwayKey = process.env.RUNWAYML_API_SECRET || "";
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
  limits: { fileSize: 50 * 1024 * 1024, files: 3 }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir));
app.use("/renders", express.static(rendersDir));

function splitScenes(script) {
  const clean = script.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const pieces = clean.split(/(?<=[.!?।])\s+/).map(s => s.trim()).filter(Boolean);
  const scenes = [];
  for (const piece of pieces) {
    if (piece.length <= 500) scenes.push(piece);
    else {
      for (let i = 0; i < piece.length; i += 450) scenes.push(piece.slice(i, i + 450).trim());
    }
  }
  return scenes.slice(0, 8);
}

function setJob(id, patch) {
  jobs.set(id, { ...(jobs.get(id) || {}), ...patch });
}

function errorText(error) {
  return error?.message || String(error);
}

app.get("/api/status", (_req, res) => {
  res.json({ ok: true, runwayConfigured: Boolean(runwayKey), ffmpegConfigured: Boolean(ffmpegPath) });
});

app.post(
  "/api/generate",
  upload.fields([{ name: "voice", maxCount: 1 }, { name: "music", maxCount: 1 }]),
  async (req, res) => {
    try {
      if (!runwayKey) return res.status(500).json({ error: "RUNWAYML_API_SECRET is not configured on the server." });
      const script = String(req.body.script || "").trim();
      const format = String(req.body.format || "9:16");
      const style = String(req.body.style || "Mystery");
      if (!script) return res.status(400).json({ error: "Script is required." });

      const scenes = splitScenes(script);
      if (!scenes.length) return res.status(400).json({ error: "Script could not be split into scenes." });

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setJob(id, { status: "generating", progress: 1, sceneIndex: 0, sceneCount: scenes.length, scenes: [], error: null });
      res.status(202).json({ jobId: id, sceneCount: scenes.length });

      void generateScenes(id, scenes, format, style);
    } catch (error) {
      console.error("REQUEST ERROR:", error);
      if (!res.headersSent) res.status(500).json({ error: errorText(error) });
    }
  }
);

async function generateScenes(id, scenes, format, style) {
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

      const prompt = (
        `Cinematic Hindi mystery documentary scene. Style: ${style}. ` +
        `No text, subtitles or logos. Realistic cinematic lighting, detailed environment, dramatic camera movement. ` +
        `Visualize: ${scenes[i].slice(0, 430)}`
      ).slice(0, 900);

      const createResponse = await fetch("https://api.dev.runwayml.com/v1/image_to_video", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${runwayKey}`,
          "X-Runway-Version": "2024-11-06"
        },
        body: JSON.stringify({ model: "gen4.5", promptText: prompt, ratio, duration: 5 })
      });

      const createText = await createResponse.text();
      let createData;
      try { createData = JSON.parse(createText); }
      catch { throw new Error(`Runway ने JSON response नहीं दिया (HTTP ${createResponse.status}).`); }
      if (!createResponse.ok) {
        throw new Error(`Runway API ${createResponse.status}: ${createData?.error || createData?.message || createText.slice(0, 500)}`);
      }

      const taskId = createData?.id;
      if (!taskId) throw new Error("Runway ने task ID नहीं दिया।");

      let task = null;
      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise(r => setTimeout(r, 5000));
        const statusResponse = await fetch(`https://api.dev.runwayml.com/v1/tasks/${encodeURIComponent(taskId)}`, {
          headers: { "Authorization": `Bearer ${runwayKey}`, "X-Runway-Version": "2024-11-06" }
        });
        const statusText = await statusResponse.text();
        let statusData;
        try { statusData = JSON.parse(statusText); }
        catch { throw new Error(`Runway status ने JSON response नहीं दिया (HTTP ${statusResponse.status}).`); }
        if (!statusResponse.ok) {
          throw new Error(`Runway status ${statusResponse.status}: ${statusData?.error || statusData?.message || statusText.slice(0, 500)}`);
        }
        task = statusData;
        if (task.status === "SUCCEEDED") break;
        if (["FAILED", "CANCELED"].includes(task.status)) {
          throw new Error(`Runway task ${task.status}: ${task.failure || task.error || "generation failed"}`);
        }
        setJob(id, {
          status: "generating",
          progress: Math.min(74, 5 + Math.round(((i + attempt / 24) / scenes.length) * 70)),
          sceneIndex: i + 1,
          message: `AI scene ${i + 1} तैयार हो रहा है…`
        });
      }

      if (!task || task.status !== "SUCCEEDED") throw new Error(`Runway scene ${i + 1} timeout हो गया।`);
      const url = Array.isArray(task.output) ? task.output[0] : null;
      if (typeof url !== "string" || !url) throw new Error(`Runway ने scene ${i + 1} के लिए video URL नहीं दिया।`);

      urls.push(url);
      setJob(id, {
        status: "generating",
        progress: Math.min(75, Math.round(((i + 1) / scenes.length) * 75)),
        sceneIndex: i + 1,
        scenes: [...urls],
        message: `Scene ${i + 1} तैयार है।`
      });
    }

    setJob(id, { status: "ready", progress: 75, sceneIndex: scenes.length, sceneCount: scenes.length, scenes: urls, message: "AI scenes तैयार हैं। Final MP4 बनाया जा रहा है…" });
  } catch (error) {
    console.error("GENERATION ERROR:", error);
    setJob(id, { status: "error", progress: 0, error: errorText(error) });
  }
}

app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ status: "not_found", error: "Job नहीं मिला या server restart हो चुका है।" });
  res.json(job);
});

async function downloadFile(url, outPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Generated scene download failed (HTTP ${response.status}).`);
  fs.writeFileSync(outPath, Buffer.from(await response.arrayBuffer()));
}

function ffmpegRun(command) {
  return new Promise((resolve, reject) => command.on("end", resolve).on("error", reject).run());
}

app.post(
  "/api/render",
  upload.fields([{ name: "voice", maxCount: 1 }, { name: "music", maxCount: 1 }]),
  async (req, res) => {
    const jobId = String(req.body.jobId || "");
    const job = jobs.get(jobId);
    if (!job || job.status !== "ready") return res.status(400).json({ error: "AI scenes are not ready yet." });

    try {
      if (!ffmpegPath) throw new Error("FFmpeg उपलब्ध नहीं है।");
      setJob(jobId, { status: "rendering", progress: 80, message: "Scenes download हो रहे हैं…" });

      const sceneFiles = [];
      for (let i = 0; i < job.scenes.length; i++) {
        const p = path.join(rendersDir, `${jobId}_${i}.mp4`);
        await downloadFile(job.scenes[i], p);
        sceneFiles.push(p);
        setJob(jobId, { progress: 80 + Math.round(((i + 1) / job.scenes.length) * 8), message: `Scene ${i + 1} जोड़ रहा हूँ…` });
      }

      const listFile = path.join(rendersDir, `${jobId}.txt`);
      fs.writeFileSync(listFile, sceneFiles.map(f => `file '${f.replaceAll("'", "'\\''")}'`).join("\n"));
      const joined = path.join(rendersDir, `${jobId}_joined.mp4`);
      await ffmpegRun(ffmpeg().input(listFile).inputOptions(["-f", "concat", "-safe", "0"]).outputOptions(["-c", "copy"]).output(joined));

      const voice = req.files?.voice?.[0]?.path;
      const music = req.files?.music?.[0]?.path;
      const final = path.join(rendersDir, `${jobId}_final.mp4`);

      if (voice || music) {
        const cmd = ffmpeg(joined);
        const maps = ["-map", "0:v:0"];
        const filters = [];
        if (voice && music) {
          cmd.input(voice).input(music);
          filters.push("[1:a]volume=1[a1]", "[2:a]volume=0.18[a2]", "[a1][a2]amix=inputs=2:duration=first[aout]");
          maps.push("-map", "[aout]");
        } else if (voice) {
          cmd.input(voice);
          maps.push("-map", "1:a:0");
        } else {
          cmd.input(music);
          maps.push("-map", "1:a:0");
        }
        await ffmpegRun(cmd.outputOptions([...maps, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", ...(filters.length ? ["-filter_complex", filters.join(";")] : [])]).output(final));
      } else {
        fs.copyFileSync(joined, final);
      }

      const videoUrl = `/renders/${path.basename(final)}`;
      setJob(jobId, { status: "done", progress: 100, video: videoUrl, message: "वीडियो तैयार है!" });
      res.json({ video: videoUrl });
    } catch (error) {
      console.error("RENDER ERROR:", error);
      setJob(jobId, { status: "error", progress: 0, error: errorText(error) });
      res.status(500).json({ error: errorText(error) });
    }
  }
);

app.get("/{*splat}", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

process.on("unhandledRejection", error => console.error("UNHANDLED REJECTION:", error));
process.on("uncaughtException", error => console.error("UNCAUGHT EXCEPTION:", error));

app.listen(PORT, () => console.log(`Raz Ki Duniya running on port ${PORT}`));
