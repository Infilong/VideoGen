import express from "express";
import multer from "multer";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { alignTrailerSegmentsToMusic, analyzeActionSignals, analyzeCandidateWindows, applyVisualReviewEditsToDraft, buildAgenticEditPlan, calibrateHighlightScores, canStartBackgroundJob, createSegments, createTrailerSegments, extendDraftToMusicDuration, fitTimelineToDuration, loadJson, MAX_DURATION, maxLogoOutroDuration, polishFinalTimeline, probe, recommendTrailerDuration, refineDraftPlan, renderHighlight, run, saveJson } from "./media.mjs";

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT_EXCEPTION", error);
});
process.on("unhandledRejection", (error) => {
  console.error("UNHANDLED_REJECTION", error);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.HIGHLIGHTAI_DATA_ROOT || path.join(root, "data");
const uploadsRoot = path.join(dataRoot, "uploads");
const projectsRoot = path.join(dataRoot, "projects");
const exportsRoot = path.join(dataRoot, "exports");
const jobsRoot = path.join(dataRoot, "jobs");
const preprocessRoot = path.join(dataRoot, "preprocess");
const thumbnailsRoot = path.join(dataRoot, "thumbnails");
const previewsRoot = path.join(dataRoot, "previews");
const tempRoot = path.join(dataRoot, "tmp");
const renderWorkRoot = path.join(tempRoot, "renders");
const visionWorkRoot = path.join(tempRoot, "vision");
const MAX_FILE_BYTES = 30 * 1024 * 1024 * 1024;
const DEFAULT_FRAME_INTERVAL = 3;
const SEMANTIC_REVIEW_VERSION = 2;
const MAX_SEMANTIC_REVIEW_ATTEMPTS = 2;
const DEFAULT_MAX_VISION_CHECK_SECONDS = 30 * 60;
const FAST_INDEX_MIN_WINDOWS = 6;
const preprocessSecrets = new Map();
const renderReviewSecrets = new Map();
const activePreprocessControllers = new Map();
const activePreprocessJobs = new Map();
const activeIngestControllers = new Map();
const activeFastIndexControllers = new Map();
const activeRenderControllers = new Map();
console.log("HighlightAI startup: preparing storage");
await Promise.all([uploadsRoot, projectsRoot, exportsRoot, jobsRoot, preprocessRoot, thumbnailsRoot, previewsRoot, tempRoot].map((folder) => mkdir(folder, { recursive: true })));
await rm(tempRoot, { recursive: true, force: true });
await Promise.all([renderWorkRoot, visionWorkRoot].map((folder) => mkdir(folder, { recursive: true })));
await rm(preprocessRoot, { recursive: true, force: true });
await mkdir(preprocessRoot, { recursive: true });
console.log("HighlightAI startup: recovering jobs");
await recoverInterruptedPreprocessJobs();
await recoverInterruptedFastIndexJobs();
console.log("HighlightAI startup: cleaning managed storage");
await cleanupManagedStorage();
console.log("HighlightAI startup: storage ready");

const app = express();
const allowedOrigins = new Set([
  "http://127.0.0.1:4312",
  "http://localhost:4312",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:5174",
  "http://localhost:5174",
  "http://127.0.0.1:5175",
  "http://localhost:5175"
]);
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: "Cross-origin local API access is not allowed." });
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
app.use(express.json({ limit: "10mb" }));
app.use("/media/uploads", express.static(uploadsRoot, { acceptRanges: true, dotfiles: "deny" }));
app.use("/media/exports", express.static(exportsRoot, { acceptRanges: true, dotfiles: "deny" }));
app.use(express.static(path.join(root, "dist")));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsRoot),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${randomUUID()}-${file.originalname.replace(/[^\w.-]+/g, "_")}`)
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_BYTES } });

app.get("/api/health", (_, res) => res.json({ ok: true, ffmpeg: true, maxDuration: MAX_DURATION }));
app.get("/api/diagnostics", async (_, res) => {
  let freeBytes = null;
  try {
    const disk = await statfs(dataRoot);
    freeBytes = Number(disk.bavail) * Number(disk.bsize);
  } catch {
    // Some packaged/runtime environments do not expose statfs.
  }
  res.json({
    ok: true,
    dataRoot,
    freeBytes,
    maxFileBytes: MAX_FILE_BYTES,
    maxHighlightSeconds: MAX_DURATION,
    capabilities: {
      localSignals: true,
      semanticVideoVision: "optional",
      bundledVisionModel: false
    }
  });
});

app.delete("/api/projects/:id", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.id);
    const within = (parent, candidate) => {
      const relative = path.relative(parent, path.resolve(candidate || ""));
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    };
    const managedMedia = [
      ...(project.files || []).map((file) => file.path),
      ...(project.assets || []).map((asset) => asset.path)
    ].filter((filePath) => within(uploadsRoot, filePath));
    const managedExports = (project.drafts || [])
      .map((draft) => draft.exportPath)
      .filter((filePath) => within(exportsRoot, filePath));
    const cacheNames = await Promise.all([readdir(thumbnailsRoot), readdir(previewsRoot), readdir(jobsRoot)]);
    const cacheFiles = [
      ...cacheNames[0].filter((name) => name.startsWith(`${project.id}-`)).map((name) => path.join(thumbnailsRoot, name)),
      ...cacheNames[1].filter((name) => name.startsWith(`${project.id}-`)).map((name) => path.join(previewsRoot, name)),
      ...cacheNames[2].map((name) => path.join(jobsRoot, name))
    ];
    const projectJobs = [];
    for (const filePath of cacheFiles.slice(cacheNames[0].length + cacheNames[1].length)) {
      try {
        const job = await loadJson(filePath);
        if (job.projectId === project.id) projectJobs.push(filePath);
      } catch {
        // Ignore unrelated or incomplete job records.
      }
    }
    await Promise.all([
      ...managedMedia,
      ...managedExports,
      ...cacheFiles.slice(0, cacheNames[0].length + cacheNames[1].length),
      ...projectJobs
    ].map((filePath) => rm(filePath, { force: true }).catch(() => undefined)));
    await rm(path.join(preprocessRoot, project.id), { recursive: true, force: true }).catch(() => undefined);
    await rm(projectFile(project.id), { force: true });
    await cleanupManagedStorage();
    res.json({ id: project.id, removed: true, sourceFilesPreserved: project.sourceType === "local-folder" });
  } catch (error) { next(error); }
});

app.post("/api/ingest-jobs", async (req, res, next) => {
  try {
    const totalFiles = Math.max(0, Number(req.body.totalFiles) || 0);
    const totalBytes = Math.max(0, Number(req.body.totalBytes) || 0);
    if (!totalFiles || !totalBytes) return res.status(400).json({ error: structuredError("No videos selected", "Choose at least one non-empty video file.", "Choose the folder again.", true) });
    const now = new Date().toISOString();
    const requestedFiles = Array.isArray(req.body.files) ? req.body.files : [];
    const reusable = await findReusableMedia(requestedFiles);
    const reusedFiles = requestedFiles.flatMap((file) => {
      const match = reusable.get(mediaLookupKey(file.name, file.size));
      return match ? [{
        clientId: String(file.clientId),
        name: String(file.name),
        path: match.path,
        url: match.url || null,
        size: Number(file.size),
        state: "reused",
        reusedMetadata: match.metadata
      }] : [];
    });
    const job = {
      id: randomUUID(),
      name: String(req.body.name || `Highlight ${new Date().toLocaleDateString()}`).slice(0, 120),
      status: "uploading",
      phase: "uploading",
      totalFiles,
      totalBytes,
      uploadedFiles: reusedFiles.length,
      uploadedBytes: reusedFiles.reduce((sum, file) => sum + file.size, 0),
      processedFiles: 0,
      currentFile: null,
      failures: [],
      files: reusedFiles,
      projectId: null,
      createdAt: now,
      updatedAt: now,
      estimatedSeconds: estimateIngestSeconds({ totalFiles, totalBytes }),
      etaSeconds: estimateIngestSeconds({ totalFiles, totalBytes }),
      processingConcurrency: ingestConcurrency(),
      cancelRequested: false
    };
    await saveJob(job);
    res.status(201).json(publicJob(job));
  } catch (error) { next(error); }
});

app.post("/api/ingest-local-folder", async (req, res, next) => {
  try {
    const folder = path.resolve(String(req.body.folder || ""));
    const entries = await readdir(folder, { withFileTypes: true });
    const videoNames = entries.filter((entry) => entry.isFile() && /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(entry.name)).map((entry) => entry.name);
    const fileStats = await Promise.all(videoNames.map(async (name) => ({ name, info: await stat(path.join(folder, name)) })));
    const totalBytes = fileStats.reduce((sum, item) => sum + item.info.size, 0);
    if (!fileStats.length) return res.status(400).json({ error: structuredError("No videos found", "The selected folder has no supported videos.", "Choose another folder.", true) });
    const existing = await findProjectBySourcePath(folder);
    if (existing && sameFolderSnapshot(existing, fileStats)) {
      const now = new Date().toISOString();
      const job = {
        id: randomUUID(), name: existing.name, status: "completed", phase: "completed",
        totalFiles: existing.files.length, totalBytes, uploadedFiles: existing.files.length, uploadedBytes: totalBytes,
        processedFiles: existing.files.length, currentFile: null, failures: [], files: [],
        projectId: existing.id, createdAt: now, updatedAt: now, estimatedSeconds: 0, etaSeconds: 0,
        processingConcurrency: 0, cancelRequested: false,
        result: { project: existing, analysis: existing.analysis || buildAnalysis(existing.files) }
      };
      await saveJob(job);
      return res.json(publicJob(job));
    }
    const now = new Date().toISOString();
    const projectFiles = fileStats.map((item) => ({
      id: randomUUID(),
      name: item.name,
      path: path.join(folder, item.name),
      url: null,
      size: item.info.size,
      metadata: pendingVideoMetadata(item.info.size)
    }));
    const project = {
      id: randomUUID(),
      name: path.basename(folder),
      sourcePath: folder,
      sourceType: "local-folder",
      createdAt: now,
      updatedAt: now,
      files: projectFiles,
      assets: [],
      drafts: [],
      analysis: buildAnalysis(projectFiles),
      fastIndex: {
        jobId: null,
        status: "waiting_for_import",
        phase: "probing",
        processedFiles: 0,
        totalFiles: projectFiles.length,
        candidateWindows: 0,
        estimatedSeconds: estimateIngestSeconds({ totalFiles: fileStats.length, totalBytes }),
        etaSeconds: estimateIngestSeconds({ totalFiles: fileStats.length, totalBytes }),
        updatedAt: now
      },
      maxDuration: MAX_DURATION
    };
    await saveProject(project);
    const job = {
      id: randomUUID(), name: path.basename(folder), status: "processing", phase: "probing",
      totalFiles: fileStats.length, totalBytes, uploadedFiles: fileStats.length, uploadedBytes: totalBytes,
      processedFiles: 0, currentFile: fileStats[0].name, failures: [],
      estimatedSeconds: estimateIngestSeconds({ totalFiles: fileStats.length, totalBytes }),
      etaSeconds: estimateIngestSeconds({ totalFiles: fileStats.length, totalBytes }),
      processingConcurrency: ingestConcurrency(),
      files: fileStats.map((item, index) => ({
        clientId: `${item.name}-${item.info.size}-${item.info.mtimeMs}`,
        fileId: projectFiles[index].id,
        name: item.name, path: path.join(folder, item.name), url: null, size: item.info.size, state: "linked"
      })),
      projectId: project.id, createdAt: now, updatedAt: now, cancelRequested: false, linkedFolder: folder
    };
    await saveJob(job);
    res.status(202).json(publicJob(job));
    processIngestJob(job.id).catch((error) => void markIngestJobFailed(job.id, error));
  } catch (error) { next(error); }
});

app.put("/api/ingest-jobs/:id/files", upload.single("file"), async (req, res, next) => {
  try {
    const job = await loadJob(req.params.id);
    if (job.cancelRequested) return res.status(409).json({ error: structuredError("Import cancelled", "This import was cancelled.", "Start a new import when ready.", true) });
    if (!req.file) return res.status(400).json({ error: structuredError("File was not received", "The selected file could not be copied.", "Retry this file.", true) });
    const clientId = String(req.body.clientId || randomUUID());
    job.files.push({
      clientId,
      name: req.file.originalname,
      path: req.file.path,
      url: `/media/uploads/${path.basename(req.file.path)}`,
      size: req.file.size,
      state: "uploaded"
    });
    job.uploadedFiles = job.files.length;
    job.uploadedBytes = job.files.reduce((sum, file) => sum + file.size, 0);
    job.currentFile = req.file.originalname;
    await saveJob(job);
    res.json(publicJob(job));
  } catch (error) { next(error); }
});

app.get("/api/ingest-jobs/:id", async (req, res, next) => {
  try { res.json(publicJob(await loadJob(req.params.id))); } catch (error) { next(error); }
});

app.post("/api/ingest-jobs/:id/cancel", async (req, res, next) => {
  try {
    const job = await loadJob(req.params.id);
    job.cancelRequested = true;
    job.status = "cancelled";
    job.phase = "cancelled";
    job.currentFile = null;
    await saveJob(job);
    res.json(publicJob(job));
  } catch (error) { next(error); }
});

app.post("/api/ingest-jobs/:id/pause", async (req, res, next) => {
  try {
    const job = await loadJob(req.params.id);
    if (!["uploading", "processing"].includes(job.status)) return res.json(publicJob(job));
    job.status = "paused";
    job.phase = "paused";
    job.currentFile = null;
    job.activeFiles = [];
    activeIngestControllers.get(job.id)?.abort();
    await saveJob(job);
    res.json(publicJob(job));
  } catch (error) { next(error); }
});

app.post("/api/ingest-jobs/:id/resume", async (req, res, next) => {
  try {
    const job = await loadJob(req.params.id);
    if (job.status !== "paused") return res.json(publicJob(job));
    job.status = "processing";
    job.phase = "probing";
    await saveJob(job);
    res.json(publicJob(job));
    processIngestJob(job.id).catch((error) => void markIngestJobFailed(job.id, error));
  } catch (error) { next(error); }
});

app.post("/api/ingest-jobs/:id/process", async (req, res, next) => {
  try {
    const job = await loadJob(req.params.id);
    if (!job.files.length) return res.status(400).json({ error: structuredError("No files copied", "None of the selected files reached the local workspace.", "Check disk space and retry the folder.", true) });
    job.status = "processing";
    job.phase = "probing";
    job.currentFile = job.files[0]?.name || null;
    await saveJob(job);
    res.status(202).json(publicJob(job));
    processIngestJob(job.id).catch((error) => void markIngestJobFailed(job.id, error));
  } catch (error) { next(error); }
});

app.post("/api/projects", upload.array("files", 50), async (req, res, next) => {
  try {
    const files = [];
    for (const file of req.files ?? []) {
      const metadata = await probe(file.path);
      files.push({
        id: randomUUID(),
        name: file.originalname,
        path: file.path,
        url: `/media/uploads/${path.basename(file.path)}`,
        size: file.size,
        metadata
      });
    }
    if (!files.length) return res.status(400).json({ error: "No usable video files uploaded." });
    const analysis = buildAnalysis(files);
    const project = {
      id: randomUUID(),
      name: req.body.name || `Highlight ${new Date().toLocaleDateString()}`,
      sourceType: "uploaded-files",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      files,
      assets: [],
      drafts: [],
      analysis,
      maxDuration: MAX_DURATION
    };
    await saveProject(project);
    res.json({ project, analysis });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects", async (_, res) => {
  const names = (await readdir(projectsRoot)).filter((name) => name.endsWith(".json"));
  const projects = await Promise.all(names.map((name) => loadProject(path.basename(name, ".json"))));
  res.json(projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
});

app.get("/api/projects/:id", async (req, res, next) => {
  try { res.json(await loadProject(req.params.id)); } catch (error) { next(error); }
});

app.get("/api/projects/:id/ai-coverage", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.id);
    if (normalizeAiDecisions(project)) {
      project.analysis = buildAnalysis(project.files || []);
      await saveProject(project);
    }
    res.json(buildAiCoverageReport(project));
  } catch (error) { next(error); }
});

app.post("/api/projects/:id/reconcile", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.id);
    let changed = false;
    if (project.fastIndex?.jobId) {
      const fastJob = await loadFastIndexJob(project.fastIndex.jobId).catch(() => null);
      if (fastJob) {
        const previousJobState = JSON.stringify({
          status: fastJob.status,
          phase: fastJob.phase,
          processedFiles: fastJob.processedFiles,
          candidateWindows: fastJob.candidateWindows,
          etaSeconds: fastJob.etaSeconds,
          currentFile: fastJob.currentFile,
          activeFiles: fastJob.activeFiles
        });
        const jobCompleted = ["completed", "completed_with_warnings"].includes(String(fastJob.status || ""));
        const progress = jobCompleted
          ? {
              processedFiles: Math.max(Number(fastJob.totalFiles || 0), Number(fastJob.processedFiles || 0)),
              candidateWindows: countFastIndexCandidateWindows(project, fastJob)
            }
          : summarizeFastIndexProgress(project, fastJob);
        fastJob.processedFiles = progress.processedFiles;
        fastJob.candidateWindows = progress.candidateWindows;
        if (progress.processedFiles >= fastJob.totalFiles && !["completed", "completed_with_warnings"].includes(fastJob.status)) {
          fastJob.status = fastJob.failures.length ? "completed_with_warnings" : "completed";
          fastJob.phase = "completed";
          fastJob.etaSeconds = 0;
          fastJob.currentFile = null;
          fastJob.activeFiles = [];
        }
        const nextJobState = JSON.stringify({
          status: fastJob.status,
          phase: fastJob.phase,
          processedFiles: fastJob.processedFiles,
          candidateWindows: fastJob.candidateWindows,
          etaSeconds: fastJob.etaSeconds,
          currentFile: fastJob.currentFile,
          activeFiles: fastJob.activeFiles
        });
        if (nextJobState !== previousJobState) await saveFastIndexJob(fastJob);
        const normalizedFastIndex = normalizeFastIndexProgressFields(fastJob);
        const nextFastIndex = {
          ...project.fastIndex,
          jobId: fastJob.id,
          status: fastJob.status,
          phase: fastJob.phase,
          processedFiles: normalizedFastIndex.processedFiles,
          totalFiles: normalizedFastIndex.totalFiles,
          candidateWindows: fastJob.candidateWindows,
          estimatedSeconds: fastJob.estimatedSeconds,
          etaSeconds: fastJob.etaSeconds,
          updatedAt: fastJob.updatedAt
        };
        if (JSON.stringify(nextFastIndex) !== JSON.stringify(project.fastIndex)) {
          project.fastIndex = nextFastIndex;
          changed = true;
        }
      }
    }

    for (const draft of project.drafts || []) {
      if (!draft.exportUrl) continue;
      const exportPath = draft.exportPath || path.join(exportsRoot, path.basename(draft.exportUrl));
      try {
        await stat(exportPath);
        draft.exportPath = exportPath;
      } catch {
        delete draft.exportUrl;
        delete draft.exportPath;
        draft.status = "ready";
        changed = true;
      }
    }

    const pending = [];
    const removedFileIds = [];
    if (project.sourcePath) {
      const entries = await readdir(project.sourcePath, { withFileTypes: true });
      const videoNames = entries
        .filter((entry) => entry.isFile() && /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(entry.name))
        .map((entry) => entry.name);
      const diskFiles = await Promise.all(videoNames.map(async (name) => {
        const filePath = path.join(project.sourcePath, name);
        return { name, path: filePath, info: await stat(filePath) };
      }));
      const existingByPath = new Map(project.files.map((file) => [normalizedSourcePath(file.path), file]));
      const diskPaths = new Set(diskFiles.map((file) => normalizedSourcePath(file.path)));
      const nextFiles = [];

      for (const diskFile of diskFiles) {
        const existing = existingByPath.get(normalizedSourcePath(diskFile.path));
        if (existing && Number(existing.size) === Number(diskFile.info.size)) {
          nextFiles.push(existing);
          continue;
        }
        const file = {
          id: randomUUID(),
          name: diskFile.name,
          path: diskFile.path,
          url: null,
          size: diskFile.info.size,
          metadata: pendingVideoMetadata(diskFile.info.size)
        };
        nextFiles.push(file);
        pending.push({
          clientId: `${diskFile.name}-${diskFile.info.size}-${diskFile.info.mtimeMs}`,
          fileId: file.id,
          name: diskFile.name,
          path: diskFile.path,
          url: null,
          size: diskFile.info.size,
          state: "linked"
        });
      }

      for (const file of project.files) {
        if (!diskPaths.has(normalizedSourcePath(file.path))) removedFileIds.push(file.id);
      }
      if (removedFileIds.length || pending.length) changed = true;
      project.files = nextFiles;
    }

    if (normalizeAiDecisions(project)) changed = true;

    if (changed) {
      project.analysis = buildAnalysis(project.files);
      await saveProject(project);
      await Promise.all(removedFileIds.map((fileId) =>
        Promise.all([
          rm(path.join(thumbnailsRoot, `${project.id}-${fileId}.jpg`), { force: true }).catch(() => undefined),
          rm(path.join(previewsRoot, `${project.id}-${fileId}.mp4`), { force: true }).catch(() => undefined)
        ])
      ));
    }

    if (pending.length) {
      const totalBytes = pending.reduce((sum, file) => sum + file.size, 0);
      const estimatedSeconds = estimateIngestSeconds({ totalFiles: pending.length, totalBytes });
      const now = new Date().toISOString();
      const job = {
        id: randomUUID(),
        name: `${project.name} folder refresh`,
        status: "processing",
        phase: "probing",
        totalFiles: pending.length,
        totalBytes,
        uploadedFiles: pending.length,
        uploadedBytes: totalBytes,
        processedFiles: 0,
        currentFile: pending[0].name,
        failures: [],
        estimatedSeconds,
        etaSeconds: estimatedSeconds,
        processingConcurrency: ingestConcurrency(),
        files: pending,
        projectId: project.id,
        createdAt: now,
        updatedAt: now,
        cancelRequested: false,
        linkedFolder: project.sourcePath
      };
      await saveJob(job);
      processIngestJob(job.id).catch((error) => void markIngestJobFailed(job.id, error));
    }

    res.json(project);
  } catch (error) { next(error); }
});

app.get("/api/projects/:projectId/files/:fileId/stream", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.projectId);
    const file = project.files.find((item) => item.id === req.params.fileId);
    if (!file?.path) return res.status(404).json({ error: "Video not found" });
    res.sendFile(path.resolve(file.path));
  } catch (error) { next(error); }
});

app.post("/api/projects/:projectId/files/:fileId/highlight-confirmations", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.projectId);
    const file = project.files.find((item) => item.id === req.params.fileId);
    if (!file?.metadata?.duration) return res.status(404).json({ error: "Video not found" });
    const start = Math.max(0, Number(req.body.start) || 0);
    const end = Math.min(Number(file.metadata.duration) || start, Number(req.body.end) || start);
    if (end - start < 1) {
      return res.status(400).json({ error: structuredError("Highlight period is too short", "Keep at least one second of footage after trimming.", "Move the start or end trim control and confirm again.", true) });
    }
    const moment = {
      start: Math.round(start * 10) / 10,
      end: Math.round(end * 10) / 10,
      duration: Math.round((end - start) * 10) / 10,
      score: Math.max(1, Math.min(100, Math.round(Number(req.body.score) || Number(file.metadata.indexScore) || 75))),
      state: String(req.body.state || "human-confirmed").slice(0, 60),
      action: String(req.body.action || "confirmed highlight").slice(0, 120),
      storyRole: String(req.body.storyRole || "payoff").slice(0, 60),
      source: String(req.body.source || "human-confirmed").slice(0, 60),
      confirmedAt: new Date().toISOString()
    };
    const previous = Array.isArray(file.metadata.confirmedHighlightMoments)
      ? file.metadata.confirmedHighlightMoments
      : [];
    const replaceStart = Number.isFinite(Number(req.body.replaceStart)) ? Math.max(0, Number(req.body.replaceStart)) : moment.start;
    const replaceEnd = Number.isFinite(Number(req.body.replaceEnd)) ? Math.min(Number(file.metadata.duration) || replaceStart, Number(req.body.replaceEnd)) : moment.end;
    const overlapsRange = (item, rangeStart, rangeEnd) =>
      Math.max(Number(item.start) || 0, rangeStart) < Math.min(Number(item.end) || (Number(item.start) || 0) + (Number(item.duration) || 0), rangeEnd) - 0.75;
    const withoutOverlap = previous.filter((item) =>
      !overlapsRange(item, moment.start, moment.end) && !overlapsRange(item, replaceStart, replaceEnd)
    );
    file.metadata.confirmedHighlightMoments = [...withoutOverlap, moment]
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, 6);
    file.metadata.reviewed = true;
    file.metadata.reviewedAt = new Date().toISOString();
    file.metadata.semanticQuality = file.metadata.semanticQuality === "verified" ? file.metadata.semanticQuality : "weak";
    file.metadata.ratingConfidence = "high";
    project.analysis = buildAnalysis(project.files);
    await saveProject(project);
    res.json(project);
  } catch (error) { next(error); }
});

app.post("/api/projects/:projectId/files/:fileId/highlight-review", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.projectId);
    const file = project.files.find((item) => item.id === req.params.fileId);
    if (!file?.metadata?.duration) return res.status(404).json({ error: "Video not found" });
    file.metadata.reviewed = req.body?.reviewed !== false;
    file.metadata.reviewedAt = new Date().toISOString();
    project.analysis = buildAnalysis(project.files);
    await saveProject(project);
    res.json(project);
  } catch (error) { next(error); }
});

app.delete("/api/projects/:projectId/files/:fileId/highlight-confirmations", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.projectId);
    const file = project.files.find((item) => item.id === req.params.fileId);
    if (!file?.metadata?.duration) return res.status(404).json({ error: "Video not found" });
    const start = Math.max(0, Number(req.body.start) || 0);
    const end = Math.min(Number(file.metadata.duration) || start, Number(req.body.end) || start);
    if (end - start < 1) {
      return res.status(400).json({ error: structuredError("Confirmed period is too short", "Keep at least one second in the period you remove.", "Choose a saved highlight period again.", true) });
    }
    const overlaps = (item) =>
      Math.max(Number(item.start) || 0, start) < Math.min(Number(item.end) || (Number(item.start) || 0) + (Number(item.duration) || 0), end) - 0.75;
    file.metadata.confirmedHighlightMoments = (file.metadata.confirmedHighlightMoments || []).filter((item) => !overlaps(item));
    project.analysis = buildAnalysis(project.files);
    await saveProject(project);
    res.json(project);
  } catch (error) { next(error); }
});

app.post("/api/projects/:projectId/files/:fileId/highlight-rejections", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.projectId);
    const file = project.files.find((item) => item.id === req.params.fileId);
    if (!file?.metadata?.duration) return res.status(404).json({ error: "Video not found" });
    const start = Math.max(0, Number(req.body.start) || 0);
    const end = Math.min(Number(file.metadata.duration) || start, Number(req.body.end) || start);
    if (req.body.reason !== "not-highlight") {
      return res.status(400).json({ error: structuredError("Discard reason is not supported", "Only permanent not-highlight rejections are saved.", "Choose one of the discard options again.", true) });
    }
    if (end - start < 1) {
      return res.status(400).json({ error: structuredError("Rejected period is too short", "Keep at least one second of footage in the rejected range.", "Move the start or end trim control and try again.", true) });
    }
    const rejection = {
      start: Math.round(start * 10) / 10,
      end: Math.round(end * 10) / 10,
      duration: Math.round((end - start) * 10) / 10,
      reason: "not-highlight",
      source: String(req.body.source || "human-review").slice(0, 60),
      rejectedAt: new Date().toISOString()
    };
    const overlaps = (item) =>
      Math.max(Number(item.start) || 0, rejection.start) < Math.min(Number(item.end) || (Number(item.start) || 0) + (Number(item.duration) || 0), rejection.end) - 0.75;
    const previous = Array.isArray(file.metadata.rejectedHighlightMoments)
      ? file.metadata.rejectedHighlightMoments
      : [];
    file.metadata.rejectedHighlightMoments = [...previous.filter((item) => !overlaps(item)), rejection]
      .sort((a, b) => Date.parse(b.rejectedAt || "") - Date.parse(a.rejectedAt || ""))
      .slice(0, 12);
    file.metadata.confirmedHighlightMoments = (file.metadata.confirmedHighlightMoments || []).filter((item) => !overlaps(item));
    file.metadata.semanticEvents = (file.metadata.semanticEvents || []).filter((item) => !overlaps(item));
    file.metadata.semanticCandidateHistory = (file.metadata.semanticCandidateHistory || []).filter((item) => !overlaps(item));
    file.metadata.candidateWindows = (file.metadata.candidateWindows || []).filter((item) => !overlaps(item));
    file.metadata.reviewed = true;
    file.metadata.reviewedAt = new Date().toISOString();
    if (Number(file.metadata.semanticTopFrame) >= rejection.start && Number(file.metadata.semanticTopFrame) <= rejection.end) delete file.metadata.semanticTopFrame;
    if (Number(file.metadata.highlightStart) >= rejection.start && Number(file.metadata.highlightStart) <= rejection.end) delete file.metadata.highlightStart;
    project.analysis = buildAnalysis(project.files);
    await saveProject(project);
    res.json(project);
  } catch (error) { next(error); }
});

const previewTasks = new Map();
app.get("/api/projects/:projectId/files/:fileId/preview", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.projectId);
    const file = project.files.find((item) => item.id === req.params.fileId);
    if (!file?.path || !hasUsableMetadata(file)) return res.status(404).end();
    const outputPath = path.join(previewsRoot, `${project.id}-${file.id}.mp4`);
    try {
      await stat(outputPath);
    } catch {
      const key = `${project.id}:${file.id}`;
      if (!previewTasks.has(key)) {
        previewTasks.set(key, run("ffmpeg", [
          "-y", "-i", file.path,
          "-map", "0:v:0", "-map", "0:a?",
          "-vf", "scale=1280:-2:force_original_aspect_ratio=decrease,fps=30",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "128k", "-ac", "2",
          "-movflags", "+faststart", outputPath
        ]).finally(() => previewTasks.delete(key)));
      }
      await previewTasks.get(key);
    }
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.sendFile(outputPath);
  } catch (error) { next(error); }
});

const thumbnailTasks = new Map();
app.get("/api/projects/:projectId/files/:fileId/thumbnail", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.projectId);
    const file = project.files.find((item) => item.id === req.params.fileId);
    if (!file?.path || !hasUsableMetadata(file)) return res.status(404).end();
    const outputPath = path.join(thumbnailsRoot, `${project.id}-${file.id}.jpg`);
    try {
      await stat(outputPath);
    } catch {
      const key = `${project.id}:${file.id}`;
      if (!thumbnailTasks.has(key)) {
        const at = Math.max(0, Math.min(
          Number(file.metadata.duration || 0) - 0.25,
          reliableFocusTime(file)
        ));
        thumbnailTasks.set(key, run("ffmpeg", [
          "-y", "-ss", String(at), "-i", file.path,
          "-frames:v", "1", "-vf", "scale=640:-2:flags=lanczos", "-q:v", "3", outputPath
        ]).finally(() => thumbnailTasks.delete(key)));
      }
      await thumbnailTasks.get(key);
    }
    res.sendFile(outputPath);
  } catch (error) { next(error); }
});

app.get("/api/public-audio", async (req, res, next) => {
  try {
    const term = String(req.query.q || "cinematic").replace(/[^\w\s-]/g, " ").trim().slice(0, 60);
    const query = `mediatype:audio AND (${term || "cinematic"}) AND licenseurl:*creativecommons*`;
    const params = new URLSearchParams({
      q: query,
      "fl[]": ["identifier", "title", "creator", "licenseurl"].join(","),
      rows: "8",
      page: "1",
      output: "json"
    });
    const response = await fetch(`https://archive.org/advancedsearch.php?${params}`);
    if (!response.ok) throw new Error("Public audio search is temporarily unavailable.");
    const json = await response.json();
    res.json((json.response?.docs ?? []).map((doc) => ({
      id: doc.identifier,
      title: Array.isArray(doc.title) ? doc.title[0] : doc.title || doc.identifier,
      creator: Array.isArray(doc.creator) ? doc.creator[0] : doc.creator || "Unknown creator",
      licenseUrl: Array.isArray(doc.licenseurl) ? doc.licenseurl[0] : doc.licenseurl || null,
      sourceUrl: `https://archive.org/details/${doc.identifier}`,
      provider: "Internet Archive"
    })));
  } catch (error) { next(error); }
});

