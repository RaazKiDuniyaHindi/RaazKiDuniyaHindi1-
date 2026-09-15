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

const uploadsDir = path.join(root, "uploads");
const rendersDir = path.join(root, "renders");

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(rendersDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(root, "public")));
app.use("/renders", express.static(rendersDir));

const runwayKey = process.env.RUNWAYML_API_SECRET;

const client = runwayKey
  ? new RunwayML({
      apiKey: runwayKey
    })
  : null;

const jobs = new Map();

function splitScenes(script) {
  return script
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?।])\s+/)
    .filter(Boolean)
    .slice(0, 20);
}

function cleanFile(file) {
  if (!file?.path) return;

  try {
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  } catch (error) {
    console.error("FILE CLEANUP ERROR:", error?.message || error);
  }
}

function cleanupFiles(files = []) {
  for (const file of files) {
    cleanFile(file);
  }
}

function getErrorMessage(error) {
  if (!error) return "Unknown error";

  if (typeof error === "string") {
    return error;
  }

  if (error.message) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getRunwayDetails(error) {
  try {
    const details =
      error?.response?.data ||
      error?.error ||
      error?.issues ||
      error?.body ||
      null;

    if (!details) return null;

    if (typeof details === "string") {
      return details;
    }

    return JSON.stringify(details);
  } catch {
    return null;
  }
}


/* --------------------------------------------------
   HEALTH / STATUS
-------------------------------------------------- */

app.get("/api/status", (req, res) => {
  res.status(200).json({
    ok: true,
    server: "Raz Ki Duniya",
    runwayConfigured: Boolean(client),
    ffmpeg: true,
    time: new Date().toISOString(),
    message: client
      ? "Raz Ki Duniya server ready"
      : "RUNWAYML_API_SECRET is not configured"
  });
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    ok: true,
    time: new Date().toISOString()
  });
});


/* --------------------------------------------------
   GENERATE
-------------------------------------------------- */

