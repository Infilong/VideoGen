import type { AiModelStatus, Analysis, Diagnostics, Draft, FastIndexEstimate, FastIndexJob, IngestJob, IngestProgress, OperationIssue, PreprocessEstimate, PreprocessJob, Project, PublicAudio, RenderJob, VideoIdea } from "../types";

const API = typeof window !== "undefined" && ["5173", "5174", "5175"].includes(window.location.port)
  ? "http://127.0.0.1:4312/api"
  : "/api";
const LOCAL_ORIGIN = typeof window !== "undefined" && ["5173", "5174", "5175"].includes(window.location.port)
  ? "http://127.0.0.1:4312"
  : "";

export function localMediaUrl(relativePath: string) {
  if (!relativePath || /^https?:\/\//i.test(relativePath)) return relativePath;
  return `${LOCAL_ORIGIN}${relativePath.startsWith("/") ? relativePath : `/${relativePath}`}`;
}

const fallbackIssue: OperationIssue = {
  title: "Processing stopped",
  message: "HighlightAI could not finish that step.",
  action: "Please try again. If it keeps happening, reduce the selection size or restart the app.",
  recoverable: true
};

function hasBackendDetails(value = "") {
  return /(?:ffmpeg|ffprobe|libx264|libx265|encoder|decoder|stderr|stdout|exited\s+-?\d+|error code|invalid argument|conversion failed|malloc|0x[0-9a-f]+|\[[a-z0-9#:@/.-]+]|(?:[A-Z]:\\|\/(?:Users|tmp|var|home|mnt|usr|app)\/)|node_modules|stack trace|traceback|errno|syscall|EADDRINUSE|ECONN|ENOTFOUND|EAI_AGAIN|https?:\/\/|api[_ -]?key|authorization|bearer|token|secret|password|sk-[a-z0-9_-]+|\b(?:TypeError|ReferenceError|SyntaxError)\b)/i.test(value);
}

function isUnsafeUserMessage(value: unknown) {
  const text = String(value || "");
  return !text.trim() || text.length > 240 || /[\r\n]/.test(text) || hasBackendDetails(text);
}

function sanitizeIssue(issue: Partial<OperationIssue> = {}, fallback: Partial<OperationIssue> = {}): OperationIssue {
  const title = isUnsafeUserMessage(issue.title)
    ? fallback.title || fallbackIssue.title
    : String(issue.title || fallback.title || fallbackIssue.title);
  const message = isUnsafeUserMessage(issue.message)
    ? fallback.message || fallbackIssue.message
    : String(issue.message || fallback.message || fallbackIssue.message);
  const action = isUnsafeUserMessage(issue.action)
    ? fallback.action || fallbackIssue.action
    : String(issue.action || fallback.action || fallbackIssue.action);
  return {
    title,
    message,
    action,
    recoverable: issue.recoverable !== false
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: any = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }
  if (!response.ok) {
    const payload = typeof body.error === "object" ? body.error : { message: body.error };
    const issue = sanitizeIssue(payload, {
      title: "Could not complete that step",
      message: "HighlightAI could not finish that step.",
      action: "Please try again. If it keeps happening, restart the app and run it again."
    });
    const error = new Error(issue.message) as Error & { issue?: OperationIssue };
    error.issue = issue;
    throw error;
  }
  return body as T;
}

export function issueFromError(error: unknown): OperationIssue {
  if (error instanceof Error && "issue" in error && (error as Error & { issue?: OperationIssue }).issue) {
    return sanitizeIssue((error as Error & { issue: OperationIssue }).issue);
  }
  return sanitizeIssue({
    title: "Processing stopped",
    message: error instanceof Error ? error.message : "An unexpected local error occurred.",
    action: "Please try again. Files already copied into HighlightAI are preserved.",
    recoverable: true
  });
}

export async function getDiagnostics(): Promise<Diagnostics> {
  return responseJson(await fetch(`${API}/diagnostics`));
}

export async function deleteProject(projectId: string): Promise<{ id: string; removed: boolean; sourceFilesPreserved: boolean }> {
  return responseJson(await fetch(`${API}/projects/${projectId}`, { method: "DELETE" }));
}

export async function checkAiModel(config: { endpoint: string; apiKey: string; model: string }): Promise<AiModelStatus> {
  return responseJson(await fetch(`${API}/ai-model/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  }));
}

export async function createIngestJob(files: File[]): Promise<IngestJob> {
  return responseJson(await fetch(`${API}/ingest-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Highlight ${new Date().toLocaleDateString()}`,
      totalFiles: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      files: files.map((file) => ({
        clientId: `${file.name}-${file.size}-${file.lastModified}`,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified
      }))
    })
  }));
}

export function uploadIngestFile(jobId: string, file: File, clientId: string, onProgress: (loaded: number) => void) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<IngestJob>((resolve, reject) => {
    xhr.open("PUT", `${API}/ingest-jobs/${jobId}/files`);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onerror = () => reject(new Error(`The local service lost connection while copying ${file.name}.`));
    xhr.onabort = () => reject(new DOMException("Copy cancelled", "AbortError"));
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) throw new Error(body.error?.message || body.error || `Could not copy ${file.name}.`);
        resolve(body as IngestJob);
      } catch (error) {
        reject(error);
      }
    };
    const form = new FormData();
    form.append("clientId", clientId);
    form.append("file", file);
    xhr.send(form);
  });
  return { promise, cancel: () => xhr.abort() };
}

export async function getIngestJob(jobId: string): Promise<IngestJob> {
  return responseJson(await fetch(`${API}/ingest-jobs/${jobId}`));
}

export async function cancelIngestJob(jobId: string): Promise<IngestJob> {
  return responseJson(await fetch(`${API}/ingest-jobs/${jobId}/cancel`, { method: "POST" }));
}

export async function pauseIngestJob(jobId: string): Promise<IngestJob> {
  return responseJson(await fetch(`${API}/ingest-jobs/${jobId}/pause`, { method: "POST" }));
}

export async function resumeIngestJob(jobId: string): Promise<IngestJob> {
  return responseJson(await fetch(`${API}/ingest-jobs/${jobId}/resume`, { method: "POST" }));
}

export async function startIngestProcessing(jobId: string): Promise<IngestJob> {
  return responseJson(await fetch(`${API}/ingest-jobs/${jobId}/process`, { method: "POST" }));
}

async function waitForIngestJob(job: IngestJob, onProgress: (progress: IngestProgress) => void): Promise<{ project: Project; analysis: Analysis; job: IngestJob }> {
  onProgress({ ...job, activeFileBytes: 0, activeFileSize: 0 });
  while (!["completed", "completed_with_warnings", "failed", "cancelled"].includes(job.status)) {
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    job = await getIngestJob(job.id);
    onProgress({ ...job, activeFileBytes: 0, activeFileSize: 0 });
  }
  if (!job.result) throw new Error(job.status === "cancelled" ? "Processing cancelled. Completed analysis was preserved." : "No usable videos could be processed.");
  return { ...job.result, job };
}

export async function getProject(projectId: string): Promise<Project> {
  return responseJson(await fetch(`${API}/projects/${projectId}`));
}

export async function reconcileProject(projectId: string): Promise<Project> {
  return responseJson(await fetch(`${API}/projects/${projectId}/reconcile`, { method: "POST" }));
}

async function waitForIngestJobWithProject(
  job: IngestJob,
  onProgress: (progress: IngestProgress) => void,
  onProjectUpdate?: (project: Project) => void
): Promise<{ project: Project; analysis: Analysis; job: IngestJob }> {
  onProgress({ ...job, activeFileBytes: 0, activeFileSize: 0 });
  if (job.projectId && onProjectUpdate) {
    void getProject(job.projectId).then(onProjectUpdate).catch(() => undefined);
  }
  while (!["completed", "completed_with_warnings", "failed", "cancelled"].includes(job.status)) {
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    job = await getIngestJob(job.id);
    onProgress({ ...job, activeFileBytes: 0, activeFileSize: 0 });
    if (job.projectId && onProjectUpdate) {
      void getProject(job.projectId).then(onProjectUpdate).catch(() => undefined);
    }
  }
  if (!job.result) throw new Error(job.status === "cancelled" ? "Processing cancelled. Completed analysis was preserved." : "No usable videos could be processed.");
  if (onProjectUpdate) onProjectUpdate(job.result.project);
  return { ...job.result, job };
}

export async function ingestLocalFolder(
  folder: string,
  onProgress: (progress: IngestProgress) => void,
  registerCancel: (cancel: () => void) => void,
  onProjectUpdate?: (project: Project) => void
): Promise<{ project: Project; analysis: Analysis; job: IngestJob }> {
  const job = await responseJson<IngestJob>(await fetch(`${API}/ingest-local-folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder })
  }));
  registerCancel(() => { void cancelIngestJob(job.id); });
  return waitForIngestJobWithProject(job, onProgress, onProjectUpdate);
}

export async function ingestFiles(
  files: File[],
  onProgress: (progress: IngestProgress) => void,
  registerCancel: (cancel: () => void) => void
): Promise<{ project: Project; analysis: Analysis; job: IngestJob }> {
  let job = await createIngestJob(files);
  let cancelled = false;
  let activeCancel: () => void = () => undefined;
  registerCancel(() => {
    cancelled = true;
    activeCancel();
    void cancelIngestJob(job.id);
  });

  for (const file of files) {
    if (cancelled) throw new DOMException("Copy cancelled", "AbortError");
    job = await getIngestJob(job.id);
    while (job.status === "paused") {
      onProgress({ ...job, activeFileBytes: 0, activeFileSize: file.size });
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      job = await getIngestJob(job.id);
    }
    let activeFileBytes = 0;
    const clientId = `${file.name}-${file.size}-${file.lastModified}`;
    if (job.previewFiles?.some((item) => item.clientId === clientId && item.state === "reused")) {
      onProgress({ ...job, currentFile: file.name, activeFileBytes: 0, activeFileSize: file.size });
      continue;
    }
    const upload = uploadIngestFile(job.id, file, clientId, (loaded) => {
      activeFileBytes = loaded;
      onProgress({ ...job, currentFile: file.name, activeFileBytes, activeFileSize: file.size });
    });
    activeCancel = upload.cancel;
    try {
      job = await upload.promise;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // Continue so one unreadable file cannot discard a large successful batch.
    }
    onProgress({ ...job, activeFileBytes: 0, activeFileSize: 0 });
  }

  job = await startIngestProcessing(job.id);
  return waitForIngestJob(job, onProgress);
}

export async function listProjects(): Promise<Project[]> {
  return responseJson(await fetch(`${API}/projects`));
}

export async function findPublicAudio(query: string): Promise<PublicAudio[]> {
  return responseJson(await fetch(`${API}/public-audio?q=${encodeURIComponent(query)}`));
}

export async function importPublicAudio(projectId: string, audio: PublicAudio): Promise<Project> {
  return responseJson(await fetch(`${API}/projects/${projectId}/public-audio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: audio.id, creator: audio.creator, licenseUrl: audio.licenseUrl })
  }));
}

export async function addAssets(projectId: string, files: File[]): Promise<Project> {
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  return responseJson(await fetch(`${API}/projects/${projectId}/assets`, { method: "POST", body: form }));
}

export async function generateDraft(
  projectId: string,
  idea: VideoIdea,
  intensity = 78,
  excludedIntervals: Array<{ fileId: string; start: number; duration: number }> = []
): Promise<Draft> {
  return responseJson(await fetch(`${API}/projects/${projectId}/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idea: { ...idea, intensity, excludedIntervals } })
  }));
}