app.post("/api/projects/:id/public-audio", async (req, res, next) => {
  try {
    const identifier = String(req.body.identifier || "");
    if (!/^[\w.-]+$/.test(identifier)) return res.status(400).json({ error: "Invalid public asset identifier." });
    const metadataResponse = await fetch(`https://archive.org/metadata/${identifier}`);
    if (!metadataResponse.ok) throw new Error("Could not load public asset metadata.");
    const metadata = await metadataResponse.json();
    const file = (metadata.files ?? []).find((item) => /\.(mp3|ogg|flac|m4a|wav)$/i.test(item.name) && Number(item.size || 0) > 0 && Number(item.size || 0) <= 150 * 1024 * 1024);
    if (!file) return res.status(400).json({ error: "No compatible audio file under 150 MB was found." });
    const safeName = `${identifier}-${path.basename(file.name).replace(/[^\w.-]+/g, "_")}`;
    const destination = path.join(uploadsRoot, safeName);
    const download = await fetch(`https://archive.org/download/${identifier}/${encodeURIComponent(file.name).replaceAll("%2F", "/")}`);
    if (!download.ok || !download.body) throw new Error("Could not download the selected public asset.");
    await pipeline(download.body, createWriteStream(destination));
    const duration = await audioAssetDuration(destination);
    const project = await loadProject(req.params.id);
    project.assets.push({
      id: randomUUID(),
      name: file.name,
      path: destination,
      url: `/media/uploads/${safeName}`,
      size: Number(file.size || 0),
      ...(duration ? { duration } : {}),
      source: "public",
      sourceUrl: `https://archive.org/details/${identifier}`,
      creator: metadata.metadata?.creator || req.body.creator || "Unknown creator",
      licenseUrl: metadata.metadata?.licenseurl || req.body.licenseUrl || null,
      licenseWarning: !metadata.metadata?.licenseurl
    });
    await saveProject(project);
    res.json(project);
  } catch (error) { next(error); }
});

app.post("/api/projects/:id/assets", upload.array("files", 20), async (req, res, next) => {
  try {
    const project = await loadProject(req.params.id);
    for (const file of req.files ?? []) {
      const hash = await fileSha256(file.path);
      const extension = path.extname(file.originalname).toLowerCase().replace(/[^\w.]/g, "");
      const canonicalPath = path.join(uploadsRoot, `${hash}${extension}`);
      if (path.resolve(file.path) !== path.resolve(canonicalPath)) {
        try {
          await stat(canonicalPath);
          await rm(file.path, { force: true });
        } catch {
          await rename(file.path, canonicalPath);
        }
      }
      const duplicate = project.assets.find((asset) => asset.contentHash === hash);
      if (duplicate) continue;
      const duration = isAudioAssetName(file.originalname) ? await audioAssetDuration(canonicalPath) : null;
      project.assets.push({
        id: randomUUID(),
        name: file.originalname,
        path: canonicalPath,
        url: `/media/uploads/${path.basename(canonicalPath)}`,
        size: file.size,
        ...(duration ? { duration } : {}),
        contentHash: hash
      });
    }
    await saveProject(project);
    await cleanupManagedStorage();
    res.json(project);
  } catch (error) { next(error); }
});

function createAdviceFallbackPlan(files, targetDuration, intensity = 78, reason = "Using indexed candidate moments because Vision AI did not verify enough complete highlight events.") {
  const fallback = createSegments(files, targetDuration, intensity);
  const uniqueFiles = new Set((fallback.segments || []).map((segment) => segment.fileId));
  const duration = Number(fallback.duration || 0);
  const requestedDuration = Math.min(MAX_DURATION, Math.max(15, Number(targetDuration) || duration || 60));
  const coverage = requestedDuration ? Math.round((duration / requestedDuration) * 100) : 0;
  const score = Math.max(45, Math.min(82, Math.round(58 + uniqueFiles.size * 2 + Math.min(12, (fallback.segments || []).length))));
  return {
    ...fallback,
    workflow: {
      version: 1,
      status: "advice-fallback",
      requestedDuration,
      selectedMoments: fallback.segments?.length || 0,
      rejectedMoments: 0,
      sourceVideosUsed: uniqueFiles.size,
      specialists: {
        action: "Fallback planner used locally indexed candidate moments.",
        boringFrames: reason,
        story: "Generation continues instead of blocking; add stronger clips for a better edit.",
        diversity: `${uniqueFiles.size} source video${uniqueFiles.size === 1 ? "" : "s"} represented.`
      },
      critique: {
        approved: false,
        score,
        coverage,
        duplicateIntervals: 0,
        payoffMoments: 0,
        lowConfidenceMoments: fallback.segments?.length || 0,
        action: "Use more visible action payoffs when possible.",
        boringFrames: reason,
        story: "This edit is generated from best available indexed moments.",
        diversity: `${uniqueFiles.size} source video${uniqueFiles.size === 1 ? "" : "s"} represented.`
      },
      advice: reason
    }
  };
}

function buildAutoHighlightPlan(files, targetDuration, options = {}) {
  const baseOptions = {
    gameGenre: options.gameGenre,
    excludedIntervals: options.excludedIntervals,
    qualityFirst: true
  };
  const strictPlan = buildAgenticEditPlan(files, targetDuration, {
    ...baseOptions,
    minScore: options.minScore ?? 64,
    requireVerifiedVision: true,
    allowReviewCandidates: false
  });
  const targetSeconds = Math.min(MAX_DURATION, Math.max(45, Number(targetDuration) || 180));
  const strictDuration = Number(strictPlan.duration || 0);
  const strictHasEnoughCoverage = strictDuration >= targetSeconds * 0.9;
  if (strictPlan.segments?.length && strictHasEnoughCoverage && (strictPlan.workflow?.critique?.approved || strictPlan.segments.length >= 3)) {
    strictPlan.workflow.status = "verified-ai";
    strictPlan.workflow.advice = "AI verified enough complete highlight moments for automatic generation.";
    return strictPlan;
  }

  const autoRankedPlan = buildAgenticEditPlan(files, targetDuration, {
    ...baseOptions,
    minScore: options.relaxedMinScore ?? 58,
    reviewCandidateMinScore: options.reviewCandidateMinScore ?? 64,
    requireVerifiedVision: true,
    allowReviewCandidates: true,
    allowWeakReviewCandidates: true,
    allowSemanticSummaryCandidates: true,
    allowIndexedAfterUncertainVision: true,
    qualityFirst: false
  });
  if (autoRankedPlan.segments?.length) {
    const autoDuration = Number(autoRankedPlan.duration || 0);
    const shouldUseStrict = strictPlan.segments?.length && strictDuration >= autoDuration && strictDuration >= targetSeconds * 0.75;
    if (shouldUseStrict) {
      strictPlan.workflow.status = "verified-ai";
      strictPlan.workflow.advice = "AI verified the strongest complete highlight moments for automatic generation.";
      return strictPlan;
    }
    autoRankedPlan.workflow.status = strictPlan.segments?.length ? "verified-plus-auto-ranked" : "auto-ranked-candidates";
    autoRankedPlan.workflow.advice = strictPlan.segments?.length && !strictHasEnoughCoverage
      ? "AI verified strong moments, then added ranked supporting clips to get closer to the requested three-minute edit."
      : "AI used verified moments first, then auto-ranked strong uncertain and indexed candidates without requiring manual review.";
    autoRankedPlan.workflow.strictCandidateCount = strictPlan.segments?.length || 0;
    autoRankedPlan.workflow.strictCandidateDuration = Math.round(strictDuration * 10) / 10;
    return autoRankedPlan;
  }

  return createAdviceFallbackPlan(
    files,
    targetDuration,
    options.intensity ?? 78,
    "AI did not find enough strong verified or uncertain candidates yet, so this draft uses the best available local signal moments."
  );
}

function isUserReviewedDraft(draft = {}) {
  return draft.workflow?.status === "user-reviewed" ||
    draft.workflow?.stage === "user-reviewed" ||
    (draft.segments || []).some((segment) => /human-reviewed|user-reviewed/i.test(String(segment.source || "")));
}

function buildUserReviewedPlan(draft, files, targetDuration) {
  const fileById = new Map(files.map((file) => [file.id, file]));
  const segments = (draft.segments || [])
    .map((segment) => {
      const file = fileById.get(String(segment.fileId || ""));
      if (!file?.metadata?.duration) return null;
      const sourceDuration = Math.max(1, Number(file.metadata.duration) || 1);
      const start = Math.max(0, Math.min(sourceDuration - 1, Number(segment.start) || 0));
      const duration = Math.max(1, Math.min(sourceDuration - start, Number(segment.duration) || 0));
      if (duration < 1) return null;
      return {
        fileId: file.id,
        start: Math.round(start * 100) / 100,
        duration: Math.round(duration * 100) / 100,
        minDuration: Math.round(duration * 100) / 100,
        score: Math.round(Number(segment.score) || Number(file.metadata.semanticScore) || Number(file.metadata.indexScore) || 80),
        storyRole: segment.storyRole || "approved highlight",
        source: "human-reviewed",
        confidence: "high"
      };
    })
    .filter(Boolean);
  const duration = Math.round(segments.reduce((sum, segment) => sum + Number(segment.duration || 0), 0) * 10) / 10;
  const requestedDuration = Math.min(MAX_DURATION, Math.max(1, Number(targetDuration) || duration || 1));
  const uniqueFiles = new Set(segments.map((segment) => segment.fileId));
  return {
    segments,
    duration,
    workflow: {
      ...(draft.workflow || {}),
      version: 1,
      status: "user-reviewed",
      stage: "user-reviewed",
      lockedReviewedCuts: true,
      requestedDuration,
      selectedMoments: segments.length,
      rejectedMoments: Number(draft.workflow?.rejectedMoments || 0),
      sourceVideosUsed: uniqueFiles.size,
      specialists: {
        action: "User reviewed and approved these exact highlight periods.",
        boringFrames: "Trimmed user-reviewed cuts are locked for render.",
        story: "Generation uses the approved timeline without rebuilding from older candidates.",
        diversity: `${uniqueFiles.size} source video${uniqueFiles.size === 1 ? "" : "s"} represented.`
      },
      critique: {
        approved: segments.length > 0,
        score: segments.length ? 100 : 0,
        coverage: requestedDuration ? Math.round((duration / requestedDuration) * 100) : 100,
        duplicateIntervals: 0,
        payoffMoments: segments.length,
        lowConfidenceMoments: 0,
        action: "User-approved highlight periods are preserved.",
        boringFrames: "User trims override automatic timing.",
        story: "This timeline is ready because the user confirmed every selected part.",
        diversity: `${uniqueFiles.size} source video${uniqueFiles.size === 1 ? "" : "s"} represented.`
      },
      advice: "Using user-reviewed highlight periods exactly as confirmed."
    }
  };
}

function hasStrongSemanticSummary(file) {
  const metadata = file?.metadata || {};
  if (hasBoringSemanticEvidence(file)) return false;
  const rating = metadata.semanticRating || {};
  const traits = metadata.semanticTraits || {};
  const reject = String(rating.excludeReason || "none").toLowerCase();
  const hardRejects = new Set(["menu", "scoreboard", "map", "loading", "death", "boring_travel", "walking", "waiting", "weak_aim", "unreadable", "duplicate"]);
  if (hardRejects.has(reject)) return false;
  if (Number(rating.boredom || 0) >= 60) return false;
  if (Number(traits.clarity || 0) < 60 || Number(traits.obstruction || 0) > 50) return false;
  const text = `${traits.action || ""} ${metadata.semanticRejectReason || ""} ${(metadata.semanticTags || []).join(" ")}`.toLowerCase();
  const strongScore = Number(metadata.semanticScore || 0) >= 70
    || (Number(rating.trailerUsefulness || 0) >= 70 && (Number(traits.intensity || 0) >= 70 || Number(traits.spectacle || 0) >= 70));
  const decisiveText = /explosion|destroy|destruction|detonat|sniper|headshot|vehicle|air combat|shoot|shot|objective|capture|kill/i.test(text)
    && Number(traits.intensity || 0) >= 70;
  return strongScore || decisiveText || (traits.payoffVerified === true && Number(metadata.semanticScore || 0) >= 70);
}

function hasFinalSemanticReview(file) {
  const metadata = file?.metadata || {};
  if (metadata.semanticReviewLastError) return false;
  const attempts = Number(metadata.semanticReviewAttemptVersion || 0) === SEMANTIC_REVIEW_VERSION
    ? Number(metadata.semanticReviewAttempts || 0)
    : 0;
  return metadata.semanticFineReviewed === true || attempts >= MAX_SEMANTIC_REVIEW_ATTEMPTS;
}

function hasBoringSemanticEvidence(file) {
  const metadata = file?.metadata || {};
  if (!hasFinalSemanticReview(file) || hasVerifiedSemanticReview(file) || (metadata.confirmedHighlightMoments || []).length > 0) return false;
  const rating = metadata.semanticRating || {};
  const reject = String(rating.excludeReason || metadata.semanticRejectReason || "").toLowerCase();
  const hardRejects = new Set(["menu", "scoreboard", "map", "loading", "death", "unreadable", "duplicate"]);
  if (reject.split(/[^a-z_]+/).some((part) => hardRejects.has(part))) return true;
  const reason = String(metadata.semanticRejectReason || "").toLowerCase();
  if (/\b(menu|scoreboard|loading screen|map screen|death screen|unreadable|duplicate)\b/i.test(reason)) return true;
  return false;
}

function hasHardRenderRejectEvidence(file) {
  const metadata = file?.metadata || {};
  if ((metadata.confirmedHighlightMoments || []).length > 0 || hasVerifiedSemanticReview(file)) return false;
  if (hasBoringSemanticEvidence(file)) return true;
  const rating = metadata.semanticRating || {};
  const reject = String(rating.excludeReason || metadata.semanticRejectReason || "").toLowerCase();
  const reason = String(metadata.semanticRejectReason || "").toLowerCase();
  const hardRejects = new Set(["menu", "scoreboard", "map", "loading", "death", "walking", "waiting", "weak_aim", "unreadable", "duplicate"]);
  return reject.split(/[^a-z_]+/).some((part) => hardRejects.has(part)) ||
    /\b(menu|scoreboard|loading|map|death|walking|waiting|weak aim|unreadable|duplicate)\b/i.test(reason);
}

function hasUserAiOverride(file, overrideIds = new Set()) {
  return Boolean(file) && (overrideIds.has(String(file.id)) || file.metadata?.aiDecisionOverride === "include");
}

function withUserAiOverride(file, overrideIds = new Set()) {
  if (!hasUserAiOverride(file, overrideIds) || file.metadata?.aiDecision !== "rejected") return file;
  return {
    ...file,
    metadata: {
      ...file.metadata,
      aiDecisionOverride: "include",
      aiDecisionOverrideReason: "User selected this AI-flagged clip for generation."
    }
  };
}

function isGenerationEligibleFile(file, overrideIds = new Set()) {
  if (hasUserAiOverride(file, overrideIds)) return !hasHardRenderRejectEvidence(file);
  return file?.metadata?.aiDecision !== "rejected" && !hasBoringSemanticEvidence(file);
}

function hasRecoverableGameplaySignal(file) {
  const metadata = file?.metadata || {};
  if (!metadata.duration || metadata.videoCodec === "pending") return false;
  if (hasBoringSemanticEvidence(file)) return false;
  return Number(metadata.indexScore || 0) >= 30 || Number(metadata.actionScore || 0) >= 20;
}

function reliableFocusTime(file) {
  const metadata = file?.metadata || {};
  const semanticEvents = [...(metadata.semanticEvents || []), ...(metadata.semanticCandidateHistory || [])];
  const weakVisionMiss = Number(metadata.semanticFramesReviewed || 0) > 0 &&
    !semanticEvents.length &&
    (metadata.ratingConfidence === "low" || metadata.semanticQuality === "missed" || Number(metadata.semanticScore || 0) < 25);
  if (weakVisionMiss && Number.isFinite(Number(metadata.highlightStart))) return Number(metadata.highlightStart);
  return Number(metadata.semanticTopFrame ?? metadata.highlightStart ?? Number(metadata.duration || 0) * 0.55);
}

function metadataIntervalEnd(item) {
  const start = Number(item?.start) || 0;
  return Number(item?.end) || start + (Number(item?.duration) || 0);
}

function overlapsRejectedHighlight(metadata = {}, start = 0, end = start) {
  return (metadata.rejectedHighlightMoments || []).some((item) =>
    item?.reason === "not-highlight" &&
    Math.max(Number(item.start) || 0, start) < Math.min(metadataIntervalEnd(item), end) - 0.75
  );
}

function hasAutoUsableHighlightCandidate(file) {
  const metadata = file?.metadata || {};
  if (metadata.aiDecision === "rejected" || hasBoringSemanticEvidence(file)) return false;
  if (metadata.aiDecision === "confirmed") return true;
  if (hasVerifiedSemanticReview(file)) return true;
  if ((metadata.confirmedHighlightMoments || []).length > 0) return true;
  if ((metadata.semanticCandidateHistory || []).some((event) => Number(event?.score || 0) >= 64 && !overlapsRejectedHighlight(metadata, Number(event.start) || 0, Number(event.end) || Number(event.start) + Number(event.duration || 0)))) return true;
  if ((metadata.candidateWindows || []).some((window) => Number(window?.score || 0) >= 72 && !overlapsRejectedHighlight(metadata, Number(window.start) || 0, Number(window.end) || Number(window.start) + Number(window.duration || 0)))) return true;
  return hasStrongSemanticSummary(file) || hasRecoverableGameplaySignal(file);
}

function aiDecisionForFile(file) {
  const metadata = file?.metadata || {};
  if (!file || looksLikePreviousExport(file.name) || !metadata.duration || metadata.videoCodec === "pending") {
    return { decision: "pending", reason: "Waiting for source video analysis." };
  }
  if (hasBoringSemanticEvidence(file)) {
    return { decision: "rejected", reason: metadata.semanticRejectReason || "AI rejected this clip as low-signal gameplay without a visible payoff." };
  }
  if (hasVerifiedSemanticReview(file) || (metadata.confirmedHighlightMoments || []).length > 0) {
    return { decision: "confirmed", reason: "Vision AI confirmed a complete highlight payoff." };
  }
  const hasSemanticCandidate = (metadata.semanticCandidateHistory || []).some((event) =>
    Number(event?.score || 0) >= 64 &&
    !overlapsRejectedHighlight(metadata, Number(event.start) || 0, metadataIntervalEnd(event))
  );
  const hasIndexedCandidate = (metadata.candidateWindows || []).some((window) =>
    Number(window?.score || 0) >= 72 &&
    !overlapsRejectedHighlight(metadata, Number(window.start) || 0, metadataIntervalEnd(window))
  );
  if (hasSemanticCandidate || hasIndexedCandidate || hasStrongSemanticSummary(file)) {
    return { decision: "confirmed", reason: "AI ranker confirmed this clip has enough highlight evidence for generation." };
  }
  if (hasRecoverableGameplaySignal(file)) {
    return { decision: "confirmed", reason: "Local ranker kept this gameplay clip usable because Vision AI did not prove it was a non-highlight." };
  }
  if (hasFinalSemanticReview(file)) {
    return { decision: "low_confidence", reason: metadata.semanticRejectReason || "AI could not confirm a complete highlight after two checks." };
  }
  return { decision: "pending", reason: "Vision AI review is not finished." };
}

function normalizeAiDecisions(project) {
  let changed = false;
  const now = new Date().toISOString();
  for (const file of project.files || []) {
    if (!file.metadata) continue;
    const { decision, reason } = aiDecisionForFile(file);
    if (file.metadata.aiDecision !== decision || file.metadata.aiDecisionReason !== reason) {
      file.metadata.aiDecision = decision;
      file.metadata.aiDecisionReason = reason;
      file.metadata.aiDecisionUpdatedAt = now;
      changed = true;
    }
    if (decision === "rejected") {
      const before = JSON.stringify({
        semanticEvents: file.metadata.semanticEvents || [],
        semanticCandidateHistory: file.metadata.semanticCandidateHistory || [],
        candidateWindows: file.metadata.candidateWindows || [],
        semanticTags: file.metadata.semanticTags || [],
        indexTags: file.metadata.indexTags || [],
        indexDescription: file.metadata.indexDescription,
        recommendedForDraft: file.metadata.recommendedForDraft
      });
      file.metadata.semanticEvents = [];
      file.metadata.semanticCandidateHistory = [];
      file.metadata.candidateWindows = [];
      file.metadata.semanticTags = [];
      file.metadata.indexTags = [];
      file.metadata.indexDescription = `Rejected by AI: ${reason}`;
      file.metadata.recommendedForDraft = false;
      const after = JSON.stringify({
        semanticEvents: file.metadata.semanticEvents || [],
        semanticCandidateHistory: file.metadata.semanticCandidateHistory || [],
        candidateWindows: file.metadata.candidateWindows || [],
        semanticTags: file.metadata.semanticTags || [],
        indexTags: file.metadata.indexTags || [],
        indexDescription: file.metadata.indexDescription,
        recommendedForDraft: file.metadata.recommendedForDraft
      });
      if (before !== after) changed = true;
    } else if (/^Rejected by AI:/i.test(String(file.metadata.indexDescription || "")) || file.metadata.recommendedForDraft === false) {
      const before = JSON.stringify({
        indexDescription: file.metadata.indexDescription,
        recommendedForDraft: file.metadata.recommendedForDraft
      });
      file.metadata.indexDescription = file.metadata.semanticRejectReason
        ? `Low confidence: ${file.metadata.semanticRejectReason}`
        : file.metadata.indexDescription;
      file.metadata.recommendedForDraft = true;
      const after = JSON.stringify({
        indexDescription: file.metadata.indexDescription,
        recommendedForDraft: file.metadata.recommendedForDraft
      });
      if (before !== after) changed = true;
    }
  }
  return changed;
}

function buildAiCoverageReport(project) {
  normalizeAiDecisions(project);
  const sourceFiles = (project.files || []).filter((file) => !looksLikePreviousExport(file.name));
  const readyFiles = sourceFiles.filter((file) => Number(file.metadata?.duration || 0) > 0 && file.metadata?.videoCodec !== "pending");
  const verifiedFiles = readyFiles.filter(hasVerifiedSemanticReview);
  const autoUsableFiles = readyFiles.filter(hasAutoUsableHighlightCandidate);
  const rejectedFiles = readyFiles.filter((file) => file.metadata?.aiDecision === "rejected" || hasBoringSemanticEvidence(file));
  const highlightEligibleFiles = readyFiles.filter((file) => !rejectedFiles.includes(file));
  const exhaustedFiles = readyFiles.filter((file) =>
    !hasVerifiedSemanticReview(file) &&
    Number(file.metadata?.semanticReviewAttemptVersion || 0) === SEMANTIC_REVIEW_VERSION &&
    Number(file.metadata?.semanticReviewAttempts || 0) >= MAX_SEMANTIC_REVIEW_ATTEMPTS &&
    !file.metadata?.semanticReviewLastError
  );
  const pendingFiles = readyFiles.filter((file) => needsSemanticPreprocess(file) || needsSemanticPreprocess(file, { refineReviewed: true }));
  const percent = (count, total = readyFiles.length) => total ? Math.round((count / total) * 1000) / 10 : 0;
  return {
    projectId: project.id,
    projectName: project.name,
    targetRate: 95,
    maxSemanticReviewAttempts: MAX_SEMANTIC_REVIEW_ATTEMPTS,
    defaultMaxVisionCheckSeconds: DEFAULT_MAX_VISION_CHECK_SECONDS,
    sourceVideos: sourceFiles.length,
    readyVideos: readyFiles.length,
    strictVerifiedVideos: verifiedFiles.length,
    strictVerifiedRate: percent(verifiedFiles.length),
    aiVerifiedVideos: autoUsableFiles.length,
    aiVerifiedRate: percent(autoUsableFiles.length, readyFiles.length),
    autoUsableVideos: autoUsableFiles.length,
    autoUsableRate: percent(autoUsableFiles.length, readyFiles.length),
    eligibleAiVerifiedRate: percent(autoUsableFiles.length, highlightEligibleFiles.length),
    eligibleAutoUsableRate: percent(autoUsableFiles.length, highlightEligibleFiles.length),
    highlightEligibleVideos: highlightEligibleFiles.length,
    rejectedLowSignalVideos: rejectedFiles.length,
    pendingReviewVideos: pendingFiles.length,
    exhaustedUnverifiedVideos: exhaustedFiles.length,
    missingAutoUsableVideos: readyFiles.length - autoUsableFiles.length,
    attemptBreakdown: [0, 1, 2].map((attempts) => ({
      attempts,
      videos: readyFiles.filter((file) => semanticReviewAttempts(file) === attempts).length
    })),
    missingAutoUsableExamples: readyFiles
      .filter((file) => !hasAutoUsableHighlightCandidate(file))
      .slice(0, 12)
      .map((file) => ({
        id: file.id,
        name: file.name,
        semanticScore: Number(file.metadata?.semanticScore || 0),
        indexScore: Number(file.metadata?.indexScore || 0),
        attempts: semanticReviewAttempts(file),
        reason: file.metadata?.semanticRejectReason || file.metadata?.semanticRating?.excludeReason || "No strong candidate evidence"
      }))
  };
}

