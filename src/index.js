import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import RunwayML from "@runwayml/sdk";
import ffmpeg from "fluent-ffmpeg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..");

const app = express();

const uploadDir = path.join(root, "uploads");
const renderDir = path.join(root, "renders");

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(renderDir, { recursive: true });

const upload = multer({ dest: uploadDir });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(root));
app.use("/renders", express.static(renderDir));

const runwayKey = process.env.RUNWAYML_API_SECRET;

const client = runwayKey
  ? new RunwayML({ apiKey: runwayKey })
  : null;

const jobs = new Map();

function splitScenes(script) {
  const clean = String(script || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return [];

  const parts = clean
    .split(/(?<=[.!?।॥])\s+/)
    .map(x => x.trim())
    .filter(Boolean);

  if (parts.length <= 20) return parts;

  const result = [];
  for (let i = 0; i < parts.length; i += 2) {
    result.push(parts.slice(i, i + 2).join(" "));
  }

  return result.slice(0, 20);
}

function getRatio(format) {
  return String(format).includes("16:9")
    ? "1280:720"
    : "720:1280";
}

function safeStyle(style) {
  return String(style || "Mystery")
    .replace(/[^\w\s-]/g, "")
    .slice(0, 40);
}

function makePrompt(text, style) {
  return [
    "Cinematic documentary video scene.",
    "Style:",
    safeStyle(style),
    ".",
    "Realistic detailed visuals.",
    "Dramatic lighting.",
    "Natural camera movement.",
    "No text.",
    "No subtitles.",
    "No watermark.",
    "No logo.",
    "Do not show written words.",
    "Visualize this Hindi narration:",
    text
  ].join(" ");
}

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    runwayConfigured: Boolean(client),
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
    try {
      const script = String(req.body.script || "").trim();
      const format = req.body.format || "9:16";
      const style = req.body.style || "Mystery";
      const duration = req.body.duration || "Auto";

      if (!script) {
        return res.status(400).json({
          error: "Script is required."
        });
      }

      if (!client) {
        return res.status(500).json({
          error:
            "RUNWAYML_API_SECRET is not configured on the server."
        });
      }

      const scenes = splitScenes(script);

      if (!scenes.length) {
        return res.status(400).json({
          error: "No scenes could be created from the script."
        });
      }

      const jobId =
        Date.now().toString() +
        "-" +
        Math.random().toString(36).slice(2, 8);

      jobs.set(jobId, {
        status: "generating",
        progress: 0,
        scenes: [],
        script,
        format,
        style,
        duration,
        createdAt: Date.now()
      });

      res.json({
        jobId,
        sceneCount: scenes.length,
        status: "generating"
      });

      (async () => {
        try {
          const ratio = getRatio(format);
          const urls = [];

          for (let i = 0; i < scenes.length; i++) {
            jobs.set(jobId, {
              ...jobs.get(jobId),
              status: "generating",
              progress: Math.round(
                (i / scenes.length) * 75
              ),
              currentScene: i + 1,
              totalScenes: scenes.length,
              scenes: urls
            });

            const prompt = makePrompt(
              scenes[i],
              style
            );

            const task =
              await client.imageToVideo
                .create({
                  model: "gen4.5",
                  promptText: prompt,
                  ratio,
                  duration: 5
                })
                .waitForTaskOutput();

            const output = task.output || [];
            const videoUrl = output[0];

            if (!videoUrl) {
              throw new Error(
                `Runway did not return a video for scene ${i + 1}.`
              );
            }

            urls.push(videoUrl);

            jobs.set(jobId, {
              ...jobs.get(jobId),
              status: "generating",
              progress: Math.round(
                ((i + 1) / scenes.length) * 75
              ),
              currentScene: i + 1,
              totalScenes: scenes.length,
              scenes: urls
            });
          }

          jobs.set(jobId, {
            ...jobs.get(jobId),
            status: "ready",
            progress: 75,
            scenes: urls,
            sceneTexts: scenes
          });
        } catch (error) {
          console.error("Generation error:", error);

          jobs.set(jobId, {
            ...jobs.get(jobId),
            status: "error",
            progress: 0,
            error:
              error?.message ||
              "AI video generation failed."
          });
        }
      })();
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          error?.message ||
          "Could not start video generation."
      });
    }
  }
);