export async function updateDraft(projectId: string, draftId: string, changes: Partial<Draft>): Promise<Draft> {
  return responseJson(await fetch(`${API}/projects/${projectId}/drafts/${draftId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes)
  }));
}

export async function getRenderJob(jobId: string): Promise<RenderJob> {
  return responseJson(await fetch(`${API}/render-jobs/${jobId}`));
}

export async function cancelRenderJob(jobId: string): Promise<RenderJob> {
  return responseJson(await fetch(`${API}/render-jobs/${jobId}/cancel`, { method: "POST" }));
}

export async function pauseRenderJob(jobId: string): Promise<RenderJob> {
  return responseJson(await fetch(`${API}/render-jobs/${jobId}/pause`, { method: "POST" }));
}

export async function resumeRenderJob(jobId: string): Promise<RenderJob> {
  return responseJson(await fetch(`${API}/render-jobs/${jobId}/resume`, { method: "POST" }));
}

export async function confirmHighlightMoment(
  projectId: string,
  fileId: string,
  moment: { start: number; end: number; score?: number; state?: string; action?: string; storyRole?: string; source?: string; replaceStart?: number; replaceEnd?: number }
): Promise<Project> {
  return responseJson(await fetch(`${API}/projects/${projectId}/files/${fileId}/highlight-confirmations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(moment)
  }));
}

