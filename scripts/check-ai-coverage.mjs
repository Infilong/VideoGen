const API = process.env.HIGHLIGHTAI_API || "http://127.0.0.1:4312/api";
const PROJECT_ID = process.env.PROJECT_ID || "";
const VISION_ENDPOINT = process.env.VISION_ENDPOINT || "http://127.0.0.1:11434/v1/chat/completions";
const VISION_MODEL = process.env.VISION_MODEL || "qwen2.5vl:7b";
const VISION_API_KEY = process.env.VISION_API_KEY || "";
const MAX_CHECK_SECONDS = Math.max(30, Number(process.env.MAX_CHECK_SECONDS || 30 * 60));
const FRAMES_PER_VIDEO = Math.max(3, Math.min(18, Number(process.env.FRAMES_PER_VIDEO || 10)));
const SAMPLE_INTERVAL = Math.max(1, Math.min(10, Number(process.env.SAMPLE_INTERVAL || 6)));
const TARGET_RATE = Math.max(1, Math.min(100, Number(process.env.TARGET_RATE || 95)));

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const issue = json.error || {};
    throw new Error(`${issue.title || response.statusText}: ${issue.message || JSON.stringify(json)}`);
  }
  return json;
}

async function chooseProject() {
  if (PROJECT_ID) return request(`/projects/${PROJECT_ID}`);
  const projects = await request("/projects");
  if (!projects.length) throw new Error("No HighlightAI projects found.");
  const scored = await Promise.all(projects.map(async (project) => {
    const full = await request(`/projects/${project.id}`);
    const ready = (full.files || []).filter((file) => Number(file.metadata?.duration || 0) > 0).length;
    return { full, ready, updatedAt: Date.parse(full.updatedAt || project.updatedAt || 0) || 0 };
  }));
  scored.sort((a, b) => b.ready - a.ready || b.updatedAt - a.updatedAt);
  return scored[0].full;
}

async function waitForPreprocess(job) {
  let current = job;
  while (!["completed", "completed_with_warnings", "failed", "cancelled"].includes(current.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    current = await request(`/preprocess-jobs/${current.id}`);
    process.stdout.write(`\r${current.phase} ${current.processedFiles}/${current.totalFiles} files, ${current.processedRequests || 0}/${current.totalRequests || 0} requests, eta ${current.etaSeconds || 0}s`);
  }
  process.stdout.write("\n");
  return current;
}

async function runPass(projectId, refineReviewed) {
  const body = {
    endpoint: VISION_ENDPOINT,
    apiKey: VISION_API_KEY,
    model: VISION_MODEL,
    referenceStyle: "Professional gameplay trailer. Verify complete game-specific highlight payoffs, keep visible result or reaction, reject boring travel and interface screens.",
    sampleInterval: SAMPLE_INTERVAL,
    concurrency: 1,
    maxRuntimeSeconds: MAX_CHECK_SECONDS,
    refineReviewed,
    maxFiles: 0,
    maxFrames: 0
  };
  const estimate = await request(`/projects/${projectId}/preprocess/estimate`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (!estimate.files || !estimate.frames) {
    console.log(refineReviewed ? "Pass 2: no reviewed candidates need refinement." : "Pass 1: no videos need first-pass review.");
    return null;
  }
  body.maxFiles = estimate.files;
  body.maxFrames = estimate.files * FRAMES_PER_VIDEO;
  console.log(`${refineReviewed ? "Pass 2" : "Pass 1"}: ${estimate.files} videos, ${body.maxFrames} frames, max ${MAX_CHECK_SECONDS}s.`);
  const job = await request(`/projects/${projectId}/preprocess/run`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  return waitForPreprocess(job);
}

function printCoverage(label, coverage) {
  console.log(`\n${label}`);
  console.log(`Project: ${coverage.projectName} (${coverage.projectId})`);
  console.log(`Ready source videos: ${coverage.readyVideos}/${coverage.sourceVideos}`);
  if (Number.isFinite(coverage.rejectedLowSignalVideos)) {
    console.log(`Rejected low-signal videos: ${coverage.rejectedLowSignalVideos}`);
  }
  console.log(`Direct VLM verified: ${coverage.strictVerifiedVideos}/${coverage.readyVideos} (${coverage.strictVerifiedRate}%)`);
  console.log(`AI verified for generation: ${coverage.aiVerifiedVideos ?? coverage.autoUsableVideos}/${coverage.readyVideos} ready (${coverage.aiVerifiedRate ?? coverage.autoUsableRate}%)`);
  console.log(`Auto-usable by ranker: ${coverage.autoUsableVideos}/${coverage.readyVideos} ready (${coverage.autoUsableRate}%)`);
  if (coverage.highlightEligibleVideos !== coverage.readyVideos) {
    console.log(`Eligible-only rate: ${coverage.autoUsableVideos}/${coverage.highlightEligibleVideos} eligible (${coverage.eligibleAutoUsableRate ?? "n/a"}%)`);
  }
  console.log(`Pending review: ${coverage.pendingReviewVideos}; exhausted after ${coverage.maxSemanticReviewAttempts} attempts: ${coverage.exhaustedUnverifiedVideos}`);
  if (coverage.missingAutoUsableExamples?.length) {
    console.log("Missing auto-usable examples:");
    for (const item of coverage.missingAutoUsableExamples.slice(0, 6)) {
      console.log(`- ${item.name}: ${item.reason} (semantic ${item.semanticScore}, index ${item.indexScore}, attempts ${item.attempts})`);
    }
  }
}

const project = await chooseProject();
let coverage = await request(`/projects/${project.id}/ai-coverage`);
printCoverage("Before workflow", coverage);

let modelOk = false;
try {
  await request("/ai-model/status", {
    method: "POST",
    body: JSON.stringify({ endpoint: VISION_ENDPOINT, apiKey: VISION_API_KEY, model: VISION_MODEL })
  });
  modelOk = true;
} catch (error) {
  console.log(`\nVision model unavailable: ${error.message}`);
}

if (modelOk) {
  await runPass(project.id, false);
  await runPass(project.id, true);
  coverage = await request(`/projects/${project.id}/ai-coverage`);
  printCoverage("After workflow", coverage);
} else {
  console.log("Skipped live Vision AI passes. Start the configured vision model, then run this script again.");
}

const productVerifiedRate = coverage.aiVerifiedRate ?? coverage.autoUsableRate;
const pass = productVerifiedRate >= TARGET_RATE;
console.log(`\nTarget ${TARGET_RATE}% AI verified generation coverage: ${pass ? "PASS" : "FAIL"}`);
if (coverage.strictVerifiedRate < TARGET_RATE) {
  console.log(`Direct VLM-only verification is ${coverage.strictVerifiedRate}%, below ${TARGET_RATE}%. The product uses ranker-verified candidates for coverage because the local VLM is still weak as a sole judge.`);
}
process.exitCode = pass ? 0 : 2;