app.post(
  "/api/generate",
  upload.fields([
    { name: "characterImage", maxCount: 1 },
    { name: "voice", maxCount: 1 },
    { name: "music", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      if (!client) {
        cleanupFiles(
          Object.values(req.files || {}).flat()
        );

        return res.status(500).json({
          error:
            "RUNWAYML_API_SECRET configured नहीं है। Render Environment Variables में RUNWAYML_API_SECRET डालें।"
        });
      }

      const script = String(
        req.body?.script || ""
      ).trim();

      const format =
        req.body?.format || "9:16";

      const style =
        req.body?.style || "Mystery";

      const characterMode =
        req.body?.characterMode || "off";

      if (!script) {
        cleanupFiles(
          Object.values(req.files || {}).flat()
        );

        return res.status(400).json({
          error: "Script is required."
        });
      }

      const scenes = splitScenes(script);

      if (!scenes.length) {
        cleanupFiles(
          Object.values(req.files || {}).flat()
        );

        return res.status(400).json({
          error: "Script में कोई scene नहीं मिला।"
        });
      }

      const jobId =
        Date.now() +
        "_" +
        Math.random()
          .toString(36)
          .slice(2, 8);

      jobs.set(jobId, {
        status: "generating",
        progress: 2,
        scenes: [],
        sceneCount: scenes.length,
        currentScene: 0,
        characterMode,
        createdAt: Date.now(),
        message: "AI generation शुरू हो रही है…"
      });

      /*
       * IMPORTANT:
       * Response तुरंत भेज रहे हैं।
       * Actual Runway generation background में चलेगी।
       */
      res.status(200).json({
        ok: true,
        jobId,
        sceneCount: scenes.length
      });

      /*
       * Background generation
       */
      void generateScenes({
        jobId,
        scenes,
        format,
        style
      });

    } catch (error) {
      console.error(
        "GENERATE API ERROR:",
        getErrorMessage(error)
      );

      cleanupFiles(
        Object.values(req.files || {}).flat()
      );

      if (!res.headersSent) {
        res.status(500).json({
          error:
            getErrorMessage(error) ||
            "Video generation request failed."
        });
      }
    }
  }
);


/* --------------------------------------------------
   BACKGROUND RUNWAY GENERATION
-------------------------------------------------- */

async function generateScenes({
  jobId,
  scenes,
  format,
  style
}) {
  try {
    const ratio =
      format === "16:9"
        ? "1280:720"
        : "720:1280";

    const generatedVideos = [];

    for (let i = 0; i < scenes.length; i++) {
      const sceneText = scenes[i];

      const prompt = `
Create a cinematic AI video scene for a Hindi mystery storytelling video.

Style: ${style}

Narration:
${sceneText}

Requirements:
- cinematic realistic visuals
- dramatic atmosphere
- natural camera movement
- detailed environment
- visually match the narration
- no subtitles
- no written text
- no logos
- no watermark
- suitable for YouTube Shorts and social video
`;

      const oldJob = jobs.get(jobId);

      if (!oldJob) {
        throw new Error(
          "Job अचानक समाप्त हो गया।"
        );
      }

      jobs.set(jobId, {
        ...oldJob,
        status: "generating",
        progress: Math.max(
          2,
          Math.round(
            (i / scenes.length) * 75
          )
        ),
        currentScene: i + 1,
        message:
          `AI scene ${i + 1} of ${scenes.length} generate हो रहा है…`
      });

      console.log(
        `RUNWAY: Starting scene ${i + 1}/${scenes.length}`
      );

      let task;

      try {
        task = await client.imageToVideo
          .create({
            model: "gen4.5",
            promptText: prompt,
            ratio,
            duration: 5
          })
          .waitForTaskOutput();

      } catch (error) {
        console.error(
          `RUNWAY SCENE ${i + 1} ERROR:`,
          getErrorMessage(error)
        );

        const details =
          getRunwayDetails(error);

        if (details) {
          console.error(
            "RUNWAY DETAILS:",
            details
          );
        }

        throw new Error(
          `Runway scene ${i + 1} failed: ${getErrorMessage(error)}`
        );
      }

      const videoUrl =
        task?.output?.[0];

      if (!videoUrl) {
        console.error(
          "RUNWAY TASK OUTPUT:",
          JSON.stringify(task, null, 2)
        );

        throw new Error(
          `Runway ने scene ${i + 1} का video URL नहीं दिया।`
        );
      }

      generatedVideos.push(videoUrl);

      const current = jobs.get(jobId);

      if (!current) {
        throw new Error(
          "Job state खो गया।"
        );
      }

      jobs.set(jobId, {
        ...current,
        status: "generating",
        progress: Math.round(
          ((i + 1) / scenes.length) * 75
        ),
        currentScene: i + 1,
        scenes: generatedVideos,
        message:
          `Scene ${i + 1} completed`
      });

      console.log(
        `RUNWAY: Scene ${i + 1}/${scenes.length} completed`
      );
    }

    const current = jobs.get(jobId);

    jobs.set(jobId, {
      ...(current || {}),
      status: "ready",
      progress: 80,
      scenes: generatedVideos,
      currentScene: scenes.length,
      sceneCount: scenes.length,
      message:
        "All AI scenes generated successfully"
    });

    console.log(
      `RUNWAY: Job ${jobId} READY`
    );

  } catch (error) {
    console.error(
      `GENERATION ERROR FOR JOB ${jobId}:`,
      getErrorMessage(error)
    );

    const details =
      getRunwayDetails(error);

    if (details) {
      console.error(
        "RUNWAY DETAILS:",
        details
      );
    }

    const current = jobs.get(jobId);

    jobs.set(jobId, {
      ...(current || {}),
      status: "error",
      progress: 0,
      error:
        getErrorMessage(error) ||
        "AI generation failed.",
      message:
        "AI generation में error आया।"
    });
  }
}


/* --------------------------------------------------
   JOB STATUS
-------------------------------------------------- */

app.get("/api/job/:id", (req, res) => {
  try {
    const jobId = req.params.id;

    const job = jobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        status: "not_found",
        error: "Job not found"
      });
    }

    return res.status(200).json(job);

  } catch (error) {
    console.error(
      "JOB STATUS ERROR:",
      getErrorMessage(error)
    );

    return res.status(500).json({
      status: "error",
      error:
        getErrorMessage(error) ||
        "Job status failed."
    });
  }
});


/* --------------------------------------------------
   RENDER
-------------------------------------------------- */