export async function rejectHighlightMoment(
  projectId: string,
  fileId: string,
  moment: { start: number; end: number; source?: string; reason: "not-highlight" }
): Promise<Project> {
  return responseJson(await fetch(`${API}/projects/${projectId}/files/${fileId}/highlight-rejections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(moment)
  }));
}

export async function markHighlightReviewed(projectId: string, fileId: string, reviewed = true): Promise<Project> {
  return responseJson(await fetch(`${API}/projects/${projectId}/files/${fileId}/highlight-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewed })
  }));
}

export async function removeHighlightConfirmation(
  projectId: string,
  fileId: string,
  moment: { start: number; end: number }
): Promise<Project> {
  return responseJson(await fetch(`${API}/projects/${projectId}/files/${fileId}/highlight-confirmations`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(moment)
  }));
}

export async function renderDraft(
  projectId: string,
  draftId: string,
  assetId?: string,
  reviewProvider?: { endpoint: string; apiKey: string; model: string },
  onProgress?: (job: RenderJob) => void,
  musicRepeats = 1
): Promise<
  | { url: string; localPath?: string; draft: Draft; assetManifest?: Record<string, unknown> }
  | { needsReview: true; job: RenderJob; draft?: Draft }
> {
  let job = await responseJson<RenderJob>(await fetch(`${API}/projects/${projectId}/drafts/${draftId}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetId, reviewProvider, musicRepeats })
  }));
  onProgress?.(job);
  while (!["completed", "needs_review", "failed", "cancelled"].includes(job.status)) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    job = await getRenderJob(job.id);
    onProgress?.(job);
  }
  if (job.status === "needs_review") {
    return { needsReview: true, job, draft: job.result?.draft };
  }
  if (job.status === "cancelled") {
    const error = new Error("Rendering was cancelled.") as Error & { issue?: OperationIssue };
    error.issue = {
      title: "Render cancelled",
      message: "Video generation stopped at your request.",
      action: "Your selected clips and draft are preserved. Generate again when ready.",
      recoverable: true
    };
    throw error;
  }
  if (job.status === "failed" || !job.result) {
    const error = new Error(job.error?.message || "Rendering failed.") as Error & { issue?: OperationIssue };
    error.issue = job.error;
    throw error;
  }
  return job.result;
}

export async function reviewDraft(projectId: string, draftId: string, config: { endpoint: string; apiKey: string; model: string }): Promise<{ draftId: string; review: Draft["review"] }> {
  return responseJson(await fetch(`${API}/projects/${projectId}/drafts/${draftId}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  }));
}