app.post("/api/projects/:id/drafts", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.id);
    const idea = req.body.idea;
    const excludedIntervals = Array.isArray(idea.excludedIntervals) ? idea.excludedIntervals : [];
    const selectedIds = Array.isArray(idea.fileIds) ? [...new Set(idea.fileIds.map(String))] : [];
    const selectedDraftFiles = selectedIds.length
      ? project.files.filter((file) => selectedIds.includes(file.id))
      : project.files;
    if (selectedIds.length && selectedDraftFiles.length !== selectedIds.length) {
      return res.status(400).json({ error: structuredError("Some selected videos were not found", "The project changed before the draft was created.", "Refresh the project and try again.", true) });
    }
    const userOverrideIds = new Set(selectedIds);
    const draftFiles = selectedDraftFiles.filter((file) => isGenerationEligibleFile(file, userOverrideIds));
    if (!draftFiles.length) {
      return res.status(409).json({ error: structuredError("No usable clips selected", "The selected clips have hard reject evidence such as menu, loading, death screen, unreadable footage, or duplicate exports.", "Choose different clips, or review the flagged clip and confirm a specific highlight period.", true) });
    }
    const notReady = draftFiles.filter((file) => !hasUsableMetadata(file));
    if (notReady.length) {
      return res.status(409).json({ error: structuredError("Videos are still being analyzed", `${notReady.length} selected video${notReady.length === 1 ? " is" : "s are"} not ready yet.`, "Wait for background folder analysis to finish, then create the trailer.", true) });
    }
    const planningFiles = draftFiles.map((file) => withUserAiOverride(file, userOverrideIds));
    const overriddenRejectedFiles = draftFiles.filter((file) => userOverrideIds.has(String(file.id)) && file.metadata?.aiDecision === "rejected");
    const adaptiveDuration = idea.style === "Trailer"
      ? recommendTrailerDuration(planningFiles, idea.durationMode === "fixed" ? idea.duration : 0)
      : Math.min(MAX_DURATION, idea.duration);
    const planned = idea.style === "Trailer"
      ? buildAutoHighlightPlan(planningFiles, adaptiveDuration, {
          gameGenre: project.gameProfile?.genre || inferGameProfile(project).genre,
          intensity: idea.intensity ?? 78,
          excludedIntervals
        })
      : createSegments(planningFiles, adaptiveDuration, idea.intensity ?? 78);
    const { segments, duration } = planned;
    const draft = {
      ...idea,
      fileIds: draftFiles.map((file) => file.id),
      ...(overriddenRejectedFiles.length ? { userOverrideFileIds: overriddenRejectedFiles.map((file) => file.id) } : {}),
      id: randomUUID(),
      duration,
      segments,
      version: project.drafts.length + 1,
      music: idea.music ?? (idea.style === "Trailer" ? "Choose soundtrack before render" : "Game audio"),
      captionStyle: idea.captionStyle ?? "Clean impact",
      intensity: idea.intensity ?? 78,
      changes: idea.style === "Trailer"
        ? [
            "Auto Highlight Ranker selected the strongest available moments",
            "Verified moments are prioritized before uncertain candidates",
            "Manual review is optional for improving low-confidence picks",
            ...(overriddenRejectedFiles.length ? [`User overrode AI red flags for ${overriddenRejectedFiles.length} selected clip${overriddenRejectedFiles.length === 1 ? "" : "s"}`] : [])
          ]
        : ["Real footage segments selected", "Professional style preset applied", "Audio normalized", ...(overriddenRejectedFiles.length ? [`User overrode AI red flags for ${overriddenRejectedFiles.length} selected clip${overriddenRejectedFiles.length === 1 ? "" : "s"}`] : [])],
      workflow: planned.workflow,
      status: "ready"
    };
    project.drafts.push(draft);
    await saveProject(project);
    res.json(draft);
  } catch (error) { next(error); }
});

app.post("/api/projects/:id/vision-review", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.id);
    const reviews = Array.isArray(req.body.reviews) ? req.body.reviews : [];
    for (const review of reviews) {
      const file = project.files.find((item) => item.id === review.fileId);
      if (!file) continue;
      const reviewedEvents = (Array.isArray(review.events) ? review.events : [])
        .map((event) => {
          const start = Math.max(0, Math.min(Number(file.metadata?.duration) || 0, Number(event.start) || 0));
          const end = Math.max(start, Math.min(Number(file.metadata?.duration) || start, Number(event.end) || start));
          return {
            start: Math.round(start * 10) / 10,
            end: Math.round(end * 10) / 10,
            score: Math.max(0, Math.min(100, Number(event.score) || Number(review.score) || 0)),
            state: String(event.state || "combat").slice(0, 40),
            action: String(event.action || review.reason || "reviewed gameplay event").slice(0, 160),
            payoffStage: String(event.payoffStage || "impact").slice(0, 40),
            storyRole: String(event.storyRole || "payoff").slice(0, 40),
            cutRisk: String(event.cutRisk || "medium").slice(0, 20),
            payoffVerified: Boolean(event.payoffVerified),
            reviewProvider: String(event.reviewProvider || "external-visual-agent").slice(0, 80)
          };
        })
        .filter((event) => event.end - event.start >= 3.5)
        .sort((a, b) => a.start - b.start)
        .slice(0, 12);
      Object.assign(file.metadata, {
        visionApproved: Boolean(review.approved),
        visionScore: Math.max(0, Math.min(100, Number(review.score) || 0)),
        visionReason: String(review.reason || "").slice(0, 240),
        visionTraits: {
          subject: String(review.traits?.subject || "character"),
          shotScale: String(review.traits?.shotScale || "medium"),
          environment: String(review.traits?.environment || "unknown"),
          intensity: Math.max(0, Math.min(100, Number(review.traits?.intensity) || 50)),
          spectacle: Math.max(0, Math.min(100, Number(review.traits?.spectacle) || 50)),
          clarity: Math.max(0, Math.min(100, Number(review.traits?.clarity) || 50)),
          obstruction: Math.max(0, Math.min(100, Number(review.traits?.obstruction) || 0))
        },
        ...(Array.isArray(review.events) ? {
          semanticEvents: reviewedEvents,
          semanticScore: reviewedEvents.length
            ? Math.max(...reviewedEvents.map((event) => event.score))
            : Math.min(40, Number(file.metadata?.semanticScore) || 40),
          semanticFramesReviewed: Math.max(18, Number(file.metadata?.semanticFramesReviewed) || 0),
          semanticFineReviewed: true,
          semanticIndexJobId: `external-review-${Date.now()}`
        } : {})
      });
    }
    project.analysis = buildAnalysis(project.files);
    await saveProject(project);
    res.json(project);
  } catch (error) { next(error); }
});

app.post("/api/projects/:id/vision-review/run", async (req, res, next) => {
  const tempDir = path.join(visionWorkRoot, randomUUID());
  try {
    const { endpoint, apiKey, model, referenceStyle } = req.body;
    if (!endpoint || !model) return res.status(400).json({ error: structuredError("Vision model not configured", "Configure an OpenAI-compatible multimodal endpoint and model.", "For local processing, run a vision-capable model through Ollama or LM Studio.", true) });
    const safeEndpoint = new URL(endpoint);
    if (!["https:", "http:"].includes(safeEndpoint.protocol)) return res.status(400).json({ error: structuredError("Unsupported AI endpoint", "Only HTTP and HTTPS endpoints are supported.", "Check the endpoint in Settings.", true) });
    const project = await loadProject(req.params.id);
    const candidates = [...project.files].sort((a, b) => (b.metadata.actionScore || 0) - (a.metadata.actionScore || 0)).slice(0, Math.min(40, Number(req.body.maxCandidates) || 24));
    await mkdir(tempDir, { recursive: true });
    for (let index = 0; index < candidates.length; index += 1) {
      const file = candidates[index];
      const frame = path.join(tempDir, `${index}.jpg`);
      await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(file.metadata.highlightStart || 0), "-i", file.path, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "3", frame]);
      const image = (await readFile(frame)).toString("base64");
      const response = await fetch(safeEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: `Review this gameplay frame for a professional game trailer. Reference style: ${referenceStyle || "cinematic, readable action, escalating spectacle"}. Return only JSON: {"approved":boolean,"score":0-100,"reason":"short","traits":{"subject":"character|vehicle|aircraft|environment|other","shotScale":"close|medium|wide|long","environment":"short label","intensity":0-100,"spectacle":0-100,"clarity":0-100,"obstruction":0-100}}. Reject menus, maps, loading screens, death states, extreme HUD obstruction, and unreadable frames.` },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }
            ]
          }],
          temperature: 0.1
        })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error?.message || "Vision model request failed.");
      const content = json.choices?.[0]?.message?.content || "{}";
      const review = JSON.parse(String(content).replace(/^```json\s*|\s*```$/g, ""));
      Object.assign(file.metadata, {
        visionApproved: Boolean(review.approved),
        visionScore: Math.max(0, Math.min(100, Number(review.score) || 0)),
        visionReason: String(review.reason || "").slice(0, 240),
        visionTraits: review.traits || {}
      });
    }
    project.analysis = buildAnalysis(project.files);
    await saveProject(project);
    res.json({ project, reviewed: candidates.length, approved: candidates.filter((file) => file.metadata.visionApproved).length });
  } catch (error) { next(error); } finally { await rm(tempDir, { recursive: true, force: true }).catch(() => undefined); }
});

app.post("/api/ai-model/status", async (req, res, next) => {
  try {
    const { endpoint, apiKey, model } = req.body;
    if (!endpoint || !model) return res.status(400).json({ error: structuredError("AI model not configured", "Add an OpenAI-compatible endpoint and model first.", "For local vision, use Ollama or another server with any vision-capable OpenAI-compatible model.", true) });
    const safeEndpoint = new URL(endpoint);
    if (!["https:", "http:"].includes(safeEndpoint.protocol)) return res.status(400).json({ error: structuredError("Unsupported AI endpoint", "Only HTTP and HTTPS endpoints are supported.", "Check the endpoint in Settings.", true) });
    const started = Date.now();
    const localOllama = ["127.0.0.1", "localhost"].includes(safeEndpoint.hostname)
      && safeEndpoint.port === "11434";
    if (localOllama) {
      let response;
      try {
        response = await fetch(`${safeEndpoint.protocol}//${safeEndpoint.host}/api/tags`, {
          signal: AbortSignal.timeout(3_000)
        });
      } catch {
        return res.status(503).json({ error: structuredError(
          "Ollama is not running",
          `HighlightAI could not reach ${safeEndpoint.host}.`,
          "Open the Ollama desktop app or run \"ollama serve\", then choose Check again in HighlightAI.",
          true
        ) });
      }
      const body = await response.json().catch(() => ({}));
      const installedModels = Array.isArray(body.models)
        ? body.models.map((item) => String(item.name || item.model || ""))
        : [];
      if (!response.ok || !installedModels.includes(model)) {
        return res.status(502).json({ error: structuredError(
          "Vision model is not installed",
          `Ollama is running, but "${model}" is not available locally.`,
          `Install it with "ollama pull ${model}", then test the connection again.`,
          true
        ) });
      }
      return res.json({ ok: true, latencyMs: Date.now() - started, model });
    }
    let response;
    try {
      response = await fetch(safeEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with JSON only: {\"ok\":true}" }],
          temperature: 0
        })
      });
    } catch (error) {
      return res.status(503).json({ error: structuredError(
        error?.name === "TimeoutError" ? "AI model test timed out" : "AI service is not running",
        error?.name === "TimeoutError"
          ? `${safeEndpoint.host} did not respond within 10 seconds.`
          : `HighlightAI could not reach ${safeEndpoint.host}.`,
        "Start Ollama or your configured AI server yourself, then test the connection again.",
        true
      ) });
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(502).json({ error: structuredError(
        "AI model is unavailable",
        body.error?.message || `The configured model "${model}" did not respond.`,
        safeEndpoint.hostname === "127.0.0.1" || safeEndpoint.hostname === "localhost"
          ? `Install it with "ollama pull ${model}", then test the connection again.`
          : "Check the provider model name and API access, then retry.",
        true
      ) });
    }
    res.json({ ok: true, latencyMs: Date.now() - started, model });
  } catch (error) { next(error); }
});

app.post("/api/projects/:id/preprocess/estimate", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.id);
    const estimate = estimatePreprocess(project, req.body);
    res.json(estimate);
  } catch (error) { next(error); }
});

app.post("/api/projects/:id/fast-index/estimate", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.id);
    res.json(estimateFastIndex(project, req.body));
  } catch (error) { next(error); }
});

app.post("/api/projects/:id/fast-index/run", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.id);
    const job = await createFastIndexJob(project, req.body);
    res.status(202).json(publicFastIndexJob(job));
    processFastIndexJob(job.id).catch((error) => void markFastIndexJobFailed(job.id, error));
  } catch (error) { next(error); }
});

app.get("/api/fast-index-jobs/:id", async (req, res, next) => {
  try { res.json(publicFastIndexJob(await loadFastIndexJob(req.params.id))); } catch (error) { next(error); }
});

app.post("/api/fast-index-jobs/:id/cancel", async (req, res, next) => {
  try {
    const job = await loadFastIndexJob(req.params.id);
    job.cancelRequested = true;
    job.status = "cancelled";
    job.phase = "cancelled";
    job.currentFile = null;
    await saveFastIndexJob(job);
    await updateProjectFastIndexState(job.projectId, job.id, "cancelled", "cancelled");
    res.json(publicFastIndexJob(job));
  } catch (error) { next(error); }
});

app.post("/api/fast-index-jobs/:id/pause", async (req, res, next) => {
  try {
    const job = await loadFastIndexJob(req.params.id);
    if (job.status !== "processing") return res.json(publicFastIndexJob(job));
    job.status = "paused";
    job.phase = "paused";
    job.currentFile = null;
    job.activeFiles = [];
    activeFastIndexControllers.get(job.id)?.abort();
    await saveFastIndexJob(job);
    await updateProjectFastIndexState(job.projectId, job.id, "paused", "paused");
    res.json(publicFastIndexJob(job));
  } catch (error) { next(error); }
});

app.post("/api/fast-index-jobs/:id/resume", async (req, res, next) => {
  try {
    const job = await loadFastIndexJob(req.params.id);
    if (job.status !== "paused") return res.json(publicFastIndexJob(job));
    job.status = "processing";
    job.phase = "scanning";
    await saveFastIndexJob(job);
    await updateProjectFastIndexState(job.projectId, job.id, "processing", "scanning");
    res.json(publicFastIndexJob(job));
    processFastIndexJob(job.id).catch((error) => void markFastIndexJobFailed(job.id, error));
  } catch (error) { next(error); }
});

app.post("/api/projects/:id/preprocess/run", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.id);
    const activeJobId = activePreprocessJobs.get(project.id);
    if (activeJobId) {
      const activeJob = await loadPreprocessJob(activeJobId).catch(() => null);
      if (activeJob && activeJob.status === "processing") return res.status(202).json(publicPreprocessJob(activeJob));
      activePreprocessJobs.delete(project.id);
    }
    const { endpoint, apiKey, model } = req.body;
    if (!endpoint || !model) return res.status(400).json({ error: structuredError("Vision model not configured", "Configure an OpenAI-compatible multimodal endpoint and model.", "For local processing, run a vision-capable model through Ollama or LM Studio.", true) });
    const safeEndpoint = new URL(endpoint);
    if (!["https:", "http:"].includes(safeEndpoint.protocol)) return res.status(400).json({ error: structuredError("Unsupported AI endpoint", "Only HTTP and HTTPS endpoints are supported.", "Check the endpoint in Settings.", true) });
    const estimate = estimatePreprocess(project, req.body);
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      kind: "semantic-preprocess",
      projectId: project.id,
      status: "processing",
      phase: "extracting_frames",
      totalFiles: estimate.files,
      totalProjectFiles: project.files.length,
      processedFiles: 0,
      totalFrames: estimate.frames,
      processedFrames: 0,
      totalRequests: estimate.modelRequests,
      processedRequests: 0,
      approvedFrames: 0,
      rejectedFrames: 0,
      eventsFound: 0,
      currentFile: null,
      currentFrameTime: null,
      failures: [],
      sampleInterval: estimate.sampleInterval,
      maxFiles: Number(req.body.maxFiles) || 0,
      maxFrames: Number(req.body.maxFrames) || 0,
      maxRuntimeSeconds: Math.max(30, Math.min(6 * 60 * 60, Number(req.body.maxRuntimeSeconds) || DEFAULT_MAX_VISION_CHECK_SECONDS)),
      refineReviewed: req.body.refineReviewed === true,
      fileIds: Array.isArray(req.body.fileIds) ? req.body.fileIds.map(String) : null,
      estimatedSeconds: estimate.estimatedSeconds,
      etaSeconds: estimate.estimatedSeconds,
      storageBytes: estimate.storageBytes,
      concurrency: estimate.concurrency,
      model,
      referenceStyle: String(req.body.referenceStyle || "high quality gameplay highlight with readable action").slice(0, 500),
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      cancelRequested: false,
      result: null,
      endpoint: safeEndpoint.toString()
    };
    preprocessSecrets.set(job.id, { apiKey: apiKey || "" });
    activePreprocessJobs.set(project.id, job.id);
    await savePreprocessJob(job);
    res.status(202).json(publicPreprocessJob(job));
    processPreprocessJob(job.id).catch((error) => void markPreprocessJobFailed(job.id, error));
  } catch (error) { next(error); }
});

app.get("/api/preprocess-jobs/:id", async (req, res, next) => {
  try { res.json(publicPreprocessJob(await loadPreprocessJob(req.params.id))); } catch (error) { next(error); }
});

app.post("/api/preprocess-jobs/:id/cancel", async (req, res, next) => {
  try {
    const job = await loadPreprocessJob(req.params.id);
    job.cancelRequested = true;
    job.status = "cancelled";
    job.phase = "cancelled";
    job.currentFile = null;
    job.activeFiles = [];
    activePreprocessControllers.get(job.id)?.abort();
    preprocessSecrets.delete(job.id);
    await savePreprocessJob(job);
    res.json(publicPreprocessJob(job));
  } catch (error) { next(error); }
});

app.post("/api/preprocess-jobs/:id/pause", async (req, res, next) => {
  try {
    const job = await loadPreprocessJob(req.params.id);
    if (job.status !== "processing") return res.json(publicPreprocessJob(job));
    job.status = "paused";
    job.phase = "paused";
    job.currentFile = null;
    job.currentFrameTime = null;
    job.activeFiles = [];
    activePreprocessControllers.get(job.id)?.abort();
    await savePreprocessJob(job);
    res.json(publicPreprocessJob(job));
  } catch (error) { next(error); }
});

app.post("/api/preprocess-jobs/:id/resume", async (req, res, next) => {
  try {
    const job = await loadPreprocessJob(req.params.id);
    if (!["paused", "failed"].includes(job.status) || (job.status === "failed" && !isInterruptedPreprocessJob(job))) {
      return res.json(publicPreprocessJob(job));
    }
    job.status = "processing";
    job.phase = "extracting_frames";
    job.cancelRequested = false;
    job.currentFile = null;
    job.currentFrameTime = null;
    job.activeFiles = [];
    if (isInterruptedPreprocessJob(job)) {
      job.failures = (job.failures || []).filter((failure) => !isInterruptedPreprocessFailure(failure));
    }
    await savePreprocessJob(job);
    res.json(publicPreprocessJob(job));
    processPreprocessJob(job.id).catch((error) => void markPreprocessJobFailed(job.id, error));
  } catch (error) { next(error); }
});

app.patch("/api/projects/:projectId/drafts/:draftId", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.projectId);
    const index = project.drafts.findIndex((draft) => draft.id === req.params.draftId);
    if (index < 0) return res.status(404).json({ error: "Draft not found" });
    const current = project.drafts[index];
    if (Array.isArray(req.body?.segments)) {
      const fileById = new Map(project.files.map((file) => [file.id, file]));
      const segments = req.body.segments.map((segment) => {
        const file = fileById.get(String(segment.fileId || ""));
        if (!file?.metadata?.duration) return null;
        const fileDuration = Math.max(1, Number(file.metadata.duration) || 1);
        const start = Math.max(0, Math.min(fileDuration - 1, Number(segment.start) || 0));
        const duration = Math.max(1, Math.min(fileDuration - start, Number(segment.duration) || 0));
        if (duration < 1) return null;
        return {
          fileId: file.id,
          start: Math.round(start * 10) / 10,
          duration: Math.round(duration * 10) / 10,
          minDuration: Math.min(Math.round(duration * 10) / 10, Math.max(1, Number(segment.minDuration) || 1)),
          score: Math.round(Number(segment.score) || Number(file.metadata.semanticScore) || Number(file.metadata.indexScore) || 70),
          storyRole: String(segment.storyRole || "approved highlight"),
          source: String(segment.source || "human-reviewed"),
          confidence: ["high", "medium", "low"].includes(String(segment.confidence)) ? String(segment.confidence) : "high"
        };
      }).filter(Boolean);
      if (!segments.length) {
        return res.status(400).json({ error: structuredError(
          "No approved video parts",
          "Agree to at least one planned part before generating.",
          "Review the planned cuts, approve the strong parts, then generate again.",
          true
        ) });
      }
      const duration = Math.round(segments.reduce((sum, segment) => sum + Math.max(0, Number(segment.duration) || 0), 0) * 10) / 10;
      const explicitFileIds = [...new Set(segments.map((segment) => segment.fileId))];
      const reviewedFileIds = new Set([
        ...explicitFileIds,
        ...(Array.isArray(req.body.reviewedFileIds) ? req.body.reviewedFileIds.map(String) : [])
      ]);
      const reviewedAt = new Date().toISOString();
      for (const file of project.files) {
        if (reviewedFileIds.has(file.id) && file.metadata) {
          file.metadata.reviewed = true;
          file.metadata.reviewedAt = reviewedAt;
        }
      }
      const nextDraft = {
        ...current,
        ...req.body,
        fileIds: explicitFileIds,
        segments,
        duration,
        status: "ready",
        version: Number(current.version || 1) + 1,
        changes: Array.isArray(req.body.changes)
          ? req.body.changes
          : [...(current.changes || []), "User reviewed and approved planned cuts before rendering"],
        workflow: {
          ...(current.workflow || {}),
          status: "user-reviewed",
          stage: "user-reviewed",
          selectedMoments: segments.length,
          sourceVideosUsed: explicitFileIds.length,
          requestedDuration: duration
        }
      };
      delete nextDraft.exportUrl;
      delete nextDraft.exportPath;
      delete nextDraft.review;
      delete nextDraft.encoding;
      delete nextDraft.musicPlan;
      delete nextDraft.musicDuration;
      project.drafts[index] = nextDraft;
      await saveProject(project);
      return res.json(nextDraft);
    }
    const selectedIds = new Set((current.fileIds || []).map(String));
    const draftFiles = selectedIds.size ? project.files.filter((file) => selectedIds.has(file.id)) : project.files;
    const nextDraft = refineDraftPlan(current, draftFiles, req.body);
    project.drafts[index] = nextDraft;
    await saveProject(project);
    res.json(nextDraft);
  } catch (error) { next(error); }
});

app.post("/api/projects/:projectId/drafts/:draftId/render", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.projectId);
    const draft = project.drafts.find((item) => item.id === req.params.draftId);
    if (!draft) return res.status(404).json({ error: "Draft not found" });
    const existingJob = await findActiveRenderJob(project.id, draft.id, draft.version);
    if (existingJob) return res.status(202).json(existingJob);
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      kind: "render",
      projectId: project.id,
      draftId: draft.id,
      draftVersion: draft.version,
      assetId: req.body.assetId || null,
      musicRepeats: Math.max(1, Math.min(2, Math.round(Number(req.body.musicRepeats) || 1))),
      status: "queued",
      phase: "queued",
      progress: 0,
      message: "Waiting to render",
      createdAt: now,
      updatedAt: now
    };
    const reviewProvider = req.body.reviewProvider || {};
    if (reviewProvider.endpoint && reviewProvider.model) {
      const safeReviewEndpoint = new URL(reviewProvider.endpoint);
      if (!["https:", "http:"].includes(safeReviewEndpoint.protocol)) {
        return res.status(400).json({ error: structuredError("Unsupported review endpoint", "The Vision review endpoint must use HTTP or HTTPS.", "Check AI Settings and try again.", true) });
      }
      job.reviewProvider = { endpoint: safeReviewEndpoint.toString(), model: String(reviewProvider.model) };
      renderReviewSecrets.set(job.id, { apiKey: String(reviewProvider.apiKey || "") });
    }
    draft.status = "rendering";
    await saveProject(project);
    await saveRenderJob(job);
    res.status(202).json(publicRenderJob(job));
    processRenderJob(job.id).catch((error) => void markRenderJobFailed(job.id, error));
  } catch (error) { next(error); }
});

app.get("/api/render-jobs/:id", async (req, res, next) => {
  try { res.json(publicRenderJob(await loadRenderJob(req.params.id))); } catch (error) { next(error); }
});

app.post("/api/render-jobs/:id/cancel", async (req, res, next) => {
  try {
    const job = await loadRenderJob(req.params.id);
    if (["completed", "failed", "cancelled"].includes(job.status)) return res.json(publicRenderJob(job));
    job.cancelRequested = true;
    job.status = "cancelled";
    job.phase = "cancelled";
    job.message = "Render cancelled";
    await saveRenderJob(job);
    activeRenderControllers.get(job.id)?.abort();
    renderReviewSecrets.delete(job.id);
    const project = await loadProject(job.projectId);
    const draft = project.drafts.find((item) => item.id === job.draftId);
    if (draft) {
      draft.status = "ready";
      await saveProject(project);
    }
    res.json(publicRenderJob(job));
  } catch (error) { next(error); }
});

app.post("/api/render-jobs/:id/pause", async (req, res, next) => {
  try {
    const job = await loadRenderJob(req.params.id);
    if (!["queued", "processing"].includes(job.status)) return res.json(publicRenderJob(job));
    job.status = "paused";
    job.phase = "paused";
    job.message = "Render paused. Resume restarts encoding from the saved draft.";
    activeRenderControllers.get(job.id)?.abort();
    await saveRenderJob(job);
    res.json(publicRenderJob(job));
  } catch (error) { next(error); }
});

app.post("/api/render-jobs/:id/resume", async (req, res, next) => {
  try {
    const job = await loadRenderJob(req.params.id);
    if (job.status !== "paused") return res.json(publicRenderJob(job));
    job.status = "queued";
    job.phase = "queued";
    job.progress = 0;
    job.message = "Render queued to resume";
    await saveRenderJob(job);
    res.json(publicRenderJob(job));
    processRenderJob(job.id).catch((error) => void markRenderJobFailed(job.id, error));
  } catch (error) { next(error); }
});

app.post("/api/projects/:projectId/drafts/:draftId/review", async (req, res, next) => {
  try {
    const { endpoint, apiKey, model } = req.body;
    if (!endpoint || !model) return res.status(400).json({ error: structuredError("AI reviewer not configured", "Add an OpenAI-compatible vision endpoint and model first.", "Use any vision-capable OpenAI-compatible model. For local Ollama, choose Light review mode when RAM or VRAM is limited.", true) });
    const project = await loadProject(req.params.projectId);
    const draft = project.drafts.find((item) => item.id === req.params.draftId);
    if (!draft?.exportUrl) return res.status(400).json({ error: structuredError("Draft is not rendered", "Render the MP4 before asking the review team to score it.", "Click Render MP4, then run review again.", true) });
    const outputPath = path.join(exportsRoot, path.basename(draft.exportUrl));
    const review = await reviewRenderedDraftWithModel({ endpoint, apiKey, model, outputPath, draft });
    draft.review = review;
    draft.changes = [
      ...(draft.changes || []),
      review.averageScore >= 90
        ? `Review team approved the draft at ${review.averageScore}/100.`
        : `Review team scored ${review.averageScore}/100; revise: ${review.revisionPlan.slice(0, 120)}`
    ].slice(-8);
    await saveProject(project);
    res.json({ draftId: draft.id, review });
  } catch (error) { next(error); }
});

app.post("/api/projects/:id/ai-advice", async (req, res, next) => {
  try {
    const { endpoint, apiKey, model, prompt } = req.body;
    if (!endpoint || !model) return res.status(400).json({ error: "Configure an OpenAI-compatible endpoint and model first." });
    const project = await loadProject(req.params.id);
    const safeEndpoint = new URL(endpoint);
    if (!["https:", "http:"].includes(safeEndpoint.protocol)) return res.status(400).json({ error: "Unsupported AI endpoint protocol." });
    const summary = project.files.map((file) => ({
      name: file.name,
      duration: file.metadata.duration,
      resolution: `${file.metadata.width}x${file.metadata.height}`,
      fps: file.metadata.fps,
      hasAudio: file.metadata.hasAudio,
      qualityScore: file.metadata.qualityScore
    }));
    const response = await fetch(safeEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a concise gaming highlight creative director. Recommend a video under 5 minutes. Never claim to have seen frames; use only supplied metadata." },
          { role: "user", content: `Footage metadata: ${JSON.stringify(summary)}\nUser request: ${prompt || "Give general advice."}` }
        ],
        temperature: 0.6
      })
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error?.message || "Advanced AI provider request failed.");
    res.json({ advice: json.choices?.[0]?.message?.content || "No advice returned." });
  } catch (error) { next(error); }
});