app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
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
    const jobId = req.body.jobId;
    const job = jobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        error: "Video job not found."
      });
    }

    if (job.status !== "ready") {
      return res.status(400).json({
        error: "Generate the AI scenes first."
      });
    }

    const voice =
      req.files?.voice?.[0]?.path || null;

    const music =
      req.files?.music?.[0]?.path || null;

    const sceneFiles = [];

    try {
      for (let i = 0; i < job.scenes.length; i++) {
        const file = path.join(
          renderDir,
          `${jobId}-scene-${i + 1}.mp4`
        );

        const response = await fetch(
          job.scenes[i]
        );

        if (!response.ok) {
          throw new Error(
            `Could not download scene ${i + 1}.`
          );
        }

        const buffer = Buffer.from(
          await response.arrayBuffer()
        );

        fs.writeFileSync(file, buffer);
        sceneFiles.push(file);
      }

      const concatFile = path.join(
        renderDir,
        `${jobId}-concat.txt`
      );

      const concatText = sceneFiles
        .map(file => {
          const safe = file.replace(/'/g, "'\\''");
          return `file '${safe}'`;
        })
        .join("\n");

      fs.writeFileSync(
        concatFile,
        concatText
      );

      const baseVideo = path.join(
        renderDir,
        `${jobId}-base.mp4`
      );

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatFile)
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
          .on("end", resolve)
          .on("error", reject)
          .save(baseVideo);
      });

      const finalVideo = path.join(
        renderDir,
        `${jobId}-final.mp4`
      );

      if (!voice && !music) {
        fs.copyFileSync(
          baseVideo,
          finalVideo
        );
      } else {
        await new Promise((resolve, reject) => {
          const command = ffmpeg(baseVideo);

          if (voice) {
            command.input(voice);
          }

          if (music) {
            command.input(music);
          }

          const filters = [];

          if (voice && music) {
            filters.push(
              "[1:a]volume=1[voice]",
              "[2:a]volume=0.18[music]",
              "[voice][music]amix=inputs=2:duration=first[aout]"
            );

            command.outputOptions([
              "-map",
              "0:v:0",
              "-map",
              "[aout]",
              "-filter_complex",
              filters.join(";"),
              "-c:v",
              "libx264",
              "-c:a",
              "aac",
              "-shortest",
              "-movflags",
              "+faststart"
            ]);
          } else if (voice) {
            command.outputOptions([
              "-map",
              "0:v:0",
              "-map",
              "1:a:0",
              "-c:v",
              "libx264",
              "-c:a",
              "aac",
              "-shortest",
              "-movflags",
              "+faststart"
            ]);
          } else {
            command.outputOptions([
              "-map",
              "0:v:0",
              "-map",
              "1:a:0",
              "-c:v",
              "libx264",
              "-c:a",
              "aac",
              "-shortest",
              "-movflags",
              "+faststart"
            ]);
          }

          command
            .on("end", resolve)
            .on("error", reject)
            .save(finalVideo);
        });
      }

      res.json({
        success: true,
        video:
          `/renders/${path.basename(finalVideo)}`
      });
    } catch (error) {
      console.error("Render error:", error);

      res.status(500).json({
        error:
          error?.message ||
          "Final video rendering failed."
      });
    }
  }
);

app.use((err, req, res, next) => {
  console.error("Server error:", err);

  res.status(500).json({
    error:
      err?.message ||
      "Unexpected server error."
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `Raz Ki Duniya running on port ${PORT}`
  );
});