export async function requestAdvancedAdvice(projectId: string, config: { endpoint: string; apiKey: string; model: string }, prompt: string): Promise<string> {
  const result = await responseJson<{ advice: string }>(await fetch(`${API}/projects/${projectId}/ai-advice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, prompt })
  }));
  return result.advice;
}

export async function requestVisionReview(projectId: string, config: { endpoint: string; apiKey: string; model: string }, referenceStyle: string, options: { maxCandidates?: number } = {}): Promise<{ project: Project; reviewed: number; approved: number }> {
  return responseJson(await fetch(`${API}/projects/${projectId}/vision-review/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, referenceStyle, maxCandidates: options.maxCandidates ?? 24 })
  }));
}

export async function estimatePreprocess(
  projectId: string,
  options: { sampleInterval?: number; concurrency?: number; maxFiles?: number; maxFrames?: number; maxRuntimeSeconds?: number; fileIds?: string[]; endpoint?: string; model?: string; modelSecondsPerRequest?: number; refineReviewed?: boolean } = {}
): Promise<PreprocessEstimate> {
  return responseJson(await fetch(`${API}/projects/${projectId}/preprocess/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options)
  }));
}

export async function estimateFastIndex(
  projectId: string,
  options: { concurrency?: number; maxFiles?: number; maxWindowsPerFile?: number; windowDuration?: number; fileIds?: string[] } = {}
): Promise<FastIndexEstimate> {
  return responseJson(await fetch(`${API}/projects/${projectId}/fast-index/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options)
  }));
}

