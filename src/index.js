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
