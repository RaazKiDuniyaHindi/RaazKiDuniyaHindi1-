import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import RunwayML from "@runwayml/sdk";
import ffmpeg from "fluent-ffmpeg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, "uploads");
const renderDir = path.join(__dirname, "renders");
const publicDir = path.join(__dirname, "public");

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(renderDir, { recursive: true });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));

const upload = multer({ dest: uploadDir });

const client = process.env.RUNWAYML_API_SECRET
  ? new RunwayML({
      apiKey: process.env.RUNWAYML_API_SECRET
    })
  : null;

const jobs = new Map();

function splitScenes(text) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?।])\s+/)
    .filter(Boolean)
    .slice(0, 12);
}

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    runwayConfigured: !!client,
    ffmpeg: true
  });
});

app.post(
  "/api/generate",
  upload.fields([
    { name: "voice", maxCount: 1 },
    { name: "music", maxCount: 1 },
    { name: "characterImage", maxCount: 1 }
  ]),
  async (req, res) => {
    if (!client) {
      return res.status(400).json({
        error:
          "RUNWAYML_API_SECRET is not configured on Render."
      });
    }

    const script = req.body.script;
    const format = req.body.format || "9:16";
    const style = req.body.style || "Mystery";

    if (!script || !script.trim()) {
      return res.status(400).json({
        error: "Script is required."
      });
    }

    const scenes = splitScenes(script);

    const jobId = Date.now().toString();

    jobs.set(jobId, {
      status: "generating",
      progress: 0,
      scenes: []
    });

    res.json({
      jobId,
      sceneCount: scenes.length
    });

    try {
      const ratio =
        format === "16:9"
          ? "1280:720"
          : "720:1280";

      const urls = [];

      for (let i = 0; i < scenes.length; i++) {
        const prompt =
          `Cinematic Hindi mystery documentary scene. ` +
          `Style: ${style}. ` +
          `No text, no subtitles, no logos. ` +
          `Visualize this narration: ${scenes[i]}`;

        const task = await client.imageToVideo
          .create({
            model: "gen4.5",
            promptText: prompt,
            ratio,
            duration: 5
          })
          .waitForTaskOutput();

        const videoUrl = task.output?.[0];

        if (!videoUrl) {
          throw new Error("Runway returned no video URL.");
        }

        urls.push(videoUrl);

        jobs.set(jobId, {
          status: "generating",
          progress: Math.round(
            ((i + 1) / scenes.length) * 75
          ),
          scenes: urls
        });
      }

      jobs.set(jobId, {
        status: "ready",
        progress: 75,
        scenes: urls
      });
    } catch (error) {
      jobs.set(jobId, {
        status: "error",
        progress: 0,
        error: error?.message || String(error)
      });
    }
  }
);

app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.json({
      status: "not_found"
    });
  }

  res.json(job);
});

app.post(
  "/api/render",
  upload.fields([
    { name: "voice", maxCount: 1 },
    { name: "music", maxCount: 1 }
  ]),
  async (req, res) => {
    const job = jobs.get(req.body.jobId);

    if (!job || job.status !== "ready") {
      return res.status(400).json({
        error: "Generate the AI scenes first."
      });
    }

    try {
      const files = [];

      for (let i = 0; i < job.scenes.length; i++) {
        const filePath = path.join(
          renderDir,
          `${req.body.jobId}_${i}.mp4`
        );

        const response = await fetch(job.scenes[i]);

        if (!response.ok) {
          throw new Error(
            "Could not download Runway scene."
          );
        }

        const buffer = Buffer.from(
          await response.arrayBuffer()
        );

        fs.writeFileSync(filePath, buffer);
        files.push(filePath);
      }

      const listFile = path.join(
        renderDir,
        `${req.body.jobId}.txt`
      );

      fs.writeFileSync(
        listFile,
        files
          .map(
            file =>
              `file '${file.replaceAll("'", "'\\''")}'`
          )
          .join("\n")
      );

      const outputFile = path.join(
        renderDir,
        `${req.body.jobId}.mp4`
      );

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listFile)
          .inputOptions([
            "-f",
            "concat",
            "-safe",
            "0"
          ])
          .outputOptions([
            "-c",
            "copy"
          ])
          .save(outputFile)
          .on("end", resolve)
          .on("error", reject);
      });

      res.json({
        video:
          `/renders/${path.basename(outputFile)}`
      });
    } catch (error) {
      res.status(500).json({
        error: error?.message || String(error)
      });
    }
  }
);

app.use(
  "/renders",
  express.static(renderDir)
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Raz Ki Duniya running on port ${PORT}`
  );
});