app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/") && !req.path.startsWith("/media/")) {
    return res.sendFile(path.join(root, "dist", "index.html"));
  }
  next();
});
app.use((error, _, res, __) => {
  console.error(error);
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: structuredError("Video is too large", "One video exceeds the 30 GB per-file limit.", "Remove that file or create a smaller recording.", true) });
  }
  if (error?.code === "ENOSPC") {
    return res.status(507).json({ error: structuredError("Not enough disk space", "HighlightAI could not finish copying the selected footage.", "Free disk space, then retry. Files copied before the error are preserved.", true, error.message) });
  }
  res.status(500).json({ error: structuredError("Local processing error", "HighlightAI could not finish that step.", "Please try again. If it repeats, restart the app and run it again.", true, error?.message || String(error || "")) });
});

async function saveProject(project) {
  await preserveMonotonicSemanticMetadata(project);
  project.updatedAt = new Date().toISOString();
  await saveJson(projectFile(project.id), project);
}

async function preserveMonotonicSemanticMetadata(project) {
  try {
    const existing = await loadJson(projectFile(project.id));
    const existingById = new Map((existing.files || []).map((file) => [file.id, file]));
    for (const file of project.files || []) {
      const previous = existingById.get(file.id);
      if (!previous?.metadata || !file.metadata) continue;
      file.metadata = mergeSemanticMetadata(previous.metadata, file.metadata);
    }
  } catch {
    // New projects have no previous project file to merge.
  }
}

function mergeSemanticMetadata(previous = {}, next = {}) {
  const previousRank = semanticMetadataRank(previous);
  const nextRank = semanticMetadataRank(next);
  if (previousRank > nextRank) return { ...next, ...semanticMetadataSubset(previous) };
  if (previousRank < nextRank) return next;

  const previousReviewedAt = Date.parse(previous.semanticReviewedAt || "") || 0;
  const nextReviewedAt = Date.parse(next.semanticReviewedAt || "") || 0;
  const previousAttempts = Number(previous.semanticReviewAttempts || 0);
  const nextAttempts = Number(next.semanticReviewAttempts || 0);
  if (previousReviewedAt > nextReviewedAt || previousAttempts > nextAttempts) {
    return {
      ...next,
      ...semanticMetadataSubset(previous),
      semanticReviewAttempts: Math.max(previousAttempts, nextAttempts),
      semanticReviewAttemptVersion: Math.max(Number(previous.semanticReviewAttemptVersion || 0), Number(next.semanticReviewAttemptVersion || 0)),
      semanticReviewVersion: Math.max(Number(previous.semanticReviewVersion || 0), Number(next.semanticReviewVersion || 0))
    };
  }
  return {
    ...next,
    semanticReviewAttempts: Math.max(previousAttempts, nextAttempts),
    semanticReviewAttemptVersion: Math.max(Number(previous.semanticReviewAttemptVersion || 0), Number(next.semanticReviewAttemptVersion || 0)),
    semanticReviewVersion: Math.max(Number(previous.semanticReviewVersion || 0), Number(next.semanticReviewVersion || 0))
  };
}

function semanticMetadataSubset(metadata = {}) {
  const keys = [
    "semanticFramesReviewed",
    "semanticReviewVersion",
    "semanticReviewAttemptVersion",
    "semanticReviewAttempts",
    "semanticReviewedAt",
    "semanticScore",
    "semanticQuality",
    "semanticVerifiedEventCount",
    "semanticWeakCandidateCount",
    "semanticRating",
    "semanticTopFrame",
    "semanticRejectReason",
    "semanticTraits",
    "semanticTags",
    "semanticEvents",
    "semanticCandidateHistory",
    "confirmedHighlightMoments",
    "rejectedHighlightMoments",
    "reviewed",
    "reviewedAt",
    "aiDecision",
    "aiDecisionReason",
    "aiDecisionUpdatedAt",
    "semanticFineReviewed",
    "semanticIndexJobId",
    "semanticReviewLastError"
  ];
  const subset = {};
  for (const key of keys) {
    if (metadata[key] !== undefined) subset[key] = metadata[key];
  }
  if (metadata.semanticTags !== undefined) subset.indexTags = metadata.indexTags;
  return subset;
}

function semanticMetadataRank(metadata = {}) {
  if (metadata.aiDecision === "confirmed" || metadata.aiDecision === "rejected") return 5;
  if ((metadata.rejectedHighlightMoments || []).length > 0) return 5;
  if ((metadata.confirmedHighlightMoments || []).length > 0) return 5;
  const attempts = Number(metadata.semanticReviewAttemptVersion || 0) === SEMANTIC_REVIEW_VERSION
    ? Number(metadata.semanticReviewAttempts || 0)
    : 0;
  const verified = metadata.semanticQuality === "verified"
    || (metadata.semanticEvents || []).some((event) => event?.payoffVerified === true);
  if (verified) return 4;
  if (Number(metadata.semanticReviewVersion || 0) >= SEMANTIC_REVIEW_VERSION && attempts >= MAX_SEMANTIC_REVIEW_ATTEMPTS) return 3;
  if (Number(metadata.semanticReviewVersion || 0) >= SEMANTIC_REVIEW_VERSION && Number(metadata.semanticFramesReviewed || 0) > 0) return 2;
  if (Number(metadata.semanticReviewVersion || 0) >= SEMANTIC_REVIEW_VERSION && attempts > 0) return 1;
  return 0;
}

async function loadProject(id) {
  const project = await loadJson(projectFile(id));
  const before = (project.files || []).map((file) => `${file.id}:${file.metadata?.indexScore}:${file.metadata?.ratingSource}`).join("|");
  calibrateHighlightScores(project.files || []);
  const after = (project.files || []).map((file) => `${file.id}:${file.metadata?.indexScore}:${file.metadata?.ratingSource}`).join("|");
  for (const draft of project.drafts || []) {
    if (draft.exportUrl && !draft.exportPath) draft.exportPath = path.join(exportsRoot, path.basename(draft.exportUrl));
  }
  const profileMissing = !project.gameProfile;
  if (profileMissing) project.gameProfile = inferGameProfile(project);
  const decisionsChanged = normalizeAiDecisions(project);
  const reviewedFlagsChanged = migrateUserReviewedFlags(project);
  const assetDurationsChanged = await migrateAudioAssetDurations(project);
  if (before !== after || profileMissing || decisionsChanged || reviewedFlagsChanged || assetDurationsChanged) {
    project.analysis = buildAnalysis(project.files || []);
    await saveJson(projectFile(id), project);
  }
  return project;
}

async function migrateAudioAssetDurations(project) {
  let changed = false;
  for (const asset of project.assets || []) {
    if (Number(asset.duration) > 0 || !isAudioAssetName(asset.name) || !asset.path) continue;
    const duration = await audioAssetDuration(asset.path);
    if (duration) {
      asset.duration = duration;
      changed = true;
    }
  }
  return changed;
}

function isAudioAssetName(name = "") {
  return /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(String(name));
}

async function audioAssetDuration(filePath) {
  try {
    const info = await probe(filePath);
    const duration = Number(info.duration) || 0;
    return duration > 0 ? Math.round(duration * 10) / 10 : null;
  } catch {
    return null;
  }
}

function migrateUserReviewedFlags(project) {
  let changed = false;
  for (const file of project.files || []) {
    if (!file.metadata) continue;
    const confirmed = Array.isArray(file.metadata.confirmedHighlightMoments)
      ? file.metadata.confirmedHighlightMoments
      : [];
    const rejected = Array.isArray(file.metadata.rejectedHighlightMoments)
      ? file.metadata.rejectedHighlightMoments
      : [];
    if (!confirmed.length && !rejected.length) continue;
    if (file.metadata.reviewed !== true) {
      file.metadata.reviewed = true;
      changed = true;
    }
    if (!file.metadata.reviewedAt) {
      file.metadata.reviewedAt = latestUserReviewTimestamp([...confirmed, ...rejected], project.updatedAt || project.createdAt);
      changed = true;
    }
  }
  return changed;
}

function latestUserReviewTimestamp(items, fallback) {
  const latest = items.reduce((max, item) => {
    const value = Date.parse(item?.confirmedAt || item?.rejectedAt || item?.reviewedAt || item?.createdAt || "");
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);
  return latest ? new Date(latest).toISOString() : (fallback || new Date().toISOString());
}

function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function loadAllProjects() {
  const names = (await readdir(projectsRoot)).filter((name) => name.endsWith(".json"));
  return Promise.all(names.map((name) => loadJson(path.join(projectsRoot, name))));
}

function isManagedPath(parent, candidate) {
  if (!candidate) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function cleanupManagedStorage() {
  const projects = await loadAllProjects().catch(() => []);
  const referencedUploads = new Set();
  const referencedExports = new Set();
  const validThumbnails = new Set();
  const validPreviews = new Set();

  for (const project of projects) {
    for (const file of project.files || []) {
      if (isManagedPath(uploadsRoot, file.path)) referencedUploads.add(path.resolve(file.path));
      validThumbnails.add(`${project.id}-${file.id}.jpg`);
      validPreviews.add(`${project.id}-${file.id}.mp4`);
    }
    for (const asset of project.assets || []) {
      if (isManagedPath(uploadsRoot, asset.path)) referencedUploads.add(path.resolve(asset.path));
    }
    for (const draft of project.drafts || []) {
      const exportPath = draft.exportPath || (draft.exportUrl ? path.join(exportsRoot, path.basename(draft.exportUrl)) : "");
      if (isManagedPath(exportsRoot, exportPath)) referencedExports.add(path.resolve(exportPath));
    }
  }

  const jobNames = (await readdir(jobsRoot)).filter((name) => name.endsWith(".json"));
  const terminalJobs = new Map();
  for (const name of jobNames) {
    const filePath = path.join(jobsRoot, name);
    let job;
    try {
      job = await loadJson(filePath);
    } catch {
      await rm(filePath, { force: true }).catch(() => undefined);
      continue;
    }
    const active = ["uploading", "queued", "processing", "paused"].includes(job.status);
    if (active) {
      for (const file of job.files || []) {
        if (isManagedPath(uploadsRoot, file.path)) referencedUploads.add(path.resolve(file.path));
      }
      continue;
    }
    const kind = job.kind || (name.endsWith(".render.json") ? "render" : name.endsWith(".preprocess.json") ? "semantic-preprocess" : name.endsWith(".fast-index.json") ? "fast-index" : "ingest");
    const key = `${job.projectId || "unassigned"}:${kind}`;
    const group = terminalJobs.get(key) || [];
    group.push({ filePath, updatedAt: Date.parse(job.updatedAt || job.createdAt || 0) || 0 });
    terminalJobs.set(key, group);
  }
  for (const group of terminalJobs.values()) {
    group.sort((a, b) => b.updatedAt - a.updatedAt);
    await Promise.all(group.slice(3).map((item) => rm(item.filePath, { force: true }).catch(() => undefined)));
  }

  const exportEntries = await readdir(exportsRoot, { withFileTypes: true });
  await Promise.all(exportEntries.map(async (entry) => {
    const target = path.join(exportsRoot, entry.name);
    if (entry.isDirectory()) return rm(target, { recursive: true, force: true });
    if (path.extname(entry.name).toLowerCase() !== ".mp4" || !referencedExports.has(path.resolve(target))) {
      return rm(target, { force: true });
    }
  }));

  const uploadEntries = await readdir(uploadsRoot, { withFileTypes: true });
  await Promise.all(uploadEntries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const target = path.join(uploadsRoot, entry.name);
      return referencedUploads.has(path.resolve(target)) ? null : rm(target, { force: true });
    }));

  await pruneRegenerableCache(thumbnailsRoot, validThumbnails, { maxFiles: 500, maxBytes: 250 * 1024 * 1024 });
  await pruneRegenerableCache(previewsRoot, validPreviews, { maxFiles: 20, maxBytes: 2 * 1024 * 1024 * 1024 });
}

async function pruneRegenerableCache(rootPath, validNames, limits) {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(rootPath, entry.name);
    if (!entry.isFile() || !validNames.has(entry.name)) {
      await rm(target, { recursive: entry.isDirectory(), force: true }).catch(() => undefined);
      continue;
    }
    const info = await stat(target);
    files.push({ target, size: info.size, usedAt: Math.max(info.atimeMs, info.mtimeMs) });
  }
  files.sort((a, b) => b.usedAt - a.usedAt);
  let keptBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const keep = index < limits.maxFiles && keptBytes + file.size <= limits.maxBytes;
    if (keep) keptBytes += file.size;
    else await rm(file.target, { force: true }).catch(() => undefined);
  }
}

function normalizedSourcePath(value) {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function findProjectBySourcePath(folder) {
  const target = normalizedSourcePath(folder);
  const projects = await loadAllProjects();
  return projects
    .filter((project) => project.sourcePath && normalizedSourcePath(project.sourcePath) === target)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
}

function sameFolderSnapshot(project, fileStats) {
  if (project.files.length !== fileStats.length) return false;
  const known = new Map(project.files.map((file) => [file.name.toLowerCase(), Number(file.size)]));
  return fileStats.every((item) => known.get(item.name.toLowerCase()) === Number(item.info.size))
    && project.files.every((file) => hasUsableMetadata(file));
}

function mediaLookupKey(name, size) {
  return `${String(name || "").toLowerCase()}::${Number(size) || 0}`;
}

async function findReusableMedia(requestedFiles) {
  const wanted = new Set(requestedFiles.map((file) => mediaLookupKey(file.name, file.size)));
  const matches = new Map();
  if (!wanted.size) return matches;
  const projects = await loadAllProjects();
  for (const project of projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    for (const file of project.files || []) {
      const key = mediaLookupKey(file.name, file.size);
      if (wanted.has(key) && !matches.has(key) && hasUsableMetadata(file)) matches.set(key, file);
    }
  }
  return matches;
}

function projectFile(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid project identifier.");
  return path.join(projectsRoot, `${id}.json`);
}

function jobFile(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid ingest job identifier.");
  return path.join(jobsRoot, `${id}.json`);
}

function renderJobFile(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid render job identifier.");
  return path.join(jobsRoot, `${id}.render.json`);
}

async function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  await saveJson(jobFile(job.id), job);
}

async function loadJob(id) {
  return loadJson(jobFile(id));
}

async function saveRenderJob(job) {
  job.updatedAt = new Date().toISOString();
  await saveJson(renderJobFile(job.id), job);
}

async function loadRenderJob(id) {
  return loadJson(renderJobFile(id));
}

function publicRenderJob(job) {
  const { assetId: _, reviewProvider: __, ...safe } = job;
  safe.message = publicStatusMessage(safe.message, "Render is waiting.");
  if (safe.error) safe.error = publicStructuredError(safe.error, {
    title: "Rendering stopped",
    message: "HighlightAI could not render this video.",
    action: "Please try again. If it repeats, use fewer clips or a shorter music track, then render again."
  });
  return safe;
}

async function findActiveRenderJob(projectId, draftId, draftVersion) {
  const names = (await readdir(jobsRoot)).filter((name) => name.endsWith(".render.json"));
  for (const name of names) {
    const job = await loadJson(path.join(jobsRoot, name));
    if (job.projectId === projectId
      && job.draftId === draftId
      && Number(job.draftVersion || 1) === Number(draftVersion || 1)
      && ["queued", "processing", "paused"].includes(job.status)) return publicRenderJob(job);
  }
  return null;
}

async function processRenderJob(id) {
  const controller = new AbortController();
  activeRenderControllers.set(id, controller);
  const job = await loadRenderJob(id);
  if (controller.signal.aborted || !canStartBackgroundJob(job, ["queued", "processing"])) {
    activeRenderControllers.delete(id);
    return;
  }
  const project = await loadProject(job.projectId);
  const draft = project.drafts.find((item) => item.id === job.draftId);
  if (!draft) throw new Error("Draft not found.");
  const outputName = `${project.id}-${draft.id}.mp4`;
  const outputPath = path.join(exportsRoot, outputName);
  const music = job.assetId ? project.assets.find((asset) => asset.id === job.assetId)?.path : null;
  const selectedIds = new Set((draft.fileIds || []).map(String));
  const selectedDraftFiles = selectedIds.size ? project.files.filter((file) => selectedIds.has(file.id)) : project.files;
  const userOverrideIds = new Set([...(draft.userOverrideFileIds || []), ...(draft.workflow?.userOverrideFileIds || [])].map(String));
  const draftFiles = selectedDraftFiles
    .filter((file) => isGenerationEligibleFile(file, userOverrideIds))
    .map((file) => withUserAiOverride(file, userOverrideIds));
  if (!draftFiles.length) {
    throw new Error("No usable highlight source clips were available for rendering.");
  }
  const latestState = await loadRenderJob(id);
  if (controller.signal.aborted || !canStartBackgroundJob(latestState, ["queued", "processing"])) {
    activeRenderControllers.delete(id);
    return;
  }
  Object.assign(job, latestState);
  Object.assign(job, {
    status: "processing",
    phase: "directing",
    progress: 5,
    message: "Director agent is selecting complete highlight stories",
    workflow: { stage: "directing", iteration: 1, maxIterations: 3 }
  });
  await saveRenderJob(job);
  let targetDuration = Number(draft.duration) || 90;
  let musicInfo = null;
  const musicRepeats = Math.max(1, Math.min(2, Math.round(Number(job.musicRepeats || draft.musicRepeats || 1))));
  if (music) {
    musicInfo = await probe(music, controller.signal);
    if (musicInfo.duration > MAX_DURATION + 0.1) {
      throw new Error(`The selected soundtrack is ${Math.ceil(musicInfo.duration)} seconds. Choose a track no longer than ${MAX_DURATION} seconds so it can play without trimming.`);
    }
    targetDuration = Math.max(30, Math.min(MAX_DURATION, musicInfo.duration * musicRepeats));
  }
  let directed = null;
  const excludedIntervals = new Set();
  let visualReview = null;
  const reviewHistory = [];
  const visuallyApprovedIntervals = new Set();
  let finalReviewSourceSegments = [];
  const lockedReviewedTimeline = isUserReviewedDraft(draft);
  if (lockedReviewedTimeline) {
    directed = buildUserReviewedPlan(draft, draftFiles, targetDuration);
    if (!directed.segments.length) {
      throw new Error("No approved highlight periods were saved for this reviewed draft.");
    }
    reviewHistory.push({
      iteration: 1,
      deterministicScore: directed.workflow.critique.score,
      visualScore: directed.workflow.critique.score,
      approved: true,
      rejectedSegments: [],
      trimmedSegments: 0,
      problems: []
    });
  } else {
    for (let iteration = 1; iteration <= 4; iteration += 1) {
    let candidatePlan = buildAutoHighlightPlan(draftFiles, targetDuration, {
      minScore: 64,
      relaxedMinScore: 58,
      reviewCandidateMinScore: 64,
      excludedIntervals: [...excludedIntervals],
      intensity: draft.intensity ?? 78,
      gameGenre: project.gameProfile?.genre || inferGameProfile(project).genre
    });
    if (!candidatePlan.segments.length) {
      candidatePlan = createAdviceFallbackPlan(draftFiles, targetDuration, draft.intensity ?? 78, "Vision AI has not verified complete highlight moments yet, so this render uses the best available local candidates. Let background Vision AI finish for stronger timing.");
    }
    if (!directed || candidatePlan.workflow.critique.score > directed.workflow.critique.score) directed = candidatePlan;
    Object.assign(job, {
      phase: "evaluating",
      progress: 7 + iteration * 2,
      message: `Review iteration ${iteration}: ${candidatePlan.workflow.critique.score}/100`,
      workflow: { ...candidatePlan.workflow, reviewHistory, stage: "evaluating", iteration, maxIterations: 4 }
    });
    await saveRenderJob(job);
    if (job.reviewProvider) {
      Object.assign(job, {
        phase: "evaluating",
        progress: 8 + iteration * 2,
        message: `Vision review ${iteration}: checking the proposed timeline`,
        workflow: { ...candidatePlan.workflow, reviewHistory, stage: "visual-review", iteration, maxIterations: 4 }
      });
      await saveRenderJob(job);
      const originalSegments = [...candidatePlan.segments];
      finalReviewSourceSegments = originalSegments;
      visualReview = await reviewPlannedTimelineWithModel({
        project,
        draft: { ...draft, ...candidatePlan },
        endpoint: job.reviewProvider.endpoint,
        model: job.reviewProvider.model,
        apiKey: renderReviewSecrets.get(id)?.apiKey || "",
        signal: controller.signal,
        approvedIntervalKeys: visuallyApprovedIntervals
      }).catch((error) => {
        if (controller.signal.aborted) throw error;
        return {
          score: 0,
          approved: false,
          rejectSegmentIndexes: [],
          problems: [publicStatusMessage(error?.message, "Vision review was unavailable for this timeline.")]
        };
      });
      candidatePlan.workflow.visualReview = visualReview;
      candidatePlan = applyVisualReviewEditsToDraft(candidatePlan, visualReview, { minSegmentDuration: 2.5 });
      reviewHistory.push({
        iteration,
        deterministicScore: candidatePlan.workflow.critique.score,
        visualScore: visualReview.score,
        rawVisualScore: visualReview.rawScore ?? visualReview.score,
        approved: visualReview.approved,
        rejectedSegments: visualReview.rejectSegmentIndexes || [],
        trimmedSegments: candidatePlan.workflow.visualReview?.trimmedSegments || 0,
        problems: visualReview.problems || []
      });
      Object.assign(job, {
        message: visualReview.approved
          ? `Vision review ${iteration} approved the timeline`
          : `Vision review ${iteration} requested ${visualReview.rejectSegmentIndexes?.length || 0} changes`,
        workflow: { ...candidatePlan.workflow, reviewHistory, stage: "visual-review", iteration, maxIterations: 4 }
      });
      await saveRenderJob(job);
      if (!directed || visualReview.score >= Number(directed.workflow.visualReview?.score || 0)) directed = candidatePlan;
      for (const index of visualReview.rejectSegmentIndexes || []) {
        const segment = originalSegments[Number(index) - 1];
        if (segment) {
          const key = `${segment.fileId}:${Math.round(segment.start)}:${Math.round(segment.duration)}`;
          excludedIntervals.add(key);
          visuallyApprovedIntervals.delete(key);
        }
      }
      for (const index of visualReview.approvedSegmentIndexes || []) {
        const segment = originalSegments[Number(index) - 1];
        if (segment) visuallyApprovedIntervals.add(`${segment.fileId}:${Math.round(segment.start)}:${Math.round(segment.duration)}`);
      }
      if (visualReview.approved && candidatePlan.workflow.critique.approved) break;
    } else if (candidatePlan.workflow.critique.approved) break;
    }
  }
  if (!lockedReviewedTimeline && job.reviewProvider && !directed?.workflow?.visualReview?.approved) {
    const problems = directed?.workflow?.visualReview?.problems || [];
    job.workflow = { ...(directed?.workflow || job.workflow || {}), reviewHistory, stage: "visual-review", maxIterations: 4 };
    if (directed?.workflow) {
      const publicProblems = problems.map((problem) => publicStatusMessage(problem, "Vision review could not confirm part of this timeline."));
      directed.workflow.status = "review-revised";
      directed.workflow.advice = `Final review revised the timeline before rendering. ${publicProblems.slice(0, 2).join(" ")}`.trim();
    }
    await saveRenderJob(job);
  }
  const rejectedIndexes = new Set((directed.workflow.visualReview?.rejectSegmentIndexes || []).map((index) => Number(index) - 1));
  if (rejectedIndexes.size && directed.workflow.visualReviewEditsApplied !== true) {
    directed.segments = directed.segments.filter((_, index) => !rejectedIndexes.has(index));
    directed.duration = Math.round(directed.segments.reduce((sum, segment) => sum + segment.duration, 0) * 10) / 10;
    directed.workflow.selectedMoments = directed.segments.length;
    directed.workflow.status = "revised";
  }
  if (!lockedReviewedTimeline) {
    directed = polishFinalTimeline(directed, draftFiles, targetDuration, {
      minScore: 64,
      relaxedMinScore: 58,
      reviewCandidateMinScore: 64,
      gameGenre: project.gameProfile?.genre || inferGameProfile(project).genre,
      excludedIntervals: [...excludedIntervals]
    });
    if (job.reviewProvider) {
      directed.workflow = {
        ...(directed.workflow || {}),
        stage: "final-polish",
        advice: "Final review polished the timeline automatically. Weak shots were trimmed or replaced before rendering.",
        reviewHistory
      };
    }
  }
  if (!directed.segments.length) {
    directed = polishFinalTimeline(
      createAdviceFallbackPlan(draftFiles, targetDuration, draft.intensity ?? 78, "Final review found weak shots, so the editor rebuilt the timeline from the strongest available local moments."),
      draftFiles,
      targetDuration,
      {
        minScore: 58,
        relaxedMinScore: 52,
        reviewCandidateMinScore: 58,
        gameGenre: project.gameProfile?.genre || inferGameProfile(project).genre
      }
    );
  }
  if (!directed.segments.length) {
    throw new Error("No usable highlight moments were available for rendering.");
  }
  Object.assign(draft, directed);
  draft.workflow = { ...(draft.workflow || {}), reviewHistory };
  Object.assign(job, {
    phase: "evaluating",
    progress: 10,
    message: `Review team scored the timeline ${directed.workflow.critique.score}/100`,
    workflow: { ...directed.workflow, stage: "evaluating", iteration: job.workflow?.iteration || 1, maxIterations: 3 }
  });
  await saveRenderJob(job);
  Object.assign(job, { phase: "aligning", progress: 13, message: "Music director is aligning cuts and the final ending" });
  await saveRenderJob(job);
  if (musicInfo) {
    const requestedMusicDuration = Math.min(MAX_DURATION, musicInfo.duration * musicRepeats);
    const maxOutro = maxLogoOutroDuration(requestedMusicDuration);
    const beforeExtension = (draft.segments || []).reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0);
    const extendedDraft = extendDraftToMusicDuration({ ...draft, musicRepeats }, draftFiles, requestedMusicDuration, {
      maxLogoOutroDuration: maxOutro,
      intensity: draft.intensity ?? 78,
      gameGenre: project.gameProfile?.genre || inferGameProfile(project).genre,
      lockReviewedCuts: lockedReviewedTimeline,
      lockExistingCuts: Boolean(job.reviewProvider)
    });
    Object.assign(draft, extendedDraft);
    directed.workflow = draft.workflow;
    const afterExtension = (draft.segments || []).reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0);
    const musicExtension = draft.workflow?.musicExtension || {};
    if (!lockedReviewedTimeline && job.reviewProvider && musicExtension.lockExistingCuts === true && Number(musicExtension.targetContentDuration || 0) - Number(musicExtension.contentDuration || 0) > 12) {
      draft.workflow = {
        ...(draft.workflow || {}),
        status: "short-polished-timeline",
        advice: "The editor kept reviewed cut boundaries and rendered a shorter, cleaner timeline instead of adding weak filler.",
        reviewHistory,
        stage: "music-advice"
      };
      Object.assign(job, {
        phase: "aligning",
        progress: 14,
        message: "Music director kept the polished cuts instead of adding weak filler",
        workflow: { ...draft.workflow, reviewHistory, stage: "music-advice" }
      });
      await saveRenderJob(job);
    }
    if (afterExtension > beforeExtension + 0.5) {
      draft.workflow = {
        ...(draft.workflow || {}),
        status: "music-fill",
        advice: `The editor added ${Math.round((afterExtension - beforeExtension) * 10) / 10} seconds of extra gameplay so the logo ending stays short.`,
        reviewHistory,
        stage: "music-fill"
      };
      Object.assign(job, {
        phase: "aligning",
        progress: 14,
        message: "Music director added extra gameplay so the logo ending stays short",
        workflow: { ...draft.workflow, reviewHistory, stage: "music-fill" }
      });
      await saveRenderJob(job);
    }
  }
  draft.musicRepeats = musicRepeats;
  if (lockedReviewedTimeline && musicInfo) {
    const availableMusic = Math.min(MAX_DURATION, musicInfo.duration * musicRepeats);
    const reviewedContentBudget = Math.max(1, availableMusic - maxLogoOutroDuration(availableMusic));
    const beforeFit = (draft.segments || []).reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0);
    const fittedDraft = fitTimelineToDuration(draft, reviewedContentBudget, {
      minSegmentDuration: 2.5,
      maxSourceUses: 1,
      mode: "reviewed-music-fit"
    });
    Object.assign(draft, fittedDraft);
    const afterFit = (draft.segments || []).reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0);
    if (afterFit < beforeFit - 0.5) {
      draft.workflow = {
        ...(draft.workflow || {}),
        status: "reviewed-music-fit",
        advice: "The final editor fit the reviewed highlights to the soundtrack so the video and music end together.",
        reviewHistory,
        stage: "music-fit"
      };
      Object.assign(job, {
        phase: "aligning",
        progress: 15,
        message: "Music director fit the reviewed cuts to the soundtrack",
        workflow: { ...draft.workflow, reviewHistory, stage: "music-fit" }
      });
      await saveRenderJob(job);
    }
  }
  const alignedDraft = lockedReviewedTimeline && musicInfo
    ? {
        ...draft,
        duration: Math.round(Math.min(
          Math.min(MAX_DURATION, musicInfo.duration * musicRepeats),
          (draft.segments || []).reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0) + maxLogoOutroDuration(musicInfo.duration * musicRepeats)
        ) * 10) / 10,
        contentDuration: Math.round((draft.segments || []).reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0) * 10) / 10,
        outroDuration: Math.max(0, Math.round((Math.min(Math.min(MAX_DURATION, musicInfo.duration * musicRepeats), (draft.duration || 0) + maxLogoOutroDuration(musicInfo.duration * musicRepeats)) - (draft.segments || []).reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0)) * 10) / 10),
        musicDuration: Math.round(musicInfo.duration * 10) / 10,
        musicRepeats,
        musicPlan: {
          sourceDuration: Math.round(musicInfo.duration * 10) / 10,
          contentDuration: Math.round((draft.segments || []).reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0) * 10) / 10,
          timelineDuration: Math.round(Math.min(
            Math.min(MAX_DURATION, musicInfo.duration * musicRepeats),
            (draft.segments || []).reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0) + maxLogoOutroDuration(musicInfo.duration * musicRepeats)
          ) * 10) / 10,
          outroDuration: Math.max(0, Math.round(((Number(draft.duration) || 0) - (draft.segments || []).reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0)) * 10) / 10),
          repeats: musicRepeats,
          ending: "reviewed cuts with soundtrack ending",
          syncPoints: 0
        }
      }
    : await alignTrailerSegmentsToMusic(draft, music);
  const maximumOutro = maxLogoOutroDuration(alignedDraft.musicDuration || 0);
  if (Number(alignedDraft.outroDuration || 0) > maximumOutro) {
    directed.workflow = {
      ...(directed.workflow || {}),
      status: "music-advice",
      advice: `Only ${alignedDraft.contentDuration} seconds of usable gameplay were available for a ${alignedDraft.musicDuration}-second soundtrack. Choose more clips or a shorter soundtrack for a stronger result.`,
      reviewHistory,
      stage: "quality-gate",
      music: alignedDraft.musicPlan || null
    };
    job.workflow = directed.workflow;
    await saveRenderJob(job);
  }
  Object.assign(draft, alignedDraft);
  Object.assign(job, {
    phase: "rendering",
    progress: 16,
    message: "Rendering the approved timeline in the background",
    workflow: { ...directed.workflow, reviewHistory, stage: "rendering", music: alignedDraft.musicPlan || null }
  });
  await saveRenderJob(job);
  await renderHighlight({
      project,
      draft,
      outputPath,
      workRoot: renderWorkRoot,
      musicPath: music,
      signal: controller.signal,
      onProgress: async ({ completed, total, phase }) => {
        if (controller.signal.aborted) return;
        const progress = phase === "compressing"
          ? 94
          : phase === "mixing"
            ? 88
          : 16 + Math.round((completed / Math.max(1, total)) * 68);
        Object.assign(job, {
          phase: phase === "compressing" ? "compressing" : phase === "mixing" ? "rendering" : "rendering",
          progress,
          message: phase === "compressing"
            ? "Compressing the final 1080p HEVC MP4"
            : phase === "mixing"
              ? "Mixing video, game audio, and soundtrack"
              : `Rendering clip ${completed} of ${total}`,
          workflow: { ...(job.workflow || {}), stage: phase === "compressing" ? "compressing" : "rendering" }
        });
        await saveRenderJob(job);
      }
    });
  if (controller.signal.aborted) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    activeRenderControllers.delete(id);
    return;
  }
  const persistedBeforeCommit = await loadRenderJob(id);
  if (!canStartBackgroundJob(persistedBeforeCommit, ["processing"])) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    activeRenderControllers.delete(id);
    return;
  }
  const latestProject = await loadProject(job.projectId);
  const latestDraft = latestProject.drafts.find((item) => item.id === job.draftId);
  if (!latestDraft || Number(latestDraft.version || 1) !== Number(job.draftVersion || 1)) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    job.status = "failed";
    job.phase = "failed";
    job.progress = 100;
    job.message = "Render replaced by a newer refinement";
    job.error = structuredError("Render superseded", "A newer refinement replaced this render.", "The latest version is rendering separately.", true);
    await saveRenderJob(job);
    activeRenderControllers.delete(id);
    return;
  }
  latestDraft.exportUrl = `/media/exports/${outputName}`;
  latestDraft.exportPath = outputPath;
  latestDraft.status = "exported";
  latestDraft.segments = draft.segments;
  latestDraft.duration = draft.duration;
  latestDraft.workflow = draft.workflow;
  latestDraft.musicPlan = draft.musicPlan;
  latestDraft.musicDuration = draft.musicDuration;
  latestDraft.musicRepeats = draft.musicRepeats;
  latestDraft.encoding = draft.encoding;
  const usedFileIds = new Set([
    ...(latestDraft.fileIds || []),
    ...(latestDraft.segments || []).map((segment) => segment.fileId)
  ].filter(Boolean));
  if (usedFileIds.size) {
    const usedAt = new Date().toISOString();
    latestProject.files.forEach((file) => {
      if (!usedFileIds.has(file.id)) return;
      file.metadata = {
        ...file.metadata,
        generationUseCount: Math.max(0, Number(file.metadata?.generationUseCount || 0)) + 1,
        generationLastUsedAt: usedAt
      };
    });
  }
  await saveProject(latestProject);
  if (controller.signal.aborted) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    const rollbackProject = await loadProject(job.projectId).catch(() => null);
    const rollbackDraft = rollbackProject?.drafts.find((item) => item.id === job.draftId);
    if (rollbackDraft) {
      delete rollbackDraft.exportUrl;
      delete rollbackDraft.exportPath;
      rollbackDraft.status = "ready";
      await saveProject(rollbackProject);
    }
    activeRenderControllers.delete(id);
    return;
  }
  const assetManifest = {
    project: project.name,
    export: outputName,
    generatedAt: new Date().toISOString(),
    externalAssets: project.assets.map(({ path: _, ...asset }) => asset),
    notice: "Verify each asset's license before publishing. HighlightAI records metadata but does not grant usage rights."
  };
  job.status = "completed";
  job.phase = "completed";
  job.progress = 100;
  job.message = "Video ready";
  job.result = { url: latestDraft.exportUrl, localPath: outputPath, draft: latestDraft, assetManifest };
  await saveRenderJob(job);
  if (controller.signal.aborted) {
    const paused = await loadRenderJob(id);
    paused.status = "paused";
    paused.phase = "paused";
    paused.message = "Render paused. Resume restarts encoding from the saved draft.";
    delete paused.result;
    await saveRenderJob(paused);
  }
  activeRenderControllers.delete(id);
  renderReviewSecrets.delete(id);
  await cleanupManagedStorage();
}