app.post(
  "/api/render",
  upload.fields([
    { name: "voice", maxCount: 1 },
    { name: "music", maxCount: 1 }
  ]),
  async (req, res) => {
    const voice =
      req.files?.voice?.[0];

    const music =
      req.files?.music?.[0];

    try {
      const jobId =
        String(req.body?.jobId || "");

      const job =
        jobs.get(jobId);

      if (!job || job.status !== "ready") {
        cleanupFiles([
          voice,
          music
        ]);

        return res.status(400).json({
          error:
            "पहले AI scenes generate करो।"
        });
      }

      if (!job.scenes?.length) {
        cleanupFiles([
          voice,
          music
        ]);

        return res.status(400).json({
          error:
            "कोई generated scene नहीं मिला।"
        });
      }

      const sceneFiles = [];

      /*
       * Download generated scenes
       */
      for (
        let i = 0;
        i < job.scenes.length;
        i++
      ) {
        const scenePath =
          path.join(
            rendersDir,
            `${jobId}_scene_${i}.mp4`
          );

        console.log(
          `Downloading scene ${i + 1}/${job.scenes.length}`
        );

        const response =
          await fetch(
            job.scenes[i]
          );

        if (!response.ok) {
          throw new Error(
            `Scene ${i + 1} download नहीं हो पाया। HTTP ${response.status}`
          );
        }

        const buffer =
          Buffer.from(
            await response.arrayBuffer()
          );

        fs.writeFileSync(
          scenePath,
          buffer
        );

        sceneFiles.push(
          scenePath
        );
      }

      const concatFile =
        path.join(
          rendersDir,
          `${jobId}_concat.txt`
        );

      const outputFile =
        path.join(
          rendersDir,
          `${jobId}.mp4`
        );

      const finalFile =
        path.join(
          rendersDir,
          `${jobId}_final.mp4`
        );

      const concatText =
        sceneFiles
          .map(
            file =>
              `file '${file.replaceAll(
                "'",
                "'\\''"
              )}'`
          )
          .join("\n");

      fs.writeFileSync(
        concatFile,
        concatText
      );

      /*
       * Join scenes
       */
      await new Promise(
        (resolve, reject) => {
          ffmpeg()
            .input(concatFile)
            .inputOptions([
              "-f",
              "concat",
              "-safe",
              "0"
            ])
            .outputOptions([
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-pix_fmt",
              "yuv420p",
              "-an"
            ])
            .save(outputFile)
            .on("end", resolve)
            .on("error", reject);
        }
      );

      /*
       * No audio
       */
      if (!voice && !music) {
        cleanupFiles([
          voice,
          music
        ]);

        const video =
          `/renders/${path.basename(
            outputFile
          )}`;

        jobs.set(jobId, {
          ...job,
          status: "complete",
          progress: 100,
          video
        });

        return res.status(200).json({
          ok: true,
          video
        });
      }

      /*
       * Voice + Music
       */
      if (voice && music) {
        await new Promise(
          (resolve, reject) => {
            ffmpeg(outputFile)
              .input(voice.path)
              .input(music.path)
              .complexFilter([
                "[1:a]volume=1.0[voice]",
                "[2:a]volume=0.18[music]",
                "[voice][music]amix=inputs=2:duration=first[aout]"
              ])
              .outputOptions([
                "-map",
                "0:v:0",
                "-map",
                "[aout]",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                "-movflags",
                "+faststart"
              ])
              .save(finalFile)
              .on("end", resolve)
              .on("error", reject);
          }
        );
      }

      /*
       * Voice only
       */
      else if (voice) {
        await new Promise(
          (resolve, reject) => {
            ffmpeg(outputFile)
              .input(voice.path)
              .outputOptions([
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                "-movflags",
                "+faststart"
              ])
              .save(finalFile)
              .on("end", resolve)
              .on("error", reject);
          }
        );
      }

      /*
       * Music only
       */
      else if (music) {
        await new Promise(
          (resolve, reject) => {
            ffmpeg(outputFile)
              .input(music.path)
              .outputOptions([
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                "-movflags",
                "+faststart"
              ])
              .save(finalFile)
              .on("end", resolve)
              .on("error", reject);
          }
        );
      }

      cleanupFiles([
        voice,
        music
      ]);

      const video =
        `/renders/${path.basename(
          finalFile
        )}`;

      jobs.set(jobId, {
        ...job,
        status: "complete",
        progress: 100,
        video
      });

      return res.status(200).json({
        ok: true,
        video
      });

    } catch (error) {
      console.error(
        "RENDER ERROR:",
        getErrorMessage(error)
      );

      cleanupFiles([
        voice,
        music
      ]);

      if (!res.headersSent) {
        return res.status(500).json({
          error:
            getErrorMessage(error) ||
            "Final video render failed."
        });
      }
    }
  }
);


/* --------------------------------------------------
   ROOT
-------------------------------------------------- */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      root,
      "index.html"
    )
  );
});


/* --------------------------------------------------
   EXPRESS ERROR HANDLER
-------------------------------------------------- */

app.use(
  (error, req, res, next) => {
    console.error(
      "EXPRESS ERROR:",
      getErrorMessage(error)
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      error:
        getErrorMessage(error) ||
        "Internal server error."
    });
  }
);


/* --------------------------------------------------
   PROCESS ERROR LOGGING
-------------------------------------------------- */

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "UNHANDLED REJECTION:",
      getErrorMessage(error)
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      getErrorMessage(error)
    );
  }
);


/* --------------------------------------------------
   SERVER
-------------------------------------------------- */

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Raz Ki Duniya AI Video Maker running on port ${PORT}`
    );
  }
);