export async function getFastIndexJob(jobId: string): Promise<FastIndexJob> {
  return responseJson(await fetch(`${API}/fast-index-jobs/${jobId}`));
}

export async function cancelFastIndexJob(jobId: string): Promise<FastIndexJob> {
  return responseJson(await fetch(`${API}/fast-index-jobs/${jobId}/cancel`, { method: "POST" }));
}

export async function pauseFastIndexJob(jobId: string): Promise<FastIndexJob> {
  return responseJson(await fetch(`${API}/fast-index-jobs/${jobId}/pause`, { method: "POST" }));
}

export async function resumeFastIndexJob(jobId: string): Promise<FastIndexJob> {
  return responseJson(await fetch(`${API}/fast-index-jobs/${jobId}/resume`, { method: "POST" }));
}

export async function runFastIndex(
  projectId: string,
  options: { concurrency?: number; maxFiles?: number; maxWindowsPerFile?: number; windowDuration?: number; fileIds?: string[] },
  onProgress: (job: FastIndexJob) => void,
  registerCancel: (cancel: () => void) => void
): Promise<FastIndexJob> {
  let job = await responseJson<FastIndexJob>(await fetch(`${API}/projects/${projectId}/fast-index/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options)
  }));
  registerCancel(() => { void cancelFastIndexJob(job.id); });
  onProgress(job);
  while (!["completed", "completed_with_warnings", "failed", "cancelled"].includes(job.status)) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    job = await getFastIndexJob(job.id);
    onProgress(job);
  }
  if (job.status === "cancelled") throw new Error("Fast index was cancelled.");
  if (job.status === "failed") throw new Error("Fast index failed before it produced usable candidates.");
  return job;
}

export async function getPreprocessJob(jobId: string): Promise<PreprocessJob> {
  return responseJson(await fetch(`${API}/preprocess-jobs/${jobId}`));
}

export async function cancelPreprocessJob(jobId: string): Promise<PreprocessJob> {
  return responseJson(await fetch(`${API}/preprocess-jobs/${jobId}/cancel`, { method: "POST" }));
}

export async function pausePreprocessJob(jobId: string): Promise<PreprocessJob> {
  return responseJson(await fetch(`${API}/preprocess-jobs/${jobId}/pause`, { method: "POST" }));
}

export async function resumePreprocessJob(jobId: string): Promise<PreprocessJob> {
  return responseJson(await fetch(`${API}/preprocess-jobs/${jobId}/resume`, { method: "POST" }));
}

export async function runPreprocess(
  projectId: string,
  config: { endpoint: string; apiKey: string; model: string },
  options: { referenceStyle: string; sampleInterval?: number; concurrency?: number; maxFiles?: number; maxFrames?: number; maxRuntimeSeconds?: number; fileIds?: string[]; refineReviewed?: boolean },
  onProgress: (job: PreprocessJob) => void,
  registerCancel: (cancel: () => void) => void
): Promise<PreprocessJob> {
  let job = await responseJson<PreprocessJob>(await fetch(`${API}/projects/${projectId}/preprocess/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, ...options })
  }));
  registerCancel(() => { void cancelPreprocessJob(job.id); });
  onProgress(job);
  while (!["completed", "completed_with_warnings", "failed", "cancelled"].includes(job.status)) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    job = await getPreprocessJob(job.id);
    onProgress(job);
  }
  if (job.status === "cancelled") throw new Error("AI preprocessing was cancelled.");
  if (job.status === "failed") throw new Error("AI preprocessing failed before it produced usable results.");
  if (!job.result?.project) {
    const project = await getProject(projectId);
    job = {
      ...job,
      result: {
        project,
        projectId: project.id,
        eventsFound: job.eventsFound || 0,
        approvedFrames: job.approvedFrames || 0,
        rejectedFrames: job.rejectedFrames || 0,
        ...(job.result || {})
      }
    };
  }
  return job;
}