async function markRenderJobFailed(id, error) {
  console.error(error);
  activeRenderControllers.delete(id);
  try {
    const job = await loadRenderJob(id);
    if (job.status === "paused" || job.status === "cancelled" || error?.name === "AbortError") return;
    job.status = "failed";
    job.phase = "failed";
    job.message = "Rendering failed";
    job.error = structuredError(
      "Rendering stopped",
      "HighlightAI could not render this video.",
      "Please try again. If it repeats, use fewer clips or a shorter music track, then render again.",
      true,
      error instanceof Error ? error.message : String(error || "")
    );
    await saveRenderJob(job);
    const project = await loadProject(job.projectId);
    const draft = project.drafts.find((item) => item.id === job.draftId);
    if (draft) {
      draft.status = "ready";
      await saveProject(project);
    }
    await rm(path.join(exportsRoot, `${job.projectId}-${job.draftId}.mp4`), { force: true }).catch(() => undefined);
    await cleanupManagedStorage();
    renderReviewSecrets.delete(id);
  } catch (saveError) {
    console.error(saveError);
  }
}

async function markIngestJobFailed(id, error) {
  console.error(error);
  activeIngestControllers.delete(id);
  try {
    const job = await loadJob(id);
    if (job.status === "paused" || job.status === "cancelled" || error?.name === "AbortError") return;
    job.status = "failed";
    job.phase = "failed";
    job.currentFile = null;
    job.failures = [...(job.failures || []), {
      clientId: "job",
      name: job.currentFile || job.name || "Import job",
      phase: "probe",
      message: error instanceof Error ? error.message.slice(0, 300) : "The background import job failed."
    }];
    await saveJob(job);
  } catch (saveError) {
    console.error(saveError);
  }
}

function publicJob(job) {
  const { files = [], cancelRequested: _, ...safe } = job;
  return {
    ...safe,
    previewFiles: files.map((file) => ({
      id: file.fileId || file.clientId,
      clientId: file.clientId,
      name: file.name,
      size: file.size,
      state: file.state
    }))
  };
}

function preprocessJobFile(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid preprocess job identifier.");
  return path.join(jobsRoot, `${id}.preprocess.json`);
}

function fastIndexJobFile(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid fast-index job identifier.");
  return path.join(jobsRoot, `${id}.fast-index.json`);
}

async function savePreprocessJob(job) {
  job.updatedAt = new Date().toISOString();
  await saveJson(preprocessJobFile(job.id), job);
}

async function loadPreprocessJob(id) {
  return loadJson(preprocessJobFile(id));
}

async function saveFastIndexJob(job) {
  job.updatedAt = new Date().toISOString();
  await saveJson(fastIndexJobFile(job.id), job);
}

async function loadFastIndexJob(id) {
  return loadJson(fastIndexJobFile(id));
}

async function markPreprocessJobFailed(id, error) {
  console.error(error);
  activePreprocessControllers.delete(id);
  preprocessSecrets.delete(id);
  try {
    const job = await loadPreprocessJob(id);
    if (job.status === "cancelled" || error?.name === "AbortError") return;
    job.status = "failed";
    job.phase = "failed";
    job.currentFile = null;
    job.failures = [...(job.failures || []), {
      name: job.currentFile || "AI preprocessing",
      phase: "vision",
      message: error instanceof Error ? error.message.slice(0, 300) : "The background AI preprocessing job failed."
    }];
    await savePreprocessJob(job);
  } catch (saveError) {
    console.error(saveError);
  }
}

async function recoverInterruptedPreprocessJobs() {
  const names = (await readdir(jobsRoot)).filter((name) => name.endsWith(".preprocess.json"));
  for (const name of names) {
    const id = name.slice(0, -".preprocess.json".length);
    const job = await loadPreprocessJob(id).catch(() => null);
    if (!job || job.status !== "processing") continue;
    if (Number(job.totalRequests || 0) > 0 && Number(job.processedRequests || 0) >= Number(job.totalRequests || 0)) {
      job.status = (job.failures || []).length ? "completed_with_warnings" : "completed";
      job.phase = "completed";
      job.etaSeconds = 0;
      job.currentFile = null;
      job.currentFrameTime = null;
      job.activeFiles = [];
      job.completedAt = job.completedAt || new Date().toISOString();
      job.result = job.result || {
        projectId: job.projectId,
        eventsFound: job.eventsFound || 0,
        approvedFrames: job.approvedFrames || 0,
        rejectedFrames: job.rejectedFrames || 0
      };
      await savePreprocessJob(job);
      continue;
    }
    job.status = "paused";
    job.phase = "paused";
    job.currentFile = null;
    job.currentFrameTime = null;
    job.activeFiles = [];
    await savePreprocessJob(job);
  }
}

function isInterruptedPreprocessFailure(failure = {}) {
  return /previous app session ended before this background job completed/i.test(String(failure.message || ""));
}

function isInterruptedPreprocessJob(job = {}) {
  return (job.failures || []).some((failure) => isInterruptedPreprocessFailure(failure));
}

async function recoverInterruptedFastIndexJobs() {
  const names = (await readdir(jobsRoot)).filter((name) => name.endsWith(".fast-index.json"));
  for (const name of names) {
    const id = name.slice(0, -".fast-index.json".length);
    const job = await loadFastIndexJob(id).catch(() => null);
    if (!job || !["processing", "paused"].includes(job.status)) continue;
    const project = await loadProject(job.projectId).catch(() => null);
    if (project) {
      const progress = summarizeFastIndexProgress(project, job);
      job.processedFiles = progress.processedFiles;
      job.candidateWindows = progress.candidateWindows;
      if (progress.processedFiles >= job.totalFiles) {
        job.status = job.failures.length ? "completed_with_warnings" : "completed";
        job.phase = "completed";
        job.etaSeconds = 0;
        job.currentFile = null;
        job.activeFiles = [];
        await saveFastIndexJob(job);
        await updateProjectFastIndexState(job.projectId, job.id, job.status, "completed");
        continue;
      }
    }
    if (job.status !== "processing") {
      await saveFastIndexJob(job);
      await updateProjectFastIndexState(job.projectId, job.id, "paused", "paused");
      continue;
    }
    job.status = "paused";
    job.phase = "paused";
    job.currentFile = null;
    job.activeFiles = [];
    await saveFastIndexJob(job);
    await updateProjectFastIndexState(job.projectId, job.id, "paused", "paused");
  }
}

function publicPreprocessJob(job) {
  const { endpoint: _, cancelRequested: __, ...safe } = job;
  safe.failures = (safe.failures || []).map((failure) => ({
    ...failure,
    message: publicStatusMessage(failure.message, "Vision AI could not review this item.")
  }));
  safe.totalFiles = Math.max(Number(safe.totalFiles || 0), Number(safe.processedFiles || 0));
  safe.totalRequests = Math.max(Number(safe.totalRequests || 0), Number(safe.processedRequests || 0));
  if (["completed", "completed_with_warnings", "failed", "cancelled"].includes(String(safe.status || ""))) {
    safe.etaSeconds = 0;
    safe.currentFile = null;
    safe.currentFrameTime = null;
    safe.activeFiles = [];
    if (["completed", "completed_with_warnings"].includes(String(safe.status || ""))) {
      safe.completedAt = safe.completedAt || safe.updatedAt || new Date().toISOString();
    }
  }
  return safe;
}

function publicFastIndexJob(job) {
  const { files: _, cancelRequested: __, ...safe } = job;
  safe.failures = (safe.failures || []).map((failure) => ({
    ...failure,
    message: publicStatusMessage(failure.message, "HighlightAI could not index this item.")
  }));
  const counts = normalizeFastIndexProgressFields(safe);
  safe.totalFiles = counts.totalFiles;
  safe.processedFiles = counts.processedFiles;
  if (["completed", "completed_with_warnings", "failed", "cancelled"].includes(String(safe.status || ""))) {
    if (["completed", "completed_with_warnings"].includes(String(safe.status || ""))) {
      safe.processedFiles = safe.totalFiles;
      safe.completedAt = safe.completedAt || safe.updatedAt || new Date().toISOString();
    }
    safe.etaSeconds = 0;
    safe.currentFile = null;
    safe.activeFiles = [];
  }
  return safe;
}

function normalizeFastIndexProgressFields(job) {
  const rawProcessed = Math.max(0, Number(job?.processedFiles || 0));
  const rawTotal = Math.max(0, Number(job?.totalFiles || 0));
  const completed = ["completed", "completed_with_warnings"].includes(String(job?.status || ""));
  const totalFiles = completed ? Math.max(rawTotal, rawProcessed) : rawTotal || rawProcessed;
  const processedFiles = completed ? totalFiles : Math.min(totalFiles || rawProcessed, rawProcessed);
  return { processedFiles, totalFiles };
}

async function markFastIndexJobFailed(id, error) {
  console.error(error);
  activeFastIndexControllers.delete(id);
  try {
    const job = await loadFastIndexJob(id);
    if (job.status === "paused" || job.status === "cancelled" || error?.name === "AbortError") return;
    job.status = "failed";
    job.phase = "failed";
    job.currentFile = null;
    job.failures = [...(job.failures || []), {
      name: job.currentFile || "Fast index",
      phase: "scan",
      message: error instanceof Error ? error.message.slice(0, 300) : "The background fast index job failed."
    }];
    await saveFastIndexJob(job);
  } catch (saveError) {
    console.error(saveError);
  }
}

function hasBackendDetails(value = "") {
  return /(?:ffmpeg|ffprobe|libx264|libx265|encoder|decoder|stderr|stdout|exited\s+-?\d+|error code|invalid argument|conversion failed|malloc|0x[0-9a-f]+|\[[a-z0-9#:@/.-]+]|(?:[A-Z]:\\|\/(?:Users|tmp|var|home|mnt|usr|app)\/)|node_modules|stack trace|traceback|errno|syscall|EADDRINUSE|ECONN|ENOTFOUND|EAI_AGAIN|https?:\/\/|api[_ -]?key|authorization|bearer|token|secret|password|sk-[a-z0-9_-]+|\b(?:TypeError|ReferenceError|SyntaxError)\b)/i.test(String(value || ""));
}

function unsafePublicMessage(value = "") {
  const text = String(value || "");
  return !text.trim() || text.length > 240 || /[\n]/.test(text) || hasBackendDetails(text);
}

function publicStatusMessage(value, fallback) {
  return unsafePublicMessage(value) ? fallback : String(value);
}

function publicStructuredError(error = {}, fallback = {}) {
  return {
    title: publicStatusMessage(error.title, fallback.title || "Processing stopped"),
    message: publicStatusMessage(error.message, fallback.message || "HighlightAI could not finish that step."),
    action: publicStatusMessage(error.action, fallback.action || "Please try again."),
    recoverable: error.recoverable !== false
  };
}

function structuredError(title, message, action, recoverable, details) {
  return { title, message, action, recoverable, ...(details ? { details } : {}) };
}

function pendingVideoMetadata(size = 0) {
  return {
    duration: 0,
    size,
    bitrate: 0,
    width: 0,
    height: 0,
    fps: 0,
    videoCodec: "pending",
    audioCodec: null,
    hasAudio: false,
    qualityScore: 0,
    actionScore: 0,
    indexDescription: "Waiting for background analysis.",
    indexTags: ["pending"],
    indexScore: 0,
    recommendedForDraft: false
  };
}

function hasUsableMetadata(file) {
  return Number(file?.metadata?.duration || 0) > 0 && file.metadata?.videoCodec !== "pending";
}

async function processIngestJob(id) {
  const controller = new AbortController();
  activeIngestControllers.set(id, controller);
  const job = await loadJob(id);
  if (controller.signal.aborted || !canStartBackgroundJob(job, ["processing"])) {
    activeIngestControllers.delete(id);
    return;
  }
  const probedFiles = job.files
    .filter((file) => file.state === "processed" && file.processedMetadata && !job.projectId)
    .map((file) => ({
      id: file.fileId || randomUUID(),
      name: file.name,
      path: file.path,
      url: file.url,
      size: file.size,
      metadata: file.processedMetadata
    }));
  const started = Date.now();
  const active = new Set();
  let processed = Number(job.processedFiles || 0);
  let cursor = 0;
  let saveQueue = Promise.resolve();
  const pendingFiles = job.files.filter((file) => file.state !== "processed");

  const updateProgress = (mutator) => {
    saveQueue = saveQueue.then(async () => {
      const current = await loadJob(id);
      if (current.cancelRequested) throw new Error("cancelled");
      if (current.status === "paused" || controller.signal.aborted) throw new DOMException("Operation paused", "AbortError");
      mutator(current);
      current.totalFiles = Math.max(Number(current.totalFiles || 0), Number(current.processedFiles || 0));
      current.totalRequests = Math.max(Number(current.totalRequests || 0), Number(current.processedRequests || 0));
      const elapsedSeconds = Math.max(1, (Date.now() - started) / 1000);
      const remaining = Math.max(0, current.totalFiles - current.processedFiles);
      current.etaSeconds = current.processedFiles > 0 ? Math.ceil((elapsedSeconds / current.processedFiles) * remaining) : current.estimatedSeconds;
      current.activeFiles = [...active].slice(0, 4);
      await saveJob(current);
      return current;
    });
    return saveQueue;
  };

  const worker = async () => {
    while (cursor < pendingFiles.length && !controller.signal.aborted) {
      const pending = pendingFiles[cursor++];
      active.add(pending.name);
      await updateProgress((current) => {
        current.currentFile = pending.name;
        current.phase = "probing";
      });
      try {
        const metadata = pending.state === "reused" && pending.reusedMetadata
          ? structuredClone(pending.reusedMetadata)
          : await probe(pending.path, controller.signal);
        if (pending.state !== "reused") Object.assign(metadata, await analyzeActionSignals(pending.path, metadata.duration, controller.signal));
        if (job.projectId && pending.fileId) {
          await updateProjectFile(job.projectId, pending.fileId, (file) => {
            file.metadata = metadata;
            file.url = pending.url;
          });
        } else {
          probedFiles.push({
            id: randomUUID(),
            name: pending.name,
            path: pending.path,
            url: pending.url,
            size: pending.size,
            metadata
          });
        }
        await updateProgress((current) => {
          const saved = current.files.find((file) => file.clientId === pending.clientId);
          if (saved) {
            saved.state = "processed";
            saved.processedMetadata = metadata;
          }
        });
      } catch {
        if (controller.signal.aborted) return;
        await updateProgress((current) => {
          current.failures.push({
            clientId: pending.clientId,
            name: pending.name,
            phase: "probe",
            message: "FFmpeg could not read this video. It may be incomplete or use an unsupported codec."
          });
        });
        await updateProjectFile(job.projectId, pending.fileId, (file) => {
          file.metadata = {
            ...pendingVideoMetadata(file.size),
            indexDescription: "This video could not be read by FFmpeg.",
            indexTags: ["unreadable"],
            indexScore: 0
          };
        });
      } finally {
        active.delete(pending.name);
        processed += 1;
        await updateProgress((current) => {
          current.processedFiles = processed;
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(ingestConcurrency(), job.files.length) }, () => worker())).catch(async (error) => {
    if (error.message !== "cancelled" && error?.name !== "AbortError") throw error;
  });

  const completed = await loadJob(id);
  if (controller.signal.aborted || !canStartBackgroundJob(completed, ["processing"])) {
    activeIngestControllers.delete(id);
    return;
  }
  let project = completed.projectId ? await loadProject(completed.projectId) : null;
  if (!project) {
    const analysis = buildAnalysis(probedFiles);
    project = {
      id: randomUUID(),
      name: completed.name,
      sourceType: completed.linkedFolder ? "local-folder" : "uploaded-files",
      ...(completed.linkedFolder ? { sourcePath: completed.linkedFolder } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      files: probedFiles,
      assets: [],
      drafts: [],
      analysis,
      maxDuration: MAX_DURATION
    };
    await saveProject(project);
    completed.projectId = project.id;
  }
  const usableFiles = project.files.filter((file) => hasUsableMetadata(file));
  if (!usableFiles.length) {
    completed.status = "failed";
    completed.phase = "failed";
    completed.currentFile = null;
    project.fastIndex = {
      ...(project.fastIndex || {}),
      status: "failed",
      phase: "failed",
      processedFiles: completed.processedFiles,
      totalFiles: completed.totalFiles,
      candidateWindows: 0,
      etaSeconds: 0,
      updatedAt: new Date().toISOString()
    };
    await saveProject(project);
    await saveJob(completed);
    activeIngestControllers.delete(id);
    return;
  }
  const analysis = buildAnalysis(project.files);
  project.analysis = analysis;
  project.fastIndex = {
    ...(project.fastIndex || {}),
    status: "queued",
    phase: "waiting",
    processedFiles: completed.processedFiles,
    totalFiles: completed.totalFiles,
    candidateWindows: 0,
    etaSeconds: 0,
    updatedAt: new Date().toISOString()
  };
  await saveProject(project);
  const needsFastIndex = usableFiles.some((file) => !hasReusableFastIndex(file, FAST_INDEX_MIN_WINDOWS));
  if (needsFastIndex) {
    createFastIndexJob(project, { auto: true }).then((fastJob) => {
      processFastIndexJob(fastJob.id).catch((error) => void markFastIndexJobFailed(fastJob.id, error));
    }).catch((error) => console.error(error));
  } else {
    project.fastIndex = {
      ...(project.fastIndex || {}),
      status: "completed",
      phase: "completed",
      processedFiles: usableFiles.length,
      totalFiles: usableFiles.length,
      candidateWindows: usableFiles.reduce((sum, file) => sum + (file.metadata?.candidateWindows?.length || 0), 0),
      etaSeconds: 0,
      updatedAt: new Date().toISOString()
    };
    await saveProject(project);
  }
  const latest = await loadJob(id);
  if (controller.signal.aborted || !canStartBackgroundJob(latest, ["processing"])) {
    activeIngestControllers.delete(id);
    return;
  }
  latest.projectId = project.id;
  latest.result = { project, analysis };
  latest.status = latest.failures.length ? "completed_with_warnings" : "completed";
  latest.phase = "completed";
  latest.currentFile = null;
  latest.activeFiles = [];
  latest.etaSeconds = 0;
  await saveJob(latest);
  activeIngestControllers.delete(id);
}

async function updateProjectFile(projectId, fileId, mutator) {
  if (!projectId || !fileId) return;
  const project = await loadProject(projectId);
  const file = project.files.find((item) => item.id === fileId);
  if (!file) return;
  mutator(file);
  project.analysis = buildAnalysis(project.files);
  project.fastIndex = {
    ...(project.fastIndex || {}),
    status: "importing",
    phase: "probing",
    processedFiles: project.files.filter((item) => hasUsableMetadata(item) || item.metadata?.indexTags?.includes("unreadable")).length,
    totalFiles: project.files.length,
    candidateWindows: project.fastIndex?.candidateWindows || 0,
    updatedAt: new Date().toISOString()
  };
  await saveProject(project);
}

function ingestConcurrency() {
  return Math.max(1, Math.min(3, Math.floor((os.availableParallelism?.() || os.cpus().length || 2) / 2)));
}

function fastIndexConcurrency(requested = 0) {
  const cores = os.availableParallelism?.() || os.cpus().length || 2;
  return Math.max(1, Math.min(4, Number(requested) || Math.max(2, Math.floor(cores / 3))));
}

function estimateIngestSeconds({ totalFiles, totalBytes }) {
  const gb = totalBytes / 1024 ** 3;
  const baseProbe = totalFiles * 5;
  const io = gb * 3;
  return Math.max(8, Math.ceil((baseProbe + io) / ingestConcurrency()));
}

function estimateFastIndex(project, options = {}) {
  const selectedFiles = selectIndexFiles(project.files, options);
  const totalDuration = selectedFiles.reduce((sum, file) => sum + Math.max(0, file.metadata?.duration || 0), 0);
  const concurrency = fastIndexConcurrency(options.concurrency);
  const proxyRealtimeFactor = Math.max(4, Math.min(40, Number(options.proxyRealtimeFactor) || 9));
  const estimatedSeconds = Math.max(8, Math.ceil((totalDuration / proxyRealtimeFactor) / concurrency + selectedFiles.length * 0.35));
  return {
    files: selectedFiles.length,
    totalProjectFiles: project.files.length,
    totalDuration,
    concurrency,
    windowDuration: Math.max(8, Math.min(20, Number(options.windowDuration) || 14)),
    maxWindowsPerFile: Math.max(1, Math.min(8, Number(options.maxWindowsPerFile) || FAST_INDEX_MIN_WINDOWS)),
    estimatedSeconds,
    storageBytes: selectedFiles.length * 8_000,
    note: "Fast index scans low-resolution proxy signals and stores reusable candidate windows. It avoids slow vision-model calls."
  };
}

function selectIndexFiles(files, options = {}) {
  const explicitIds = Array.isArray(options.fileIds) ? new Set(options.fileIds.map(String)) : null;
  const pool = explicitIds
    ? files.filter((file) => explicitIds.has(file.id) && hasUsableMetadata(file))
    : files.filter((file) => hasUsableMetadata(file) && !looksLikePreviousExport(file.name));
  const maxFiles = Math.max(0, Math.min(pool.length, Number(options.maxFiles) || 0));
  const ranked = [...pool].sort((a, b) => (b.metadata?.actionScore || 0) - (a.metadata?.actionScore || 0));
  return maxFiles ? ranked.slice(0, maxFiles) : ranked;
}

function hasReusableFastIndex(file, requiredWindows = 1) {
  return Array.isArray(file?.metadata?.candidateWindows)
    && file.metadata.candidateWindows.length >= Math.max(1, Number(requiredWindows) || 1);
}

function summarizeFastIndexProgress(project, job) {
  const filesById = new Map(project.files.map((file) => [file.id, file]));
  const pendingFiles = job.files.filter((pending) => {
    const file = filesById.get(pending.id);
    return file
      && file.metadata?.fastIndexJobId !== job.id
      && !hasReusableFastIndex(file, job.maxWindowsPerFile || FAST_INDEX_MIN_WINDOWS);
  });
  const totalFiles = Math.max(0, Number(job.totalFiles) || job.files.length);
  const processedFiles = Math.min(totalFiles, Math.max(0, job.files.length - pendingFiles.length));
  const candidateWindows = job.files.reduce((sum, pending) => {
    const file = filesById.get(pending.id);
    return sum + (Array.isArray(file?.metadata?.candidateWindows) ? file.metadata.candidateWindows.length : 0);
  }, 0);
  return { pendingFiles, processedFiles, candidateWindows };
}

function countFastIndexCandidateWindows(project, job) {
  const filesById = new Map(project.files.map((file) => [file.id, file]));
  return job.files.reduce((sum, pending) => {
    const file = filesById.get(pending.id);
    return sum + (Array.isArray(file?.metadata?.candidateWindows) ? file.metadata.candidateWindows.length : 0);
  }, 0);
}

async function createFastIndexJob(project, options = {}) {
  const estimate = estimateFastIndex(project, options);
  const files = selectIndexFiles(project.files, options).map((file) => ({ id: file.id, name: file.name, path: file.path, metadata: file.metadata }));
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    kind: "fast-candidate-index",
    projectId: project.id,
    status: "processing",
    phase: "scanning",
    totalFiles: estimate.files,
    totalProjectFiles: project.files.length,
    processedFiles: 0,
    candidateWindows: 0,
    currentFile: null,
    failures: [],
    estimatedSeconds: estimate.estimatedSeconds,
    etaSeconds: estimate.estimatedSeconds,
    storageBytes: estimate.storageBytes,
    concurrency: estimate.concurrency,
    windowDuration: estimate.windowDuration,
    maxWindowsPerFile: estimate.maxWindowsPerFile,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    cancelRequested: false,
    activeFiles: [],
    result: null,
    files
  };
  await saveFastIndexJob(job);
  project.fastIndex = {
    jobId: job.id,
    status: "processing",
    phase: "scanning",
    candidateWindows: 0,
    estimatedSeconds: estimate.estimatedSeconds,
    etaSeconds: estimate.estimatedSeconds,
    updatedAt: now
  };
  await saveProject(project);
  return job;
}

async function processFastIndexJob(id) {
  const controller = new AbortController();
  activeFastIndexControllers.set(id, controller);
  const job = await loadFastIndexJob(id);
  if (controller.signal.aborted || !canStartBackgroundJob(job, ["processing"])) {
    activeFastIndexControllers.delete(id);
    return;
  }
  const project = await loadProject(job.projectId);
  const started = Date.now();
  const active = new Set();
  let cursor = 0;
  const initialProgress = summarizeFastIndexProgress(project, job);
  let processedFiles = initialProgress.processedFiles;
  let candidateWindows = initialProgress.candidateWindows;
  let saveQueue = Promise.resolve();
  let projectSaveQueue = Promise.resolve();
  const pendingFiles = initialProgress.pendingFiles;

  const updateProgress = (mutator) => {
    saveQueue = saveQueue.then(async () => {
      const current = await loadFastIndexJob(id);
      if (current.cancelRequested) throw new Error("cancelled");
      if (current.status === "paused" || controller.signal.aborted) throw new DOMException("Operation paused", "AbortError");
      mutator(current);
      current.processedFiles = Math.min(current.totalFiles, Math.max(0, current.processedFiles));
      const elapsedSeconds = Math.max(1, (Date.now() - started) / 1000);
      const remaining = Math.max(0, current.totalFiles - current.processedFiles);
      current.etaSeconds = current.processedFiles > 0 ? Math.ceil((elapsedSeconds / current.processedFiles) * remaining) : current.estimatedSeconds;
      current.activeFiles = [...active].slice(0, 4);
      await saveFastIndexJob(current);
      const indexedProject = await loadProject(job.projectId);
      indexedProject.fastIndex = {
        jobId: id,
        status: current.status,
        phase: current.phase,
        processedFiles: current.processedFiles,
        totalFiles: current.totalFiles,
        candidateWindows: current.candidateWindows,
        estimatedSeconds: current.estimatedSeconds,
        etaSeconds: current.etaSeconds,
        updatedAt: current.updatedAt
      };
      await saveProject(indexedProject);
      return current;
    });
    return saveQueue;
  };

  const worker = async () => {
    while (cursor < pendingFiles.length && !controller.signal.aborted) {
      const pending = pendingFiles[cursor++];
      active.add(pending.name);
      await updateProgress((current) => {
        current.phase = "scanning";
        current.currentFile = pending.name;
      });
      try {
        const windows = await analyzeCandidateWindows(pending.path, pending.metadata?.duration || 0, {
          maxWindows: job.maxWindowsPerFile,
          windowDuration: job.windowDuration,
          signal: controller.signal
        });
        const file = project.files.find((item) => item.id === pending.id);
        if (file) {
          file.metadata = file.metadata || {};
          file.metadata.candidateWindows = windows;
          Object.assign(file.metadata, describeIndexedVideo(file, windows));
          file.metadata.fastIndexJobId = id;
          file.metadata.fastIndexUpdatedAt = new Date().toISOString();
          project.analysis = buildAnalysis(project.files);
          projectSaveQueue = projectSaveQueue.then(() => saveProject(project));
          await projectSaveQueue;
        }
        candidateWindows += windows.length;
      } catch (error) {
        if (controller.signal.aborted) return;
        await updateProgress((current) => {
          current.failures.push({
            fileId: pending.id,
            name: pending.name,
            phase: "scan",
            message: error instanceof Error ? error.message.slice(0, 260) : "Fast proxy scan failed."
          });
        });
      } finally {
        processedFiles = Math.min(job.totalFiles, processedFiles + 1);
        active.delete(pending.name);
        await updateProgress((current) => {
          current.processedFiles = processedFiles;
          current.candidateWindows = candidateWindows;
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(job.concurrency, job.files.length) }, () => worker())).catch(async (error) => {
    if (error.message !== "cancelled" && error?.name !== "AbortError") throw error;
  });

  const current = await loadFastIndexJob(id);
  if (controller.signal.aborted || !canStartBackgroundJob(current, ["processing"])) {
    activeFastIndexControllers.delete(id);
    return;
  }
  project.analysis = buildAnalysis(project.files);
  project.fastIndex = {
    jobId: id,
    status: current.failures.length ? "completed_with_warnings" : "completed",
    phase: "completed",
    processedFiles: current.totalFiles,
    totalFiles: current.totalFiles,
    candidateWindows,
    estimatedSeconds: current.estimatedSeconds,
    etaSeconds: 0,
    updatedAt: new Date().toISOString()
  };
  await saveProject(project);
  const latest = await loadFastIndexJob(id);
  if (controller.signal.aborted || !canStartBackgroundJob(latest, ["processing"])) {
    await updateProjectFastIndexState(job.projectId, id, latest.status, latest.phase);
    activeFastIndexControllers.delete(id);
    return;
  }
  latest.status = latest.failures.length ? "completed_with_warnings" : "completed";
  latest.phase = "completed";
  latest.processedFiles = latest.totalFiles;
  latest.candidateWindows = candidateWindows;
  latest.etaSeconds = 0;
  latest.currentFile = null;
  latest.activeFiles = [];
  latest.result = { project, candidateWindows };
  await saveFastIndexJob(latest);
  activeFastIndexControllers.delete(id);
}

async function updateProjectFastIndexState(projectId, jobId, status, phase) {
  const project = await loadProject(projectId).catch(() => null);
  if (!project || project.fastIndex?.jobId !== jobId) return;
  const job = await loadFastIndexJob(jobId).catch(() => null);
  project.fastIndex = {
    ...project.fastIndex,
    status,
    phase,
    processedFiles: job?.processedFiles ?? project.fastIndex.processedFiles,
    totalFiles: job?.totalFiles ?? project.fastIndex.totalFiles,
    candidateWindows: job?.candidateWindows ?? project.fastIndex.candidateWindows,
    estimatedSeconds: job?.estimatedSeconds ?? project.fastIndex.estimatedSeconds,
    etaSeconds: status === "paused" ? (job?.etaSeconds ?? project.fastIndex.etaSeconds) : 0,
    updatedAt: new Date().toISOString()
  };
  await saveProject(project);
}

function describeIndexedVideo(file, windows = []) {
  const name = String(file.name || "").replace(/\.[^.]+$/, "");
  const best = [...windows].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  const cleanTitle = name.replace(/\d{4}[.\-_]\d{2}[.\-_]\d{2}\s*[-_]\s*/i, "").replace(/\.\d{2}\.DVR$/i, "").trim();
  return {
    indexDescription: `${cleanTitle || "Gameplay clip"}: local signals found a candidate window around ${formatTimestamp(best?.start || file.metadata?.highlightStart || 0)}. Vision AI will add game-specific actions, subjects, objectives, and results.`,
    indexTags: [],
    indexScore: Math.max(file.metadata?.semanticScore || 0, best?.score || file.metadata?.actionScore || 0),
    recommendedForDraft: (best?.score || 0) >= 80 || (file.metadata?.semanticScore || 0) >= 70
  };
}

function formatTimestamp(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function buildAnalysis(files) {
  calibrateHighlightScores(files);
  const readyFiles = files.filter((file) => hasUsableMetadata(file));
  const highlightFiles = readyFiles.filter((file) => file.metadata?.aiDecision !== "rejected" && !hasBoringSemanticEvidence(file));
  const analysisFiles = highlightFiles.length ? highlightFiles : readyFiles.length ? readyFiles : files;
  const pendingFiles = files.length - readyFiles.length;
  const aiRated = analysisFiles.filter((file) => Number.isFinite(file.metadata?.semanticScore));
  const weightedQuality = aiRated.length
    ? Math.round(aiRated.reduce((sum, file) => sum + file.metadata.semanticScore, 0) / aiRated.length)
    : Math.round(analysisFiles.reduce((sum, file) => sum + (file.metadata?.qualityScore || 0), 0) / Math.max(1, analysisFiles.length));
  const totalDuration = analysisFiles.reduce((sum, file) => sum + (file.metadata?.duration || 0), 0);
  const moments = analysisFiles.length ? Math.max(3, Math.min(40, Math.round(totalDuration / 18))) : 0;
  const semanticEvents = analysisFiles.reduce((sum, file) => sum + (file.metadata?.semanticEvents || []).length, 0);
  const rejectedCount = readyFiles.length - highlightFiles.length;
  return {
    qualityScore: weightedQuality,
    actionMoments: semanticEvents || moments,
    totalDuration,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    notes: [
      pendingFiles
        ? `${files.length} videos found. ${readyFiles.length} analyzed, ${pendingFiles} still running in the background.`
        : semanticEvents
        ? `${semanticEvents} AI-rated action event${semanticEvents === 1 ? "" : "s"} found across ${aiRated.length} recording${aiRated.length === 1 ? "" : "s"}.`
        : `${moments} potential highlight segments found across ${analysisFiles.length} highlight-ready recording${analysisFiles.length === 1 ? "" : "s"}.`,
      readyFiles.length && readyFiles.every((file) => file.metadata?.hasAudio) ? "All analyzed recordings have usable audio." : "Some recordings have no audio or are still being analyzed.",
      pendingFiles
        ? "You can browse the folder now. Trailer creation unlocks when selected videos are analyzed."
        : rejectedCount
          ? `${rejectedCount} low-signal clip${rejectedCount === 1 ? "" : "s"} were excluded from highlight generation.`
          : "A focused highlight under 5 minutes will produce the strongest result."
    ],
    files: files.map(({ path: _, ...file }) => file),
    ideas: buildIdeas(analysisFiles, totalDuration, moments, weightedQuality)
  };
}

function buildIdeas(files, totalDuration, moments, qualityScore) {
  const hasAudio = files.some((file) => file.metadata?.hasAudio);
  const highFps = files.some((file) => (file.metadata?.fps || 0) >= 50);
  const verticalCandidate = files.some((file) => (file.metadata?.height || 0) > (file.metadata?.width || 0));
  const sourceMinutes = Math.max(1, Math.round(totalDuration / 60));
  return [
    {
      id: "trailer",
      title: "Cinematic Game Trailer",
      description: `Build a music-driven trailer from the highest-action moments across ${files.length} recordings, with escalating pacing and a cinematic finish.`,
      duration: Math.min(MAX_DURATION, 150),
      format: "Landscape",
      style: "Trailer",
      accent: "#ffb347",
      score: 98,
      moments: Math.min(files.length, 32)
    },
    {
      id: "cinematic",
      title: qualityScore >= 80 ? "Cinematic Last Stand" : "Focused Comeback",
      description: `Shape the strongest moments from roughly ${sourceMinutes} minute${sourceMinutes === 1 ? "" : "s"} of footage into a paced story with a dramatic finish.`,
      duration: Math.min(MAX_DURATION, Math.max(30, Math.round(totalDuration * 0.45))),
      format: verticalCandidate ? "Vertical" : "Landscape",
      style: "Cinematic",
      accent: "#ff6b35",
      score: Math.min(98, 84 + Math.round(qualityScore / 8)),
      moments: Math.min(moments, 16)
    },
    {
      id: "velocity",
      title: highFps ? "High-FPS Velocity Cut" : "Pure Velocity",
      description: `Use the ${Math.min(moments, 12)} most intense segments with fast cuts, strong contrast, and normalized impact audio.`,
      duration: Math.min(75, Math.max(20, Math.round(totalDuration * 0.22))),
      format: "Vertical",
      style: "High energy",
      accent: "#b9ff66",
      score: Math.min(97, highFps ? 96 : 88 + Math.round(qualityScore / 12)),
      moments: Math.min(moments, 12)
    },
    {
      id: "story",
      title: hasAudio ? "Squad Story" : "Clean Tactical Reel",
      description: hasAudio
        ? "Balance action with the recording's usable audio to create a compact beginning, escalation, and payoff."
        : "Build a clean visual-first reel and leave space for music or sound effects from your asset library.",
      duration: Math.min(135, Math.max(35, Math.round(totalDuration * 0.34))),
      format: "Landscape",
      style: hasAudio ? "Comedy" : "Cinematic",
      accent: "#c990ff",
      score: Math.min(94, hasAudio ? 90 : 85),
      moments: Math.min(moments, 10)
    }
  ];
}

function estimatePreprocess(project, options = {}) {
  const sampleInterval = Math.max(1, Math.min(10, Number(options.sampleInterval) || DEFAULT_FRAME_INTERVAL));
  const requestedConcurrency = Math.max(1, Math.min(6, Number(options.concurrency) || 2));
  const localOllama = isLocalOllamaEndpoint(options.endpoint);
  const concurrency = localOllama
    ? 1
    : Math.min(requestedConcurrency, Math.max(1, os.availableParallelism?.() || os.cpus().length || 2));
  const selectedFiles = selectPreprocessFiles(project.files, options);
  const totalDuration = selectedFiles.reduce((sum, file) => sum + Math.max(0, file.metadata?.duration || 0), 0);
  const batches = buildPreprocessBatches(selectedFiles, sampleInterval, options.maxFrames, options);
  const frames = batches.reduce((sum, batch) => sum + batch.items.reduce((count, item) => count + item.times.length, 0), 0);
  const modelRequests = batches.length;
  const assumedModelSeconds = Number(options.modelSecondsPerRequest) > 0
    ? Number(options.modelSecondsPerRequest)
    : localOllama ? 130 : 8;
  const extractSeconds = frames * 0.25;
  const modelSeconds = (modelRequests * assumedModelSeconds) / concurrency;
  return {
    files: selectedFiles.length,
    totalProjectFiles: project.files.length,
    totalDuration,
    frames,
    modelRequests,
    sampleInterval,
    concurrency,
    storageBytes: frames * 95_000,
    estimatedSeconds: Math.max(10, Math.ceil(extractSeconds + modelSeconds)),
    note: "Vision reviews are batched into contact sheets. Local Ollama uses one request at a time to avoid GPU contention."
  };
}

function isLocalOllamaEndpoint(endpoint) {
  try {
    const url = new URL(String(endpoint || ""));
    return ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "11434";
  } catch {
    return false;
  }
}

function selectPreprocessFiles(files, options = {}) {
  const maxFiles = Math.max(0, Math.min(files.length, Number(options.maxFiles) || 0));
  const explicitIds = Array.isArray(options.fileIds) ? new Set(options.fileIds.map(String)) : null;
  const source = explicitIds
    ? files.filter((file) => explicitIds.has(file.id))
    : files;
  const pool = source.filter((file) => needsSemanticPreprocess(file, options));
  const ranked = [...pool].sort((a, b) => {
    const attempts = semanticReviewAttempts(a) - semanticReviewAttempts(b);
    if (attempts) return attempts;
    return localHighlightScore(b) - localHighlightScore(a);
  });
  return maxFiles ? ranked.slice(0, maxFiles) : ranked;
}

function semanticReviewAttempts(file) {
  const metadata = file?.metadata || {};
  return Number(metadata.semanticReviewAttemptVersion || 0) === SEMANTIC_REVIEW_VERSION
    ? Math.max(0, Number(metadata.semanticReviewAttempts || 0))
    : 0;
}

function hasVerifiedSemanticReview(file) {
  const metadata = file?.metadata || {};
  const strongVisionScore = metadata.visionApproved === true && Number(metadata.visionScore || 0) >= 70;
  const strongSemanticScore = Number(metadata.semanticScore || 0) >= 70
    && (metadata.ratingSource === "vision-ai" || metadata.ratingConfidence === "high");
  const strongSummaryPayoff = metadata.semanticTraits?.payoffVerified === true
    && Number(metadata.semanticScore || 0) >= 70
    && Number(metadata.semanticRating?.trailerUsefulness || 0) >= 70
    && String(metadata.semanticRating?.excludeReason || "none").toLowerCase() === "none";
  return metadata.semanticQuality === "verified"
    || strongVisionScore
    || strongSemanticScore
    || strongSummaryPayoff
    || (metadata.semanticEvents || []).some((event) => event?.payoffVerified === true);
}

function needsSemanticPreprocess(file, options = {}) {
  const metadata = file?.metadata || {};
  if (!file || looksLikePreviousExport(file.name)) return false;
  if (!metadata.duration || metadata.videoCodec === "pending") return false;
  if (hasVerifiedSemanticReview(file)) return false;
  const reviewedWithCurrentPrompt = Number(metadata.semanticReviewVersion || 0) >= SEMANTIC_REVIEW_VERSION;
  if (reviewedWithCurrentPrompt && semanticReviewAttempts(file) >= MAX_SEMANTIC_REVIEW_ATTEMPTS && !metadata.semanticReviewLastError) return false;
  if (options.refineReviewed) {
    if (!reviewedWithCurrentPrompt || Number(metadata.semanticFramesReviewed || 0) <= 0) return false;
    if (metadata.semanticFineReviewed === true) return false;
    return hasPotentialSemanticTimeline(file);
  }
  if (reviewedWithCurrentPrompt && Number(metadata.semanticFramesReviewed || 0) > 0 && !options.refineReviewed) return false;
  return true;
}

function hasPotentialSemanticTimeline(file) {
  const metadata = file?.metadata || {};
  const overlapsRejected = (event) => (metadata.rejectedHighlightMoments || []).some((item) =>
    item?.reason === "not-highlight" &&
    Math.max(Number(item.start) || 0, Number(event?.start) || 0) < Math.min(Number(item.end) || (Number(item.start) || 0) + (Number(item.duration) || 0), Number(event?.end) || (Number(event?.start) || 0) + (Number(event?.duration) || 0)) - 0.75
  );
  return [
    ...(metadata.semanticEvents || []),
    ...(metadata.semanticCandidateHistory || []),
    ...(metadata.candidateWindows || [])
  ].some((event) =>
    !overlapsRejected(event) &&
    Number.isFinite(Number(event?.start)) &&
    Number.isFinite(Number(event?.end)) &&
    Number(event.end) > Number(event.start)
  );
}

function isTransientVisionFailure(message = "") {
  return /fetch failed|timeout|timed out|aborted|terminated|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(String(message));
}

function localHighlightScore(file) {
  const metadata = file?.metadata || {};
  return Number(metadata.indexScore || metadata.actionScore || metadata.qualityScore || metadata.semanticScore || 0);
}

function looksLikePreviousExport(name = "") {
  return /(?:vision reviewed|created with highlightai|highlightai export|trailer - vision|assets\.json|^warsaw\b.*trailer)/i.test(name);
}

function buildPreprocessBatches(files, sampleInterval, maxFrames = 0, options = {}) {
  const refineReviewed = options.refineReviewed === true;
  const maxPerFile = refineReviewed ? 18 : 12;
  const minPerFile = maxFrames ? 1 : refineReviewed ? 8 : 3;
  const framesPerFile = maxFrames
    ? Math.max(minPerFile, Math.min(maxPerFile, Math.floor(maxFrames / Math.max(1, files.length))))
    : refineReviewed ? 14 : 6;
  const perFile = files.map((file) => ({
    file,
    times: adaptiveFrameTimes(file, sampleInterval, framesPerFile, { refineReviewed, explicitFrameBudget: Boolean(maxFrames) }).sort((a, b) => a - b)
  })).filter((item) => item.times.length > 0);
  const limited = [];
  let frameCount = 0;
  for (const item of perFile) {
    if (maxFrames && frameCount >= maxFrames) break;
    const remaining = maxFrames ? Math.max(0, maxFrames - frameCount) : item.times.length;
    const times = item.times.slice(0, remaining);
    if (!times.length) continue;
    limited.push({ file: item.file, times });
    frameCount += times.length;
  }
  const batches = [];
  const batchSize = refineReviewed ? 1 : framesPerFile > 6 ? 1 : framesPerFile > 4 ? 2 : 4;
  for (let index = 0; index < limited.length; index += batchSize) {
    batches.push({ items: limited.slice(index, index + batchSize) });
  }
  return batches;
}

function adaptiveFrameTimes(file, interval, budget, options = {}) {
  if (options.refineReviewed) return denseCandidateFrameTimes(file, budget, options.explicitFrameBudget ? 0 : 8);
  const hasIndexedCandidates = candidateReviewWindows(file).some((window) => window.source !== "fallback");
  if (hasIndexedCandidates) return denseCandidateFrameTimes(file, budget, 0);
  return prioritizedFrameTimes(file, interval).slice(0, budget);
}

function denseCandidateFrameTimes(file, budget = 18, minimumReturned = 8) {
  const duration = Math.max(0, Number(file.metadata?.duration) || 0);
  if (duration < 2) return [];
  const times = [];
  const add = (time, minGap = 0.45) => {
    const safe = Math.max(0.5, Math.min(duration - 0.5, Number(time) || 0));
    if (!Number.isFinite(safe) || safe >= duration) return;
    if (!times.some((existing) => Math.abs(existing - safe) < minGap)) {
      times.push(Math.round(safe * 10) / 10);
    }
  };

  const windows = candidateReviewWindows(file)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  for (const window of windows) {
    const start = Math.max(0, Number(window.start) || 0);
    const end = Math.min(duration, Number(window.end) || start + Number(window.duration) || start + 8);
    const span = Math.max(1.5, end - start);
    add(start - 2);
    add(start);
    add(start + span * 0.25);
    add(start + span * 0.5);
    add(start + span * 0.75);
    add(end);
    add(end + 2);
    add(end + 5);
  }

  for (const event of file.metadata?.semanticCandidateHistory || []) {
    const start = Math.max(0, Number(event.start) || 0);
    const end = Math.min(duration, Number(event.end) || start + 8);
    const impact = Number(event.impactTime);
    add(start - 1.5);
    add(start);
    add(Number.isFinite(impact) ? impact : start + (end - start) * 0.65);
    add(end);
    add(end + 3);
  }

  if (Number.isFinite(file.metadata?.highlightStart)) {
    add(file.metadata.highlightStart - 4);
    add(file.metadata.highlightStart);
    add(file.metadata.highlightStart + 4);
    add(file.metadata.highlightStart + 8);
  }

  const broadCoverage = [0.12, 0.28, 0.45, 0.62, 0.78, 0.92].map((ratio) => duration * ratio);
  const topWindows = windows.slice(0, 2);
  const focus = topWindows.length
    ? topWindows.reduce((sum, window) => sum + (Number(window.start) + Number(window.end || window.start + window.duration || 0)) / 2, 0) / topWindows.length
    : Number(file.metadata?.highlightStart ?? duration * 0.65);
  const ranked = [...times].sort((a, b) =>
    Math.min(...windows.map((window) => distanceToWindow(a, window)), Math.abs(a - focus) * 0.35) -
    Math.min(...windows.map((window) => distanceToWindow(b, window)), Math.abs(b - focus) * 0.35)
  );
  const selected = [];
  const push = (time, minGap = 0.55) => {
    const safe = Math.round(Math.max(0.5, Math.min(duration - 0.5, Number(time) || 0)) * 10) / 10;
    if (!selected.some((existing) => Math.abs(existing - safe) < minGap)) selected.push(safe);
  };
  ranked.forEach((time) => push(time));
  broadCoverage.forEach((time) => push(time, 1.2));
  prioritizedFrameTimes(file, Math.max(4, Math.min(10, duration / 8))).forEach((time) => push(time, 0.9));
  const target = Math.max(Math.min(24, minimumReturned), Math.min(24, budget));
  return selected.slice(0, target).sort((a, b) => a - b);
}

function candidateReviewWindows(file) {
  const duration = Math.max(0, Number(file.metadata?.duration) || 0);
  const windows = [];
  const overlapsRejected = (start, end) => (file.metadata?.rejectedHighlightMoments || []).some((item) =>
    item?.reason === "not-highlight" &&
    Math.max(Number(item.start) || 0, start) < Math.min(Number(item.end) || (Number(item.start) || 0) + (Number(item.duration) || 0), end) - 0.75
  );
  for (const window of file.metadata?.candidateWindows || []) {
    const start = Math.max(0, Number(window.start) || 0);
    const end = Math.min(duration, Number(window.end) || start + Number(window.duration) || start + 8);
    if (overlapsRejected(start, end)) continue;
    windows.push({
      start,
      end,
      duration: Math.max(1, end - start),
      score: Number(window.score || 0),
      source: "candidate-window"
    });
  }
  for (const event of [...(file.metadata?.semanticEvents || []), ...(file.metadata?.semanticCandidateHistory || [])]) {
    const start = Math.max(0, Number(event.start) || 0);
    const end = Math.min(duration, Number(event.end) || start + 8);
    if (overlapsRejected(start, end)) continue;
    windows.push({
      start,
      end,
      duration: Math.max(1, end - start),
      score: Number(event.score || 55) + (event.payoffVerified ? 30 : 0),
      source: "semantic-event"
    });
  }
  if (!windows.length) {
    const start = Math.max(0, Math.min(duration - 12, Number(file.metadata?.highlightStart ?? duration * 0.65) - 5));
    windows.push({ start, end: Math.min(duration, start + 12), duration: Math.min(12, duration - start), score: 45, source: "fallback" });
  }
  const unique = [];
  for (const window of windows.sort((a, b) => b.score - a.score)) {
    const overlaps = unique.some((item) => Math.max(item.start, window.start) < Math.min(item.end, window.end) - 2);
    if (!overlaps) unique.push(window);
  }
  return unique;
}

function distanceToWindow(time, window) {
  const start = Number(window.start) || 0;
  const end = Number(window.end) || start + Number(window.duration) || start;
  if (time >= start && time <= end) return 0;
  return Math.min(Math.abs(time - start), Math.abs(time - end));
}

function prioritizedFrameTimes(file, interval) {
  const duration = Math.max(0, Number(file.metadata?.duration) || 0);
  const times = new Set();
  const add = (time) => {
    const safe = Math.max(0.5, Math.min(duration - 0.5, Number(time) || 0));
    if (safe < duration) times.add(Math.round(safe * 10) / 10);
  };
  const previousMiss = Number(file.metadata?.semanticFramesReviewed || 0) > 0
    && !(file.metadata?.semanticEvents || []).length;
  const previousTime = Number(file.metadata?.semanticTopFrame);
  const legacyEvents = [
    ...(file.metadata?.semanticEvents || []),
    ...(file.metadata?.semanticCandidateHistory || [])
  ]
    .filter((event) => event.payoffVerified !== true)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const legacyFocus = legacyEvents[0];
  if (legacyFocus) {
    const start = Math.max(0, Number(legacyFocus.start) || 0);
    const end = Math.min(duration, Number(legacyFocus.end) || start + 8);
    const span = Math.max(1, end - start);
    for (const ratio of [0, 0.14, 0.28, 0.43, 0.58, 0.72, 0.86, 1]) add(start + span * ratio);
    add(end + 2);
    add(end + 4);
  }
  const windows = [...(file.metadata?.candidateWindows || [])]
    .sort((a, b) => {
      if (previousMiss && Number.isFinite(previousTime)) {
        const aCenter = (Number(a.start) + Number(a.end)) / 2;
        const bCenter = (Number(b.start) + Number(b.end)) / 2;
        return Math.abs(bCenter - previousTime) - Math.abs(aCenter - previousTime);
      }
      return Number(b.score || 0) - Number(a.score || 0);
    })
    .slice(0, 4);
  const focusWindow = windows[0];
  if (focusWindow) {
    const start = Math.max(0, Number(focusWindow.start) || 0);
    const end = Math.min(duration, Number(focusWindow.end) || start + Number(focusWindow.duration) || 8);
    const span = Math.max(1, end - start);
    add(start);
    add(start + span * 0.18);
    add(start + span * 0.35);
    add(start + span * 0.5);
    add(start + span * 0.65);
    add(start + span * 0.82);
    add(end);
    add(end + 2);
    add(end + 4);
  }
  for (const window of windows.slice(1)) {
    const start = Math.max(0, Number(window.start) || 0);
    const end = Math.min(duration, Number(window.end) || start + Number(window.duration) || 8);
    add(start + Math.max(1, end - start) * 0.5);
  }
  if (Number.isFinite(file.metadata?.highlightStart)) {
    add(file.metadata.highlightStart - 2);
    add(file.metadata.highlightStart);
    add(file.metadata.highlightStart + 3);
  }
  for (const time of frameTimes(duration, interval)) add(time);
  const focus = legacyFocus
    ? (Number(legacyFocus.start || 0) + Number(legacyFocus.end || legacyFocus.start || 0)) / 2
    : Number(file.metadata?.highlightStart ?? duration * 0.65);
  const focused = [...times].sort((a, b) => Math.abs(a - focus) - Math.abs(b - focus));
  if (legacyFocus && file.metadata?.semanticFineReviewed !== true) return focused;

  const broad = [0.08, 0.2, 0.35, 0.5, 0.65, 0.8, 0.92]
    .map((ratio) => Math.round(Math.max(0.5, Math.min(duration - 0.5, duration * ratio)) * 10) / 10);
  const ordered = [];
  const pushUnique = (time) => {
    if (!ordered.some((existing) => Math.abs(existing - time) < 0.2)) ordered.push(time);
  };
  focused.slice(0, 4).forEach(pushUnique);
  broad.forEach(pushUnique);
  focused.forEach(pushUnique);
  return ordered;
}

async function processPreprocessJob(id) {
  const controller = new AbortController();
  activePreprocessControllers.set(id, controller);
  const job = await loadPreprocessJob(id);
  if (controller.signal.aborted || !canStartBackgroundJob(job, ["processing"])) {
    activePreprocessControllers.delete(id);
    return;
  }
  activePreprocessJobs.set(job.projectId, id);
  try {
    await processPreprocessJobWork(id, controller.signal);
  } finally {
    activePreprocessControllers.delete(id);
    if (activePreprocessJobs.get(job.projectId) === id) activePreprocessJobs.delete(job.projectId);
    const latest = await loadPreprocessJob(id).catch(() => null);
    if (!latest || latest.status !== "paused") preprocessSecrets.delete(id);
    await rm(path.join(preprocessRoot, job.projectId), { recursive: true, force: true }).catch(() => undefined);
  }
}

async function processPreprocessJobWork(id, signal) {
  const job = await loadPreprocessJob(id);
  const project = await loadProject(job.projectId);
  const safeEndpoint = new URL(job.endpoint);
  const secret = preprocessSecrets.get(id) || { apiKey: "" };
  const selectedFiles = selectPreprocessFiles(project.files, job)
    .filter((file) => file.metadata?.semanticIndexJobId !== id);
  project.gameProfile = project.gameProfile || inferGameProfile(project);
  const batches = buildPreprocessBatches(selectedFiles, job.sampleInterval, job.maxFrames, job);
  const started = Date.now();
  const maxRuntimeMs = Math.max(30, Number(job.maxRuntimeSeconds || DEFAULT_MAX_VISION_CHECK_SECONDS)) * 1000;
  const deadline = started + maxRuntimeMs;
  const baselineProcessedRequests = Number(job.processedRequests || 0);
  const active = new Set();
  let cursor = 0;
  let timeLimitHit = false;
  let processedFrames = Number(job.processedFrames || 0);
  let processedRequests = Number(job.processedRequests || 0);
  let approvedFrames = Number(job.approvedFrames || 0);
  let rejectedFrames = Number(job.rejectedFrames || 0);
  let processedFiles = Number(job.processedFiles || 0);
  let eventsFound = Number(job.eventsFound || 0);
  let saveQueue = Promise.resolve();

  const updateProgress = (mutator) => {
    saveQueue = saveQueue.then(async () => {
      const current = await loadPreprocessJob(id);
      if (current.cancelRequested || signal.aborted) throw new DOMException("Operation cancelled", "AbortError");
      mutator(current);
      const elapsedSeconds = Math.max(1, (Date.now() - started) / 1000);
      const remaining = Math.max(0, current.totalRequests - current.processedRequests);
      const processedThisRun = Math.max(0, current.processedRequests - baselineProcessedRequests);
      current.etaSeconds = processedThisRun > 0
        ? Math.ceil((elapsedSeconds / processedThisRun) * remaining)
        : current.estimatedSeconds;
      current.activeFiles = [...active].slice(0, 4);
      await savePreprocessJob(current);
      return current;
    });
    return saveQueue;
  };

  const persistBatch = async (batch, batchReviews) => {
    for (const item of batch.items) {
      const fileReviews = batchReviews.get(item.file.id) || [];
      if (!fileReviews.length) continue;
      const summary = summarizeFrameReviews(fileReviews, project.gameProfile);
      const file = project.files.find((candidate) => candidate.id === item.file.id);
      if (!file) continue;
      const wasFinePass = Boolean(file.metadata?.semanticCandidateHistory?.length)
        && !(file.metadata?.semanticEvents || []).some((event) => event.payoffVerified === true)
        && file.metadata?.semanticFineReviewed !== true;
      const semanticCandidateHistory = [
        ...(file.metadata?.semanticCandidateHistory || []),
        ...(file.metadata?.semanticEvents || []),
        ...(summary.weakCandidates || []),
        ...(summary.events || [])
      ].filter((event, index, list) =>
        event && list.findIndex((candidate) =>
          Math.abs(Number(candidate.start || 0) - Number(event.start || 0)) < 0.2 &&
          Math.abs(Number(candidate.end || 0) - Number(event.end || 0)) < 0.2
        ) === index
      ).slice(-8);
      const previousAttemptVersion = Number(file.metadata?.semanticReviewAttemptVersion || 0);
      const previousAttempts = previousAttemptVersion === SEMANTIC_REVIEW_VERSION
        ? Number(file.metadata?.semanticReviewAttempts || 0)
        : 0;
      Object.assign(file.metadata, {
        semanticFramesReviewed: item.times.length,
        semanticReviewVersion: SEMANTIC_REVIEW_VERSION,
        semanticReviewAttemptVersion: SEMANTIC_REVIEW_VERSION,
        semanticReviewAttempts: previousAttempts + 1,
        semanticReviewedAt: new Date().toISOString(),
        semanticScore: summary.score,
        semanticQuality: summary.quality,
        semanticVerifiedEventCount: summary.verifiedEventCount,
        semanticWeakCandidateCount: summary.weakCandidateCount,
        semanticRating: summary.rating,
        semanticTopFrame: summary.topFrame,
        semanticRejectReason: summary.rejectReason,
        semanticReviewLastError: null,
        semanticTraits: summary.traits,
        semanticTags: summary.tags,
        indexTags: summary.tags,
        semanticEvents: summary.events,
        semanticCandidateHistory,
        semanticFineReviewed: job.refineReviewed === true || wasFinePass || summary.events.some((event) => event.payoffVerified === true),
        semanticIndexJobId: id
      });
      processedFiles += 1;
      eventsFound += summary.events.length;
    }
    normalizeAiDecisions(project);
    project.analysis = buildAnalysis(project.files);
    project.gameProfile = refineGameProfile(project.gameProfile, project.files);
    await saveProject(project);
  };

  const worker = async () => {
    while (cursor < batches.length && !signal.aborted) {
      if (Date.now() >= deadline) {
        timeLimitHit = true;
        break;
      }
      const batch = batches[cursor++];
      for (const item of batch.items) active.add(item.file.name);
      const first = batch.items[0];
      await updateProgress((current) => {
        current.phase = "reviewing_frames";
        current.currentFile = batch.items.map((item) => item.file.name).join(", ");
        current.currentFrameTime = first?.times[0] ?? null;
      });
      const frameCount = batch.items.reduce((sum, item) => sum + item.times.length, 0);
      try {
        const batchReviews = await reviewBatchWithRetry({
          endpoint: safeEndpoint,
          apiKey: secret.apiKey,
          model: job.model,
          projectId: project.id,
          batch,
          gameProfile: project.gameProfile,
          referenceStyle: job.referenceStyle,
          signal
        });
        if (signal.aborted) return;
        for (const reviews of batchReviews.values()) {
          for (const review of reviews) {
            if (review.approved) approvedFrames += 1;
            else rejectedFrames += 1;
          }
        }
        await persistBatch(batch, batchReviews);
      } catch (error) {
        if (signal.aborted || error?.name === "AbortError") return;
        rejectedFrames += frameCount;
        const message = error instanceof Error ? error.message.slice(0, 260) : "Vision model batch review failed.";
        const transientFailure = isTransientVisionFailure(message);
        const now = new Date().toISOString();
        for (const item of batch.items) {
          const file = project.files.find((candidate) => candidate.id === item.file.id);
          if (!file) continue;
          const previousAttemptVersion = Number(file.metadata?.semanticReviewAttemptVersion || 0);
          const previousAttempts = previousAttemptVersion === SEMANTIC_REVIEW_VERSION
            ? Number(file.metadata?.semanticReviewAttempts || 0)
            : 0;
          const nextAttempts = transientFailure ? previousAttempts : previousAttempts + 1;
          Object.assign(file.metadata, {
            semanticReviewVersion: SEMANTIC_REVIEW_VERSION,
            semanticReviewAttemptVersion: SEMANTIC_REVIEW_VERSION,
            semanticReviewAttempts: nextAttempts,
            semanticReviewedAt: now,
            semanticReviewLastError: message,
            semanticQuality: !transientFailure && nextAttempts >= MAX_SEMANTIC_REVIEW_ATTEMPTS ? "missed" : file.metadata?.semanticQuality,
            semanticIndexJobId: id
          });
        }
        processedFiles += batch.items.length;
        project.analysis = buildAnalysis(project.files);
        await saveProject(project);
        await updateProgress((current) => {
          for (const item of batch.items) {
            current.failures.push({
              fileId: item.file.id,
              name: item.file.name,
              time: item.times[0],
              phase: "vision",
              message
            });
          }
        });
      } finally {
        for (const item of batch.items) active.delete(item.file.name);
      }
      if (signal.aborted) return;
      processedFrames += frameCount;
      processedRequests += 1;
      await updateProgress((current) => {
        current.processedFiles = processedFiles;
        current.processedFrames = processedFrames;
        current.processedRequests = processedRequests;
        current.approvedFrames = approvedFrames;
        current.rejectedFrames = rejectedFrames;
        current.eventsFound = eventsFound;
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(job.concurrency, batches.length) }, () => worker()));
  const current = await loadPreprocessJob(id);
  if (current.cancelRequested || signal.aborted) return;
  if (timeLimitHit || processedRequests < current.totalRequests) {
    current.failures = [...(current.failures || []), {
      name: "Vision AI time limit",
      phase: "vision",
      message: `Vision AI reached the ${Math.round(maxRuntimeMs / 1000)} second check limit. Saved completed reviews and stopped safely.`
    }];
  }
  current.status = current.failures.length ? "completed_with_warnings" : "completed";
  current.phase = "completed";
  current.processedFiles = processedFiles;
  current.processedFrames = processedFrames;
  current.processedRequests = processedRequests;
  current.eventsFound = eventsFound;
  current.etaSeconds = 0;
  current.currentFile = null;
  current.currentFrameTime = null;
  current.activeFiles = [];
  current.completedAt = new Date().toISOString();
  current.result = { projectId: project.id, eventsFound, approvedFrames, rejectedFrames };
  await savePreprocessJob(current);
}

async function reviewBatchWithRetry(options, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await reviewBatchWithModel(options);
    } catch (error) {
      if (options.signal?.aborted || error?.name === "AbortError") throw error;
      lastError = error;
      if (attempt >= attempts) break;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, attempt * 2500);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          const abortError = new Error("Aborted");
          abortError.name = "AbortError";
          reject(abortError);
        }, { once: true });
      });
    }
  }
  throw lastError || new Error("Vision model batch review failed after retries.");
}

function frameTimes(duration, interval) {
  const safeDuration = Math.max(0, Number(duration) || 0);
  if (safeDuration < 2) return [];
  const times = [];
  for (let time = Math.min(1, safeDuration - 1); time < safeDuration - 0.5; time += interval) {
    times.push(Math.round(time * 10) / 10);
  }
  return times;
}

async function ensureFrame(projectId, file, time, signal) {
  const frameDir = path.join(preprocessRoot, projectId, file.id);
  await mkdir(frameDir, { recursive: true });
  const framePath = path.join(frameDir, `${String(time).replace(".", "_")}.jpg`);
  try {
    const info = await stat(framePath);
    if (info.size > 0) return framePath;
  } catch {
    // Cache miss.
  }
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", file.path,
    "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "5", framePath
  ], { signal });
  return framePath;
}

function reviewFrameTimes(file, segment) {
  const segmentStart = Math.max(0, Number(segment.start) || 0);
  const segmentEnd = Math.min(
    Number(file.metadata?.duration) || segmentStart + Number(segment.duration) || segmentStart + 1,
    segmentStart + Math.max(1, Number(segment.duration) || 1)
  );
  const verifiedEvents = (file.metadata?.semanticEvents || [])
    .filter((event) => event.payoffVerified === true)
    .map((event) => {
      const start = Math.max(segmentStart, Number(event.start) || segmentStart);
      const end = Math.min(segmentEnd, Number(event.end) || segmentEnd);
      return { ...event, start, end, overlap: Math.max(0, end - start) };
    })
    .filter((event) => event.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || Number(b.score || 0) - Number(a.score || 0));
  const event = verifiedEvents[0];
  if (!event) {
    const ratios = [0.03, 0.22, 0.43, 0.64, 0.84, 0.98];
    return {
      action: "proposed gameplay moment",
      times: ratios.map((ratio) => segmentStart + (segmentEnd - segmentStart) * ratio)
    };
  }

  const eventDuration = Math.max(0.5, event.end - event.start);
  const candidates = [
    segmentStart + 0.1,
    Math.max(segmentStart, event.start - 0.15),
    event.start + eventDuration * 0.28,
    event.start + eventDuration * 0.56,
    event.start + eventDuration * 0.82,
    Math.min(segmentEnd, event.end - 0.1),
  ];
  const times = [];
  for (const time of candidates) {
    const bounded = Math.max(segmentStart, Math.min(segmentEnd - 0.05, time));
    if (!times.some((existing) => Math.abs(existing - bounded) < 0.08)) times.push(bounded);
  }
  while (times.length < 6) {
    const ratio = times.length / 5;
    const time = segmentStart + (segmentEnd - segmentStart) * ratio;
    if (!times.some((existing) => Math.abs(existing - time) < 0.08)) times.push(time);
    else break;
  }
  return {
    action: event.action || "verified gameplay payoff",
    times: times.sort((a, b) => a - b).slice(0, 6)
  };
}

async function reviewPlannedTimelineWithModel({ project, draft, endpoint, apiKey, model, signal, approvedIntervalKeys = new Set() }) {
  const segments = (draft.segments || []).slice(0, 20);
  if (!segments.length) return { score: 0, approved: false, rejectSegmentIndexes: [], problems: ["No timeline segments were available."] };
  const intervalKey = (segment) => `${segment.fileId}:${Math.round(segment.start)}:${Math.round(segment.duration)}`;
  const pendingSegments = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => !approvedIntervalKeys.has(intervalKey(segment)));
  if (!pendingSegments.length) {
    return { score: 100, rawScore: 100, approved: true, rejectSegmentIndexes: [], approvedSegmentIndexes: [], problems: [] };
  }
  const gameProfile = refineGameProfile(project.gameProfile || inferGameProfile(project), project.files || []);
  const framePaths = [];
  try {
    const rejected = new Set();
    const problems = [];
    const scores = [];
    const rawScores = [];
    const approvedIndexes = new Set();
    const trimEdits = [];
    for (let offset = 0; offset < pendingSegments.length; offset += 3) {
      const group = pendingSegments.slice(offset, offset + 3);
      const tiles = [];
      const expectedActions = [];
      for (let row = 0; row < group.length; row += 1) {
        const { segment, index: segmentIndex } = group[row];
        const file = project.files.find((item) => item.id === segment.fileId);
        if (!file) continue;
        const review = reviewFrameTimes(file, segment);
        expectedActions.push(`Shot ${segmentIndex + 1}: ${review.action}`);
        for (let column = 0; column < review.times.length; column += 1) {
          const time = Math.min(file.metadata.duration - 0.05, review.times[column]);
          const framePath = await ensureFrame(project.id, file, time, signal);
          framePaths.push(framePath);
          const label = Buffer.from(
            `<svg width="160" height="90"><rect width="160" height="17" fill="rgba(0,0,0,.78)"/><text x="4" y="12" fill="white" font-size="8" font-family="Arial">Shot ${segmentIndex + 1} / ${column + 1} / ${formatTimestamp(time)}</text></svg>`
          );
          const tile = await sharp(framePath)
            .resize(160, 90, { fit: "cover" })
            .composite([{ input: label, left: 0, top: 0 }])
            .jpeg({ quality: 74, mozjpeg: true })
            .toBuffer();
          tiles.push({ input: tile, left: column * 160, top: row * 90 });
        }
      }
      const sheet = await sharp({
        create: {
          width: 960,
          height: Math.max(90, group.length * 90),
          channels: 3,
          background: { r: 10, g: 12, b: 14 }
        }
      }).composite(tiles).jpeg({ quality: 76, mozjpeg: true }).toBuffer();
      const prompt = [
        "You are the final visual proxy review team for a professional automatic game trailer editor.",
        "Each row is one proposed shot. Its six frames are chronological and concentrated around the stored verified event, including setup, impact, and reaction context.",
        `The rows in this sheet are global shot numbers ${group.map((item) => item.index + 1).join(", ")}. Return those exact global numbers as segmentIndex.`,
        `Expected event labels are hints, not proof: ${expectedActions.join("; ")}.`,
        "Judge every row independently. Adjacent rows are different source shots, so do not reject one because it does not continue the other.",
        "Reject a row if it shows irrelevant interface screens, loading, inactivity, death state, long walking/travel, obstruction, repetition, or setup whose visible payoff is missing by the last frame.",
        "If only the lead-in or tail is boring but the row contains a usable payoff, approve the row and return a trim edit with absolute source timestamps. Trim walking, death screens, menus, waiting, and boring tails out of the kept range.",
        `Detected game type: ${gameProfile.label} (${gameProfile.genre}).`,
        downtimeGuidance(gameProfile),
        payoffGuidance(gameProfile),
        "Do not require military combat outcomes in non-military games. Judge completion using the detected game's own objectives and audience expectations.",
        "Return JSON only:",
        "{\"score\":0-100,\"segments\":[{\"segmentIndex\":1,\"approved\":boolean,\"payoffVerified\":boolean,\"boring\":boolean,\"reason\":\"specific visible evidence\",\"trimStart\":0,\"trimEnd\":0}],\"trimSegmentEdits\":[{\"segmentIndex\":1,\"start\":0,\"end\":0,\"reason\":\"what was trimmed\"}],\"problems\":[\"specific visible problem\"]}.",
        "Use trimStart/trimEnd and trimSegmentEdits only as absolute source-video timestamps inside that shot's shown range. Omit trim values when no trim is needed.",
        "Do not return placeholder words such as short, reason, or problem. The reason must name concrete visible evidence from this shot.",
        "Approval-quality footage needs readable action, escalation, a completed payoff, and no boring interface or traversal frames.",
        "Keep the decision internally consistent: a fully approved professional-quality shot should score 90-100; any shot below that standard must be rejected with specific visible evidence."
      ].join(" ");
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        signal,
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${sheet.toString("base64")}` } }
            ]
          }],
          temperature: 0.1,
          max_tokens: 900
        })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error?.message || "Vision proxy review failed.");
      const parsed = JSON.parse(String(json.choices?.[0]?.message?.content || "{}").replace(/^```json\s*|\s*```$/g, ""));
      const parsedSegments = Array.isArray(parsed.segments) ? parsed.segments : [];
      const rawScore = Math.max(0, Math.min(100, Number(parsed.score) || 0));
      const allRowsExplicitlyApproved = parsedSegments.length === group.length
        && parsedSegments.every((item) => item.approved === true && item.boring !== true && item.payoffVerified !== false);
      rawScores.push(rawScore);
      scores.push(allRowsExplicitlyApproved ? Math.max(90, rawScore) : rawScore);
      const returnedIndexes = new Set(parsedSegments.map((item) => Number(item.segmentIndex)));
      for (const { index } of group) {
        const globalIndex = index + 1;
        if (!returnedIndexes.has(globalIndex)) {
          rejected.add(globalIndex);
          problems.push(`Shot ${globalIndex}: Vision model omitted this row from its structured response.`);
        }
      }
      for (const item of parsedSegments) {
        let index = Number(item.segmentIndex);
        if (!Number.isInteger(index) || index < 1 || index > segments.length) continue;
        if (!item.approved || item.boring || item.payoffVerified === false) rejected.add(index);
        else approvedIndexes.add(index);
        const trimStart = Number(item.trimStart);
        const trimEnd = Number(item.trimEnd);
        if (Number.isFinite(trimStart) || Number.isFinite(trimEnd)) {
          const segment = segments[index - 1];
          const start = Number.isFinite(trimStart) ? trimStart : Number(segment.start) || 0;
          const end = Number.isFinite(trimEnd) ? trimEnd : (Number(segment.start) || 0) + (Number(segment.duration) || 0);
          if (end > start) {
            trimEdits.push({
              segmentIndex: index,
              start,
              end,
              reason: String(item.reason || "Final review trimmed this shot.").slice(0, 150)
            });
          }
        }
        if (item.reason && (!item.approved || item.boring || item.payoffVerified === false)) {
          problems.push(`Shot ${index}: ${String(item.reason).slice(0, 150)}`);
        }
      }
      for (const item of Array.isArray(parsed.trimSegmentEdits) ? parsed.trimSegmentEdits : []) {
        const index = Number(item.segmentIndex);
        if (!Number.isInteger(index) || index < 1 || index > segments.length) continue;
        const start = Number(item.start ?? item.trimStart ?? item.keepStart);
        const end = Number(item.end ?? item.trimEnd ?? item.keepEnd);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          trimEdits.push({
            segmentIndex: index,
            start,
            end,
            reason: String(item.reason || "Final review trimmed boring footage.").slice(0, 150)
          });
        }
      }
      for (const problem of Array.isArray(parsed.problems) ? parsed.problems : []) {
        problems.push(String(problem).slice(0, 180));
      }
    }
    const score = scores.length
      ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length)
      : 0;
    const rawScore = rawScores.length
      ? Math.round(rawScores.reduce((sum, value) => sum + value, 0) / rawScores.length)
      : 0;
    return {
      score,
      rawScore,
      approved: score >= 90 && rejected.size === 0,
      rejectSegmentIndexes: [...rejected].slice(0, 12),
      approvedSegmentIndexes: [...approvedIndexes],
      trimSegmentEdits: trimEdits.slice(0, 12),
      problems: problems.slice(0, 12)
    };
  } finally {
    await Promise.all(framePaths.map((framePath) => rm(framePath, { force: true }).catch(() => undefined)));
  }
}

async function reviewRenderedDraftWithModel({ endpoint, apiKey, model, outputPath, draft }) {
  const sheetPath = path.join(preprocessRoot, `draft-review-${randomUUID()}.jpg`);
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", outputPath,
    "-vf", "fps=1/12,scale=320:-1,tile=5x5",
    "-frames:v", "1", sheetPath
  ]);
  const image = (await readFile(sheetPath)).toString("base64");
  await rm(sheetPath, { force: true }).catch(() => undefined);
  const prompt = [
    "You are a professional post-render review panel for an automatic game highlight editor.",
    "The contact sheet samples the rendered video in chronological order. Judge the finished cut, not the source folder.",
    "The director reviewer must evaluate story clarity, pacing, music-fit, payoff preservation, boring-shot removal, and whether shots are cut before the exciting result.",
    "The three audience reviewers represent: a casual viewer, a competitive player, and a cinematic trailer fan.",
    "Score each reviewer from 0 to 100. Average score >= 90 means the draft is good enough to export. Under 90 requires revision.",
    "Penalize irrelevant interface frames, inactivity, repetition, unclear visuals, missing context, and cuts that skip the game-specific result.",
    "Reward clear mini-stories, readable skill or stakes, anticipation before the decisive action, visible consequences, reaction, variety, rhythm with music, and trailer-like escalation.",
    `Draft title: ${draft.title}. Duration: ${Math.round(draft.duration)} seconds. Style: ${draft.style}.`,
    "Return only compact JSON: {\"averageScore\":0-100,\"approved\":boolean,\"director\":{\"score\":0-100,\"opinion\":\"short\"},\"audience\":[{\"persona\":\"casual viewer\",\"score\":0-100,\"opinion\":\"short\"},{\"persona\":\"competitive player\",\"score\":0-100,\"opinion\":\"short\"},{\"persona\":\"cinematic trailer fan\",\"score\":0-100,\"opinion\":\"short\"}],\"problems\":[\"short\"],\"revisionPlan\":\"specific edit instructions\"}"
  ].join(" ");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }
        ]
      }],
      temperature: 0.15
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error?.message || "Draft review model request failed.");
  const content = json.choices?.[0]?.message?.content || "{}";
  return normalizeDraftReview(JSON.parse(String(content).replace(/^```json\s*|\s*```$/g, "")));
}

function normalizeDraftReview(review) {
  const director = review.director || {};
  const audience = Array.isArray(review.audience) ? review.audience.slice(0, 3) : [];
  const reviewers = [
    { persona: "director", score: Number(director.score), opinion: director.opinion },
    ...audience.map((item, index) => ({ persona: item.persona || ["casual viewer", "competitive player", "cinematic trailer fan"][index] || "audience", score: Number(item.score), opinion: item.opinion }))
  ];
  const scores = reviewers.map((item) => Math.max(0, Math.min(100, Number(item.score) || 0)));
  const averageScore = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : Math.max(0, Math.min(100, Number(review.averageScore) || 0));
  return {
    averageScore,
    approved: Boolean(review.approved) && averageScore >= 90,
    director: {
      score: scores[0] || 0,
      opinion: String(director.opinion || "").slice(0, 240)
    },
    audience: reviewers.slice(1, 4).map((item, index) => ({
      persona: String(item.persona || ["casual viewer", "competitive player", "cinematic trailer fan"][index]).slice(0, 60),
      score: scores[index + 1] || 0,
      opinion: String(item.opinion || "").slice(0, 240)
    })),
    problems: (Array.isArray(review.problems) ? review.problems : []).slice(0, 8).map((item) => String(item).slice(0, 180)),
    revisionPlan: String(review.revisionPlan || "").slice(0, 800)
  };
}

async function reviewBatchWithModel({ endpoint, apiKey, model, projectId, batch, gameProfile, referenceStyle, signal }) {
  const framePaths = [];
  try {
    const tiles = [];
    const rows = [];
    const columns = 4;
    const tileWidth = 192;
    const tileHeight = 108;
    const rowsPerClip = Math.max(1, Math.ceil(Math.max(...batch.items.map((item) => item.times.length)) / columns));
    for (let row = 0; row < batch.items.length; row += 1) {
      const item = batch.items[row];
      rows.push({
        clipIndex: row + 1,
        name: item.file.name,
        times: item.times
      });
      for (let column = 0; column < item.times.length; column += 1) {
        if (signal.aborted) throw new DOMException("Operation cancelled", "AbortError");
        const time = item.times[column];
        const framePath = await ensureFrame(projectId, item.file, time, signal);
        framePaths.push(framePath);
        const label = Buffer.from(
          `<svg width="${tileWidth}" height="${tileHeight}"><rect width="${tileWidth}" height="18" fill="rgba(0,0,0,.72)"/><text x="5" y="13" fill="white" font-size="9" font-family="Arial">Clip ${row + 1} / Frame ${column + 1} / ${formatTimestamp(time)}</text></svg>`
        );
        const tile = await sharp(framePath)
          .resize(tileWidth, tileHeight, { fit: "cover" })
          .composite([{ input: label, left: 0, top: 0 }])
          .jpeg({ quality: 68, mozjpeg: true })
          .toBuffer();
        tiles.push({
          input: tile,
          left: (column % columns) * tileWidth,
          top: (row * rowsPerClip + Math.floor(column / columns)) * tileHeight
        });
      }
    }
    const sheet = await sharp({
      create: {
        width: columns * tileWidth,
        height: Math.max(tileHeight, batch.items.length * rowsPerClip * tileHeight),
        channels: 3,
        background: { r: 12, g: 15, b: 17 }
      }
    }).composite(tiles).jpeg({ quality: 70, mozjpeg: true }).toBuffer();
    const prompt = [
      "You are a senior game trailer director reviewing a contact sheet.",
      "Each row is one gameplay clip. Frames in a row are chronological adaptive samples selected from local audio peaks, scene changes, candidate windows, and payoff-expansion points after the candidate window.",
      "For each clip, identify the complete event envelope: where useful action begins, where the main impact occurs, and where the visible result or reaction ends.",
      "Reject rows dominated by irrelevant interface screens, loading, inactivity, repetition, unreadable obstruction, or no visible game-specific payoff.",
      `Detected game type: ${gameProfile.label} (${gameProfile.genre}).`,
      downtimeGuidance(gameProfile),
      payoffGuidance(gameProfile),
      "Prefer visually readable, rare, high-skill, high-stakes, or emotionally clear events that matter in this specific game genre.",
      `Style goal: ${referenceStyle}.`,
      `Rows: ${JSON.stringify(rows)}.`,
      `Game profile: ${gameProfile.label} (${gameProfile.genre}).`,
      `Allowed tag vocabulary: ${gameProfile.tags.join(", ")}.`,
      "Choose 2-5 precise tags only when visibly supported. Prefer the allowed vocabulary. Never use generic tags such as environment, exploration, action, combat, payoff, setup, spectacle, gameplay, or highlight.",
      "Judge every clip independently. Never copy an action, tag, score, or event boundary from another clip in the sheet.",
      "Use sniper shot only when a scoped or clearly long-range precision shot is visible. Use objective capture only when the objective state visibly changes. Use vehicle or aircraft destruction only when destruction is visible.",
      "If the frames do not prove a precise tag, omit it. If they do not prove a complete result, set payoffVerified false.",
      "If an attack is still aiming, launching, or approaching a target in the last sampled frame, set payoffVerified false and do not approve it.",
      "Return JSON only: {\"clips\":[{\"clipIndex\":1,\"bestFrameIndex\":1,\"startFrameIndex\":1,\"impactFrameIndex\":2,\"endFrameIndex\":4,\"payoffVerified\":boolean,\"approved\":boolean,\"score\":0-100,\"tags\":[\"precise tag\"],\"state\":\"menu|scoreboard|map|loading|travel|walking|waiting|setup|aim|combat|impact|reaction|death|other\",\"reason\":\"short\",\"rating\":{\"trailerUsefulness\":0-100,\"excitement\":0-100,\"visualQuality\":0-100,\"novelty\":0-100,\"boredom\":0-100,\"payoffStage\":\"none|setup|anticipation|impact|reaction\",\"excludeReason\":\"none|menu|scoreboard|map|loading|death|boring_travel|walking|waiting|weak_aim|unreadable|duplicate|other\"},\"story\":{\"role\":\"none|setup|anticipation|payoff|reaction\",\"keepWindowSeconds\":0-16,\"needsContextBefore\":0-10,\"needsContextAfter\":0-10,\"cutRisk\":\"low|medium|high\"},\"traits\":{\"subject\":\"player|team|opponent|vehicle|objective|item|environment|interface|other\",\"shotScale\":\"close|medium|wide|long\",\"action\":\"specific visible action\",\"intensity\":0-100,\"spectacle\":0-100,\"clarity\":0-100,\"obstruction\":0-100,\"payoffExpected\":boolean}}]}"
    ].join(" ");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal,
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${sheet.toString("base64")}` } }
          ]
        }],
        temperature: 0.1
      })
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error?.message || "Vision model batch request failed.");
    const content = json.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(String(content).replace(/^```json\s*|\s*```$/g, ""));
    const result = new Map();
    for (let index = 0; index < batch.items.length; index += 1) {
      const item = batch.items[index];
      let raw = (Array.isArray(parsed.clips) ? parsed.clips : []).find((clip) => Number(clip.clipIndex) === index + 1) || {};
      if (raw.approved || raw.payoffVerified) {
        const clipSheet = await sharp(sheet).extract({
          left: 0,
          top: index * rowsPerClip * tileHeight,
          width: columns * tileWidth,
          height: rowsPerClip * tileHeight
        }).jpeg({ quality: 72, mozjpeg: true }).toBuffer();
        const verification = await verifyApprovedClipReview({
          endpoint,
          apiKey,
          model,
          image: clipSheet,
          item,
          gameProfile,
          signal
        });
        raw = {
          ...raw,
          ...verification,
          tags: verification.tags || raw.tags,
          rating: { ...(raw.rating || {}), ...(verification.rating || {}) },
          story: { ...(raw.story || {}), ...(verification.story || {}) },
          traits: { ...(raw.traits || {}), ...(verification.traits || {}) }
        };
      }
      const bestIndex = Math.max(0, Math.min(item.times.length - 1, Number(raw.bestFrameIndex || 1) - 1));
      const frameIndex = (value, fallback) => Math.max(0, Math.min(item.times.length - 1, Number(value || fallback) - 1));
      const normalized = normalizeVisionReview(raw, gameProfile.tags, gameProfile);
      const eventStartTime = item.times[frameIndex(raw.startFrameIndex, 1)];
      const eventEndTime = item.times[frameIndex(raw.endFrameIndex, item.times.length)];
      normalized.story.eventStartTime = Math.min(eventStartTime, eventEndTime);
      normalized.story.impactTime = item.times[frameIndex(raw.impactFrameIndex, raw.bestFrameIndex || 1)];
      normalized.story.eventEndTime = Math.max(eventStartTime, eventEndTime);
      normalized.traits.payoffVerified = Boolean(raw.payoffVerified);
      result.set(item.file.id, [{ time: item.times[bestIndex], ...normalized }]);
    }
    return result;
  } finally {
    await Promise.all(framePaths.map((framePath) => rm(framePath, { force: true }).catch(() => undefined)));
  }
}

async function verifyApprovedClipReview({ endpoint, apiKey, model, image, item, gameProfile, signal }) {
  const prompt = [
    "You are the skeptical quality-control reviewer for one gameplay clip.",
    "The frames are chronological. Independently verify the previous reviewer; do not assume it was correct.",
    `Clip sample times: ${JSON.stringify(item.times)}.`,
    `Detected game type: ${gameProfile.label} (${gameProfile.genre}).`,
    downtimeGuidance(gameProfile),
    payoffGuidance(gameProfile),
    "Approve only when these frames visibly prove a meaningful action and its completed result or reaction.",
    "Reject walking, searching, empty aiming, ordinary traversal, interface screens, or an attack whose result is not visible.",
    "Use sniper shot only when the frames visibly show a precision long-range shot and its result. Use objective capture only when the objective state visibly changes.",
    `Allowed tags: ${gameProfile.tags.join(", ")}.`,
    "Return JSON only:",
    "{\"approved\":boolean,\"payoffVerified\":boolean,\"score\":0-100,\"bestFrameIndex\":1,\"startFrameIndex\":1,\"impactFrameIndex\":1,\"endFrameIndex\":1,\"tags\":[\"precise visible tag\"],\"state\":\"travel|walking|waiting|setup|aim|combat|impact|reaction|other\",\"reason\":\"specific visible evidence\",\"rating\":{\"trailerUsefulness\":0-100,\"excitement\":0-100,\"visualQuality\":0-100,\"novelty\":0-100,\"boredom\":0-100,\"payoffStage\":\"none|setup|anticipation|impact|reaction\",\"excludeReason\":\"none|boring_travel|walking|waiting|weak_aim|unreadable|other\"},\"story\":{\"role\":\"none|setup|anticipation|payoff|reaction\",\"cutRisk\":\"low|medium|high\"},\"traits\":{\"subject\":\"player|team|opponent|vehicle|objective|item|environment|interface|other\",\"action\":\"specific visible action\",\"intensity\":0-100,\"spectacle\":0-100,\"clarity\":0-100,\"obstruction\":0-100,\"payoffExpected\":boolean}}"
  ].join(" ");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    signal,
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` } }
        ]
      }],
      temperature: 0
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error?.message || "Vision payoff verification failed.");
  const parsed = JSON.parse(String(json.choices?.[0]?.message?.content || "{}").replace(/^```json\s*|\s*```$/g, ""));
  return {
    ...parsed,
    approved: Boolean(parsed.approved) && Boolean(parsed.payoffVerified),
    payoffVerified: Boolean(parsed.approved) && Boolean(parsed.payoffVerified),
    score: Math.max(0, Math.min(100, Number(parsed.score) || 0))
  };
}

function normalizeVisionReview(review, allowedTags = [], gameProfile = GAME_PROFILES.general) {
  const traits = review.traits || {};
  const rating = review.rating || {};
  const story = review.story || {};
  const normalized = {
    approved: Boolean(review.approved),
    score: Math.max(0, Math.min(100, Number(review.score) || 0)),
    state: String(review.state || "other").slice(0, 30),
    tags: normalizeGameplayTags(review.tags, allowedTags),
    reason: String(review.reason || "").slice(0, 160),
    rating: {
      trailerUsefulness: Math.max(0, Math.min(100, Number(rating.trailerUsefulness ?? review.score) || 0)),
      excitement: Math.max(0, Math.min(100, Number(rating.excitement) || 0)),
      visualQuality: Math.max(0, Math.min(100, Number(rating.visualQuality) || 0)),
      novelty: Math.max(0, Math.min(100, Number(rating.novelty) || 0)),
      boredom: Math.max(0, Math.min(100, Number(rating.boredom) || 0)),
      payoffStage: String(rating.payoffStage || "none").slice(0, 30),
      excludeReason: String(rating.excludeReason || "none").slice(0, 40)
    },
    story: {
      role: String(story.role || "none").slice(0, 30),
      keepWindowSeconds: Math.max(0, Math.min(16, Number(story.keepWindowSeconds) || 0)),
      needsContextBefore: Math.max(0, Math.min(10, Number(story.needsContextBefore) || 0)),
      needsContextAfter: Math.max(0, Math.min(10, Number(story.needsContextAfter) || 0)),
      cutRisk: String(story.cutRisk || "medium").slice(0, 20),
      eventStartTime: null,
      impactTime: null,
      eventEndTime: null
    },
    traits: {
      subject: String(traits.subject || "other").slice(0, 40),
      shotScale: String(traits.shotScale || "medium").slice(0, 40),
      action: String(traits.action || "unknown").slice(0, 80),
      intensity: Math.max(0, Math.min(100, Number(traits.intensity) || 0)),
      spectacle: Math.max(0, Math.min(100, Number(traits.spectacle) || 0)),
      clarity: Math.max(0, Math.min(100, Number(traits.clarity) || 0)),
      obstruction: Math.max(0, Math.min(100, Number(traits.obstruction) || 0)),
      payoffExpected: Boolean(traits.payoffExpected),
      payoffVerified: Boolean(review.payoffVerified)
    }
  };
  if (isDecisiveImpactPayoff(normalized, gameProfile)) {
    normalized.approved = true;
    normalized.traits.payoffExpected = true;
    normalized.traits.payoffVerified = true;
    normalized.rating.excludeReason = "none";
    if (!["impact", "reaction"].includes(normalized.rating.payoffStage)) normalized.rating.payoffStage = "impact";
    if (!["payoff", "reaction"].includes(normalized.story.role)) normalized.story.role = "payoff";
    normalized.score = Math.max(normalized.score, 72);
  }
  return normalized;
}

function isDecisiveImpactPayoff(review, gameProfile = GAME_PROFILES.general) {
  const state = String(review.state || "").toLowerCase();
  const stage = String(review.rating?.payoffStage || "").toLowerCase();
  const reason = String(review.reason || "").toLowerCase();
  const action = String(review.traits?.action || "").toLowerCase();
  const tags = (review.tags || []).join(" ").toLowerCase();
  const text = `${reason} ${action} ${tags}`;
  const reject = String(review.rating?.excludeReason || "none").toLowerCase();
  const hardRejectReasons = new Set(["menu", "scoreboard", "map", "loading", "death", "boring_travel", "walking", "waiting", "weak_aim", "unreadable", "duplicate"]);
  if (hardRejectReasons.has(reject)) return false;
  if (["menu", "scoreboard", "map", "loading", "death", "waiting", "travel", "walking"].includes(state)) return false;
  if (String(review.traits?.subject || "").toLowerCase() === "interface") return false;
  if (Number(review.traits?.obstruction || 0) >= 75) return false;
  if (Number(review.traits?.clarity || 0) < 45) return false;
  if (Number(review.rating?.boredom || 0) >= 65) return false;
  const hasImpactStage = ["impact", "reaction"].includes(stage) || ["impact", "reaction", "combat"].includes(state);
  if (!hasImpactStage) return false;
  const hasDecisiveAction = /explosion|destroy|destruction|detonat|blast|shot down|shoot down|vehicle hit|vehicle kill|crash|kill confirmed|enemy down|knockout|objective captured|objective capture/.test(text);
  if (!hasDecisiveAction) return false;
  const strongEnough = Number(review.rating?.trailerUsefulness || 0) >= 65
    || Number(review.rating?.excitement || 0) >= 70
    || Number(review.traits?.intensity || 0) >= 75
    || Number(review.traits?.spectacle || 0) >= 75
    || Number(review.score || 0) >= 70;
  if (!strongEnough) return false;
  if (["military_fps", "battle_royale"].includes(gameProfile?.genre)) return true;
  return Number(review.rating?.trailerUsefulness || 0) >= 75 || Number(review.score || 0) >= 78;
}

function normalizeGameplayTags(values, allowedTags = []) {
  const ignored = new Set(["environment", "exploration", "action", "combat", "payoff", "setup", "spectacle", "gameplay", "highlight", "other", "unknown", "none"]);
  const aliases = new Map([
    ["helicopter", "attack helicopter"],
    ["chopper", "attack helicopter"],
    ["aircraft", "air combat"],
    ["vehicle combat", "armored vehicle"],
    ["rpg", "rocket launcher"],
    ["launcher", "rocket launcher"],
    ["infantry", "infantry firefight"],
    ["close combat", "close-quarters"],
    ["urban fight", "urban combat"],
    ["vehicle kill", "vehicle destruction"],
    ["helicopter kill", "aircraft destruction"]
  ]);
  const result = [];
  const allowed = new Set(allowedTags.map((tag) => String(tag).toLowerCase()));
  for (const value of Array.isArray(values) ? values : []) {
    const clean = String(value || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
    const normalized = aliases.get(clean) || clean;
    if (!normalized || ignored.has(normalized) || result.includes(normalized)) continue;
    if (allowed.size && !allowed.has(normalized)) continue;
    result.push(normalized);
    if (result.length >= 5) break;
  }
  return result;
}

const GAME_PROFILES = {
  military_fps: {
    label: "Military shooter",
    genre: "military_fps",
    tags: ["assault", "engineer", "support", "recon", "infantry firefight", "close-quarters", "long-range kill", "sniper shot", "machine-gun fire", "rocket launcher", "grenade kill", "melee takedown", "multi-kill", "revive", "repair", "objective capture", "objective defense", "tank", "IFV", "APC", "armored vehicle", "attack helicopter", "transport helicopter", "jet", "air combat", "anti-air", "anti-vehicle", "vehicle destruction", "aircraft destruction", "explosion", "urban combat", "rooftop fight", "interior fight", "open-field combat"]
  },
  battle_royale: {
    label: "Battle royale",
    genre: "battle_royale",
    tags: ["drop", "landing", "looting", "loadout", "zone rotation", "close-quarters", "sniper shot", "squad wipe", "third party", "revive", "armor break", "final circle", "clutch win", "vehicle chase"]
  },
  racing: {
    label: "Racing game",
    genre: "racing",
    tags: ["overtake", "drift", "clean pass", "near miss", "crash", "jump", "top speed", "cornering", "photo finish", "race win", "off-road", "street race"]
  },
  sports: {
    label: "Sports game",
    genre: "sports",
    tags: ["goal", "assist", "save", "tackle", "dunk", "three-pointer", "home run", "touchdown", "counterattack", "overtime", "match winner", "skill move"]
  },
  moba: {
    label: "MOBA",
    genre: "moba",
    tags: ["solo kill", "team fight", "gank", "objective steal", "tower dive", "multi-kill", "escape", "ultimate combo", "boss objective", "base defense", "comeback"]
  },
  rpg: {
    label: "RPG",
    genre: "rpg",
    tags: ["boss fight", "critical hit", "spell combo", "finishing move", "rare loot", "stealth takedown", "party combo", "dodge", "parry", "quest climax", "character moment"]
  },
  fighting: {
    label: "Fighting game",
    genre: "fighting",
    tags: ["combo", "counter hit", "parry", "reversal", "wall combo", "perfect round", "knockout", "comeback", "finishing move", "grab"]
  },
  survival: {
    label: "Survival game",
    genre: "survival",
    tags: ["ambush", "base defense", "boss encounter", "resource clutch", "escape", "stealth", "horde fight", "rescue", "crafting payoff", "near death"]
  },
  general: {
    label: "Game highlight",
    genre: "general",
    tags: ["close call", "multi-kill", "boss fight", "objective play", "speedrun", "puzzle solve", "team play", "comeback", "finishing move", "rare event", "clutch moment"]
  }
};

function payoffGuidance(profile = GAME_PROFILES.general) {
  const guidance = {
    military_fps: "Verify a visible hit, explosion, vehicle or structure destruction, takedown, capture, defense, revive, escape, or reaction after the attack. A clear cinematic explosion or destruction is a valid payoff even when no enemy kill marker is visible.",
    battle_royale: "Verify the knock, elimination, squad wipe, revive, escape, final-circle result, or win after the setup.",
    racing: "Verify the completed overtake, drift exit, landing, near miss, crash result, finish, or race win.",
    sports: "Verify the completed goal, save, assist, tackle, score, match winner, or immediate reaction.",
    moba: "Verify the kill, escape, objective secure or steal, tower result, team-fight result, or base defense.",
    rpg: "Verify the hit result, boss phase change, finishing move, parry result, loot reveal, escape, or story climax.",
    fighting: "Verify the combo result, counter, reversal, knockout, round win, comeback, or finishing move.",
    survival: "Verify the escape, rescue, defense result, kill, resource payoff, boss result, or survival outcome.",
    general: "Verify that the main action reaches a visible result, consequence, reaction, or completion before the shot ends."
  };
  return guidance[profile?.genre] || guidance.general;
}

function downtimeGuidance(profile = GAME_PROFILES.general) {
  if (["military_fps", "battle_royale"].includes(profile?.genre)) {
    return "Walking, waiting, empty aiming, and uneventful traversal are downtime unless they immediately establish a verified payoff.";
  }
  if (profile?.genre === "racing") {
    return "Driving is core action, not downtime. Reject only uneventful stretches without a maneuver, challenge, position change, risk, or result.";
  }
  if (["rpg", "survival"].includes(profile?.genre)) {
    return "Movement and exploration may be meaningful setup. Reject them only when they do not lead to discovery, danger, interaction, or a visible result.";
  }
  return "Treat movement as downtime only when it does not contribute to the detected game's objective, tension, skill, story, or result.";
}

function inferGameProfile(project) {
  const source = `${project.name || ""} ${project.sourcePath || ""} ${(project.files || []).slice(0, 10).map((file) => file.name).join(" ")}`.toLowerCase();
  if (/battlefield|call of duty|arma|squad|insurgency|delta force|hell let loose|military/.test(source)) return structuredClone(GAME_PROFILES.military_fps);
  if (/fortnite|apex|pubg|warzone|battle royale/.test(source)) return structuredClone(GAME_PROFILES.battle_royale);
  if (/forza|gran turismo|need for speed|assetto|f1 |racing|rally/.test(source)) return structuredClone(GAME_PROFILES.racing);
  if (/fifa|fc 2|nba|madden|nhl|mlb|football|soccer|basketball/.test(source)) return structuredClone(GAME_PROFILES.sports);
  if (/league of legends|dota|smite|moba/.test(source)) return structuredClone(GAME_PROFILES.moba);
  if (/street fighter|tekken|mortal kombat|fighting/.test(source)) return structuredClone(GAME_PROFILES.fighting);
  if (/elden ring|witcher|baldur|final fantasy|rpg/.test(source)) return structuredClone(GAME_PROFILES.rpg);
  if (/minecraft|rust|dayz|survival/.test(source)) return structuredClone(GAME_PROFILES.survival);
  return structuredClone(GAME_PROFILES.general);
}

function refineGameProfile(profile, files) {
  if (profile?.genre && profile.genre !== "general") return profile;
  const text = files.flatMap((file) => [
    file.metadata?.semanticTraits?.subject,
    file.metadata?.semanticTraits?.action,
    ...(file.metadata?.semanticTags || [])
  ]).filter(Boolean).join(" ").toLowerCase();
  if (/tank|helicopter|jet|rocket launcher|infantry|aircraft|armored/.test(text)) return structuredClone(GAME_PROFILES.military_fps);
  if (/overtake|drift|race win|cornering/.test(text)) return structuredClone(GAME_PROFILES.racing);
  if (/goal|assist|touchdown|dunk|match winner/.test(text)) return structuredClone(GAME_PROFILES.sports);
  if (/team fight|gank|tower dive|objective steal/.test(text)) return structuredClone(GAME_PROFILES.moba);
  if (/combo|counter hit|perfect round|knockout/.test(text)) return structuredClone(GAME_PROFILES.fighting);
  if (/boss fight|spell combo|rare loot|quest climax/.test(text)) return structuredClone(GAME_PROFILES.rpg);
  return profile || structuredClone(GAME_PROFILES.general);
}

function summarizeFrameReviews(frames, gameProfile = GAME_PROFILES.general) {
  const ordered = [...frames].sort((a, b) => a.time - b.time);
  const aiRated = ordered.map((frame) => ({
    ...frame,
    aiRating: Math.round(
      (frame.rating?.trailerUsefulness ?? frame.score ?? 0) * 0.42 +
      (frame.rating?.excitement ?? frame.traits?.intensity ?? 0) * 0.22 +
      (frame.rating?.visualQuality ?? frame.traits?.clarity ?? 0) * 0.18 +
      (frame.rating?.novelty ?? 50) * 0.1 -
      (frame.rating?.boredom ?? 0) * 0.25 -
      (frame.traits?.obstruction ?? 0) * 0.15
    )
  }));
  const hardRejectStates = new Set(["menu", "scoreboard", "map", "loading", "death", "waiting"]);
  const hardRejectReasons = new Set(["menu", "scoreboard", "map", "loading", "death", "waiting", "weak_aim", "unreadable", "duplicate"]);
  if (["military_fps", "battle_royale"].includes(gameProfile?.genre)) {
    hardRejectStates.add("walking");
    hardRejectStates.add("travel");
    hardRejectReasons.add("walking");
    hardRejectReasons.add("boring_travel");
  }
  const top = [...aiRated]
    .filter((frame) => frame.approved && frame.rating?.excludeReason === "none" && !hardRejectStates.has(frame.state))
    .sort((a, b) => b.aiRating - a.aiRating)[0] || [...aiRated].sort((a, b) => b.aiRating - a.aiRating)[0] || null;
  const events = [];
  let current = null;
  for (const frame of aiRated.sort((a, b) => a.time - b.time)) {
    const excluded = hardRejectReasons.has(frame.rating?.excludeReason) || hardRejectStates.has(frame.state);
    const weakAim = frame.state === "aim" && !frame.traits?.payoffExpected && !["anticipation", "impact"].includes(frame.rating?.payoffStage);
    const missingExpectedPayoff = frame.traits?.payoffExpected && !frame.traits?.payoffVerified;
    const verifiedPayoff = frame.traits?.payoffVerified === true;
    const eventCandidate = frame.approved && verifiedPayoff && frame.aiRating >= 60 && !excluded && !weakAim && !missingExpectedPayoff;
    if (!eventCandidate) {
      if (current) events.push(current);
      current = null;
      continue;
    }
    const before = Math.max(defaultContextBefore(frame), frame.story?.needsContextBefore || 0);
    const resultAfter = frame.traits?.payoffExpected || frame.story?.cutRisk === "high" || ["impact", "reaction"].includes(frame.rating?.payoffStage)
      ? 5.5
      : 0;
    const after = Math.max(defaultContextAfter(frame), frame.story?.needsContextAfter || 0, resultAfter);
    const impactTime = Number.isFinite(frame.story?.impactTime) ? frame.story.impactTime : frame.time;
    const declaredStart = Number.isFinite(frame.story?.eventStartTime) ? frame.story.eventStartTime : frame.time;
    const declaredEnd = Number.isFinite(frame.story?.eventEndTime) ? frame.story.eventEndTime : frame.time;
    const start = Math.max(0, Math.min(declaredStart, impactTime - before, frame.time - before * 0.5));
    const end = Math.max(declaredEnd, impactTime + after, frame.time + after);
    if (!current) {
      current = {
        start,
        end,
        score: frame.aiRating,
        state: frame.state,
        action: frame.traits.action,
        payoffStage: frame.rating?.payoffStage || "none",
        storyRole: frame.story?.role || "none",
        cutRisk: frame.story?.cutRisk || "medium",
        impactTime,
        payoffVerified: Boolean(frame.traits?.payoffVerified)
      };
    } else {
      current.start = Math.min(current.start, start);
      current.end = Math.max(current.end, end);
      current.score = Math.max(current.score, frame.aiRating);
      if (frame.state === "impact" || frame.state === "reaction") current.state = frame.state;
      if (["impact", "reaction"].includes(frame.rating?.payoffStage)) current.payoffStage = frame.rating.payoffStage;
      if (["payoff", "reaction"].includes(frame.story?.role)) current.storyRole = frame.story.role;
      if (frame.story?.cutRisk === "high") current.cutRisk = "high";
      current.impactTime = Number.isFinite(current.impactTime) ? current.impactTime : impactTime;
      current.payoffVerified = current.payoffVerified || Boolean(frame.traits?.payoffVerified);
    }
  }
  if (current) events.push(current);
  const usableEvents = events
    .filter((event) => event.end - event.start >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((event) => ({
      ...event,
      start: Math.round(event.start * 10) / 10,
      end: Math.round(event.end * 10) / 10,
      impactTime: Number.isFinite(event.impactTime) ? Math.round(event.impactTime * 10) / 10 : undefined
    }));
  const strongestEvents = usableEvents.slice(0, 3);
  const weakCandidateCount = aiRated.filter((frame) =>
    frame.approved &&
    frame.aiRating >= 55 &&
    frame.traits?.payoffVerified !== true &&
    !hardRejectReasons.has(frame.rating?.excludeReason) &&
    !hardRejectStates.has(frame.state)
  ).length;
  const weakCandidates = aiRated
    .filter((frame) =>
      frame.approved &&
      frame.aiRating >= 55 &&
      frame.traits?.payoffVerified !== true &&
      !hardRejectReasons.has(frame.rating?.excludeReason) &&
      !hardRejectStates.has(frame.state)
    )
    .sort((a, b) => b.aiRating - a.aiRating)
    .slice(0, 5)
    .map((frame) => {
      const before = Math.max(defaultContextBefore(frame), frame.story?.needsContextBefore || 0);
      const after = Math.max(defaultContextAfter(frame), frame.story?.needsContextAfter || 0);
      const impactTime = Number.isFinite(frame.story?.impactTime) ? frame.story.impactTime : frame.time;
      const declaredStart = Number.isFinite(frame.story?.eventStartTime) ? frame.story.eventStartTime : frame.time;
      const declaredEnd = Number.isFinite(frame.story?.eventEndTime) ? frame.story.eventEndTime : frame.time;
      const start = Math.max(0, Math.min(declaredStart, impactTime - before, frame.time - before * 0.5));
      const end = Math.max(declaredEnd, impactTime + after, frame.time + after);
      return {
        start: Math.round(start * 10) / 10,
        end: Math.round(end * 10) / 10,
        score: frame.aiRating,
        state: frame.state,
        action: frame.traits?.action || "candidate",
        payoffStage: frame.rating?.payoffStage || "none",
        storyRole: frame.story?.role || "none",
        cutRisk: frame.story?.cutRisk || "medium",
        impactTime: Number.isFinite(impactTime) ? Math.round(impactTime * 10) / 10 : undefined,
        payoffVerified: false
      };
    })
    .filter((event, index, list) =>
      event.end - event.start >= 4 &&
      list.findIndex((candidate) =>
        Math.abs(Number(candidate.start || 0) - Number(event.start || 0)) < 0.2 &&
        Math.abs(Number(candidate.end || 0) - Number(event.end || 0)) < 0.2
      ) === index
    );
  const semanticScore = strongestEvents.length
    ? Math.round(strongestEvents.reduce((sum, event, index) => sum + event.score * [0.55, 0.3, 0.15][index], 0)
      / strongestEvents.reduce((sum, _, index) => sum + [0.55, 0.3, 0.15][index], 0))
    : Math.min(42, Math.max(0, top?.aiRating || 0));
  const verifiedEventCount = usableEvents.filter((event) => event.payoffVerified === true).length;
  const quality = verifiedEventCount
    ? "verified"
    : weakCandidateCount
      ? "weak"
      : "missed";
  return {
    framesReviewed: ordered.length,
    score: semanticScore,
    quality,
    verifiedEventCount,
    weakCandidateCount,
    topFrame: top ? top.time : null,
    rejectReason: verifiedEventCount ? null : top?.reason || "No verified payoff found.",
    traits: top?.traits || null,
    tags: top?.tags || [],
    rating: top?.rating || null,
    weakCandidates,
    events: usableEvents
  };
}

function defaultContextBefore(frame) {
  if (frame.story?.role === "payoff" || frame.rating?.payoffStage === "impact") return 7;
  if (frame.story?.role === "anticipation" || frame.traits?.payoffExpected) return 5;
  if (frame.story?.role === "reaction") return 3;
  return 4;
}

function defaultContextAfter(frame) {
  if (frame.story?.role === "payoff" || frame.rating?.payoffStage === "impact") return 6;
  if (frame.story?.role === "anticipation" || frame.traits?.payoffExpected) return 8;
  if (frame.story?.role === "reaction") return 5;
  return 4;
}

const port = Number(process.env.PORT || 4312);
app.listen(port, "127.0.0.1", () => console.log(`HighlightAI local service: http://127.0.0.1:${port}`));
