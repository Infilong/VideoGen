import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_DURATION = 300;
const bundledTools = process.env.HIGHLIGHTAI_FFMPEG_DIR;

export function canStartBackgroundJob(job, runnableStatuses) {
  return Boolean(job && !job.cancelRequested && runnableStatuses.includes(job.status));
}

function tool(command) {
  if (!bundledTools) return command;
  const candidate = path.join(bundledTools, process.platform === "win32" ? `${command}.exe` : command);
  return existsSync(candidate) ? candidate : command;
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool(command), args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else if (options.signal?.aborted) reject(new DOMException("Operation cancelled", "AbortError"));
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

export async function probe(filePath, signal) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate",
    "-of", "json",
    filePath
  ], { signal });
  const raw = JSON.parse(stdout);
  const video = raw.streams?.find((stream) => stream.codec_type === "video") ?? {};
  const audio = raw.streams?.find((stream) => stream.codec_type === "audio") ?? null;
  const duration = Number(raw.format?.duration ?? 0);
  const width = Number(video.width ?? 0);
  const height = Number(video.height ?? 0);
  return {
    duration,
    size: Number(raw.format?.size ?? 0),
    bitrate: Number(raw.format?.bit_rate ?? 0),
    width,
    height,
    fps: parseRate(video.r_frame_rate),
    videoCodec: video.codec_name ?? "unknown",
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    qualityScore: scoreQuality(width, height, Number(raw.format?.bit_rate ?? 0), duration)
  };
}

export async function analyzeActionSignals(filePath, duration, signal) {
  const start = Math.max(0, duration - Math.min(35, duration * 0.55));
  const sampleDuration = Math.min(24, Math.max(6, duration - start));
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-ss", String(start), "-t", String(sampleDuration), "-i", filePath,
    "-vf", "scale=320:-2,select='gt(scene,0.16)',metadata=print",
    "-af", "asetnsamples=n=48000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level,volumedetect",
    "-f", "null", "-"
  ], { signal });
  const sceneScores = [...stderr.matchAll(/lavfi\.scene_score=([\d.]+)/g)].map((match) => Number(match[1]));
  const maxVolume = Number(stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1] || -40);
  const meanVolume = Number(stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1] || -40);
  const audioFrames = [...stderr.matchAll(/pts_time:([\d.]+)[\s\S]*?lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/g)]
    .map((match) => ({ time: Number(match[1]), level: Number(match[2]) }))
    .filter((frame) => Number.isFinite(frame.level) && frame.time <= sampleDuration - 2);
  const loudest = audioFrames.sort((a, b) => b.level - a.level)[0];
  const sceneEnergy = sceneScores.reduce((sum, value) => sum + value, 0);
  const actionScore = Math.round((sceneEnergy * 16 + sceneScores.length * 2 + Math.max(0, 24 + meanVolume) + Math.max(0, 8 + maxVolume)) * 10) / 10;
  const highlightStart = loudest ? Math.max(0, start + loudest.time - 1.2) : Math.max(0, duration - 20);
  return { actionScore, sceneCuts: sceneScores.length, meanVolume, maxVolume, highlightStart };
}

export function scoreCandidateWindow(window, actionScore = 0) {
  const audioPeak = Number(window.audioPeak);
  const audio = Number.isFinite(audioPeak) ? clamp(((audioPeak + 32) / 25) * 30, 0, 30) : 0;
  const scenes = clamp((Number(window.sceneChanges) || 0) * 3.2, 0, 30);
  const action = clamp((Math.log1p(Math.max(0, Number(actionScore) || 0)) / Math.log1p(300)) * 24, 0, 24);
  const reason = window.reason === "audio_peak" ? 12 : window.reason === "scene_change" ? 10 : 6;
  return Math.round(clamp(reason + audio + scenes + action, 10, 96));
}

export function calibrateHighlightScores(files) {
  const local = [];
  for (const file of files) {
    const metadata = file.metadata || (file.metadata = {});
    for (const window of metadata.candidateWindows || []) {
      window.score = scoreCandidateWindow(window, metadata.actionScore);
      window.storyRole = window.score >= 84 ? "payoff" : window.score >= 68 ? "anticipation" : "setup";
      window.cutRisk = window.score >= 80 ? "high" : "medium";
    }
    const bestWindow = Math.max(0, ...(metadata.candidateWindows || []).map((window) => Number(window.score) || 0));
    const raw = bestWindow * 0.72
      + clamp(Number(metadata.actionScore) || 0, 0, 180) * 0.13
      + clamp(Number(metadata.qualityScore) || 0, 0, 100) * 0.15;
    local.push({ file, raw });
  }

  const ordered = [...local].sort((a, b) => a.raw - b.raw);
  for (const item of local) {
    const lower = ordered.findIndex((candidate) => candidate.raw >= item.raw);
    const upperFromEnd = [...ordered].reverse().findIndex((candidate) => candidate.raw <= item.raw);
    const upper = upperFromEnd < 0 ? lower : ordered.length - 1 - upperFromEnd;
    const rank = Math.max(0, (lower + upper) / 2);
    const percentile = ordered.length > 1 ? rank / (ordered.length - 1) : 0.5;
    const metadata = item.file.metadata;
    const localScore = Math.round(38 + percentile * 57);
    const hasVisionScore = Number.isFinite(metadata.semanticScore);
    const hasSemanticEvents = (metadata.semanticEvents || []).length > 0;
    const reviewedFrames = Number(metadata.semanticFramesReviewed || 0);
    if (hasVisionScore && (hasSemanticEvents || reviewedFrames === 0)) {
      metadata.indexScore = Math.round(clamp(metadata.semanticScore, 0, 100));
      metadata.ratingSource = "vision-ai";
      metadata.ratingConfidence = hasSemanticEvents ? "high" : "unknown";
    } else if (hasVisionScore && reviewedFrames > 0) {
      // A few sampled frames cannot fairly invalidate an entire long recording.
      metadata.indexScore = Math.round(localScore * 0.75 + clamp(metadata.semanticScore, 0, 100) * 0.25);
      metadata.ratingSource = "vision-ai-assisted";
      metadata.ratingConfidence = "low";
    } else {
      metadata.indexScore = localScore;
      metadata.ratingSource = "local-signals";
      metadata.ratingConfidence = "medium";
    }
  }
  return files;
}

export async function analyzeCandidateWindows(filePath, duration, options = {}) {
  const maxWindows = Math.max(1, Math.min(8, Number(options.maxWindows) || 4));
  const windowDuration = Math.max(8, Math.min(20, Number(options.windowDuration) || 14));
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-i", filePath,
    "-vf", "fps=1,scale=160:-2,select='gt(scene,0.08)',metadata=print",
    "-af", "asetnsamples=n=48000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
    "-f", "null", "-"
  ], { signal: options.signal });
  const sceneHits = [...stderr.matchAll(/pts_time:([\d.]+)[\s\S]{0,300}?lavfi\.scene_score=([\d.]+)/g)]
    .map((match) => ({ time: Number(match[1]), score: Number(match[2]) * 100 }))
    .filter((hit) => Number.isFinite(hit.time) && Number.isFinite(hit.score));
  const audioHits = [...stderr.matchAll(/pts_time:([\d.]+)[\s\S]{0,500}?lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/g)]
    .map((match) => ({ time: Number(match[1]), level: Number(match[2]) }))
    .filter((hit) => Number.isFinite(hit.time) && Number.isFinite(hit.level));
  const loudest = [...audioHits].sort((a, b) => b.level - a.level).slice(0, Math.max(8, maxWindows * 3));
  const candidates = new Map();
  const addCandidate = (time, baseScore, reason) => {
    const start = clamp(time - windowDuration * 0.45, 0, Math.max(0, duration - windowDuration));
    const bucket = Math.round(start / 3) * 3;
    const nearbyScenes = sceneHits.filter((hit) => Math.abs(hit.time - time) <= windowDuration / 2);
    const nearbyAudio = audioHits.filter((hit) => Math.abs(hit.time - time) <= windowDuration / 2);
    const score = scoreCandidateWindow({
      audioPeak: nearbyAudio.length ? Math.max(...nearbyAudio.map((hit) => hit.level)) : -60,
      sceneChanges: nearbyScenes.length,
      reason
    }, baseScore + nearbyScenes.reduce((sum, hit) => sum + hit.score, 0));
    const current = candidates.get(bucket);
    if (!current || score > current.score) {
      candidates.set(bucket, {
        start: Math.round(start * 10) / 10,
        end: Math.round(Math.min(duration, start + windowDuration) * 10) / 10,
        duration: Math.round(Math.min(windowDuration, duration - start) * 10) / 10,
        score,
        reason,
        sceneChanges: nearbyScenes.length,
        audioPeak: Math.round((nearbyAudio.length ? Math.max(...nearbyAudio.map((hit) => hit.level)) : -60) * 10) / 10,
        storyRole: score >= 86 ? "payoff" : score >= 72 ? "anticipation" : "setup",
        cutRisk: score >= 82 ? "high" : "medium"
      });
    }
  };
  for (const hit of loudest) addCandidate(hit.time, 45, "audio_peak");
  for (const hit of sceneHits.sort((a, b) => b.score - a.score).slice(0, Math.max(8, maxWindows * 3))) addCandidate(hit.time, 38, "scene_change");
  if (!candidates.size) addCandidate(Math.max(0, duration * 0.65), 45, "fallback_midpoint");
  return [...candidates.values()]
    .filter((window) => window.duration >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxWindows);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function intervalEnd(item) {
  const start = Number(item?.start) || 0;
  return Number(item?.end) || start + (Number(item?.duration) || 0);
}

function overlapsRejectedHighlight(metadata = {}, start = 0, end = start) {
  return (metadata.rejectedHighlightMoments || []).some((item) =>
    item?.reason === "not-highlight" &&
    Math.max(Number(item.start) || 0, start) < Math.min(intervalEnd(item), end) - 0.75
  );
}

function semanticSummaryEvidence(metadata = {}) {
  const rating = metadata.semanticRating || {};
  const traits = metadata.semanticTraits || {};
  const reject = String(rating.excludeReason || "none").toLowerCase();
  const hardRejects = new Set(["menu", "scoreboard", "map", "loading", "death", "boring_travel", "walking", "waiting", "weak_aim", "unreadable", "duplicate"]);
  if (hardRejects.has(reject)) return null;
  if (Number(rating.boredom || 0) >= 60) return null;
  if (Number(traits.clarity || 0) < 60) return null;
  if (Number(traits.obstruction || 0) > 50) return null;
  const text = `${traits.action || ""} ${metadata.semanticRejectReason || ""} ${(metadata.semanticTags || []).join(" ")}`.toLowerCase();
  const score = Math.max(
    Number(metadata.semanticScore || 0),
    Number(rating.trailerUsefulness || 0),
    Number(rating.excitement || 0),
    Number(traits.intensity || 0),
    Number(traits.spectacle || 0)
  );
  const explicitPayoff = traits.payoffVerified === true && Number(metadata.semanticScore || 0) >= 70;
  const strongSemantic = Number(metadata.semanticScore || 0) >= 70
    || (Number(rating.trailerUsefulness || 0) >= 70 && (Number(traits.intensity || 0) >= 70 || Number(traits.spectacle || 0) >= 70));
  const decisiveText = /explosion|destroy|destruction|detonat|sniper|headshot|vehicle|air combat|shoot|shot|objective|capture|kill/i.test(text)
    && Number(traits.intensity || 0) >= 70;
  if (!explicitPayoff && !strongSemantic && !decisiveText) return null;
  return {
    score: clamp(Math.round(score || Number(metadata.indexScore || 0) || 64), 0, 100),
    action: String(traits.action || rating.payoffStage || "strong AI candidate").slice(0, 100),
    subject: String(traits.subject || "other").slice(0, 40),
    state: explicitPayoff ? "impact" : String(rating.payoffStage || "impact").slice(0, 30),
    storyRole: explicitPayoff ? "payoff" : "anticipation",
    payoffVerified: explicitPayoff
  };
}

function reliableFocusTime(metadata = {}) {
  const semanticEvents = [...(metadata.semanticEvents || []), ...(metadata.semanticCandidateHistory || [])];
  const weakVisionMiss = Number(metadata.semanticFramesReviewed || 0) > 0 &&
    !semanticEvents.length &&
    (metadata.ratingConfidence === "low" || metadata.semanticQuality === "missed" || Number(metadata.semanticScore || 0) < 25);
  if (weakVisionMiss && Number.isFinite(Number(metadata.highlightStart))) return Number(metadata.highlightStart);
  return Number(metadata.semanticTopFrame ?? metadata.highlightStart ?? metadata.duration / 2);
}

function localSignalCandidateEvidence(metadata = {}) {
  if (!Number.isFinite(Number(metadata.highlightStart))) return null;
  if ((metadata.semanticEvents || []).length || (metadata.semanticCandidateHistory || []).length || (metadata.candidateWindows || []).length) return null;
  const indexScore = Number(metadata.indexScore || 0);
  const actionScore = Number(metadata.actionScore || 0);
  if (indexScore < 30 && actionScore < 20) return null;
  return {
    focus: Number(metadata.highlightStart),
    score: clamp(Math.max(indexScore + 35, actionScore + 20, 62), 0, 76),
    confidence: indexScore >= 45 || actionScore >= 60 ? "medium" : "low"
  };
}

function localSignalCandidateWindow(metadata = {}, localSignal = {}) {
  const sourceDuration = Number(metadata.duration || 0);
  const focus = Number(localSignal.focus);
  const sustainedSignal = localSignal.confidence === "low" &&
    Number(metadata.indexScore || 0) >= 30 &&
    Number(metadata.actionScore || 0) >= 15;
  if (sustainedSignal) {
    const duration = Math.min(24, Math.max(14, sourceDuration * 0.27 || 18));
    const start = Math.max(0, Math.min(Math.max(0, sourceDuration - duration), Math.ceil(focus + 2)));
    return { start, end: Math.min(sourceDuration || start + duration, start + duration), duration };
  }
  const duration = Math.min(12, Math.max(8, sourceDuration * 0.11 || 10));
  const start = Math.max(0, Math.min((sourceDuration || duration) - duration, focus - duration * 0.45));
  return { start, end: Math.min(sourceDuration || start + duration, start + duration), duration };
}

function parseRate(rate = "0/1") {
  const [a, b] = rate.split("/").map(Number);
  return b ? Math.round((a / b) * 10) / 10 : 0;
}

function scoreQuality(width, height, bitrate, duration) {
  const pixels = width * height;
  const resolution = pixels >= 2560 * 1440 ? 40 : pixels >= 1920 * 1080 ? 35 : pixels >= 1280 * 720 ? 27 : 17;
  const rate = bitrate >= 15_000_000 ? 32 : bitrate >= 8_000_000 ? 27 : bitrate >= 3_000_000 ? 20 : 12;
  const length = duration >= 60 ? 20 : duration >= 20 ? 15 : 8;
  return Math.min(98, resolution + rate + length + 6);
}

export function createSegments(files, targetDuration, intensity = 78) {
  const maxDuration = Math.min(MAX_DURATION, Math.max(15, Number(targetDuration) || 60));
  const segmentLength = intensity >= 88 ? 4 : intensity >= 75 ? 6 : 9;
  const candidates = [];
  const rankedFiles = files
    .filter(isUsableSourceForGeneration)
    .sort((a, b) => (b.metadata.actionScore || 0) - (a.metadata.actionScore || 0));
  for (const file of rankedFiles) {
    const usable = Math.max(0, file.metadata.duration - segmentLength);
    const count = intensity >= 88 ? 1 : Math.max(1, Math.min(3, Math.floor(file.metadata.duration / 40)));
    for (let i = 0; i < count; i += 1) {
      const focus = file.metadata.highlightStart ?? usable * 0.66;
      const preferredStart = Math.max(0, focus - segmentLength * 0.55);
      const ratioStart = usable * ((i + 1) / (count + 1));
      candidates.push({
        fileId: file.id,
        start: Math.max(0, Math.min(usable, intensity >= 88 ? preferredStart : ratioStart)),
        duration: Math.min(segmentLength, file.metadata.duration),
        score: Math.round((file.metadata.actionScore || 50) - i * 2 - candidates.length * 0.02)
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected = [];
  let total = 0;
  for (const candidate of candidates) {
    const remaining = maxDuration - total;
    if (remaining < 1) break;
    selected.push({ ...candidate, duration: Math.min(candidate.duration, remaining) });
    total += Math.min(candidate.duration, remaining);
  }
  return { segments: selected, duration: Math.round(total * 10) / 10 };
}

export function refineDraftPlan(draft, files, changes = {}) {
  const instruction = String(changes.instruction || "").trim();
  const normalized = instruction.toLowerCase();
  const next = { ...draft, ...changes };
  delete next.instruction;

  if (normalized.includes("short")) next.duration = Math.max(15, Number(draft.duration || 60) - 20);
  if (normalized.includes("long")) next.duration = Math.min(MAX_DURATION, Number(draft.duration || 60) + 20);
  if (normalized.includes("action") || normalized.includes("energy") || normalized.includes("intense")) {
    next.intensity = Math.min(100, Number(draft.intensity || 78) + 10);
  }
  if (normalized.includes("cinematic")) {
    next.style = "Cinematic";
    next.intensity = Math.max(65, Number(next.intensity || 78));
  }
  if (normalized.includes("slower") || normalized.includes("story")) {
    next.intensity = Math.max(45, Number(draft.intensity || 78) - 12);
  }

  next.duration = Math.min(MAX_DURATION, Math.max(15, Number(next.duration || draft.duration || 60)));
  next.intensity = Math.min(100, Math.max(1, Number(next.intensity || draft.intensity || 78)));
  const generated = next.style === "Trailer"
    ? buildAgenticEditPlan(files, next.duration)
    : createSegments(files, next.duration, next.intensity);
  next.segments = generated.segments;
  next.duration = generated.duration;
  next.workflow = generated.workflow;
  next.changes = instruction
    ? [...(draft.changes || []), instruction]
    : [...(changes.changes || draft.changes || [])];
  next.version = Number(draft.version || 1) + 1;
  next.status = "ready";
  delete next.exportUrl;
  delete next.exportPath;
  delete next.review;
  return next;
}

export function createTrailerSegments(files, targetDuration = 150) {
  const limit = Math.min(MAX_DURATION, Math.max(45, Number(targetDuration) || 150));
  const contentLimit = limit;
  const sourceFiles = files.filter(isUsableSourceForGeneration);
  const semantic = sourceFiles.filter((file) => (file.metadata.semanticEvents || []).length && (file.metadata.semanticScore || 0) >= 60);
  const approved = sourceFiles.filter((file) => file.metadata.visionApproved !== false && (file.metadata.visionScore || 0) >= 70);
  const semanticPlan = semantic.length ? createSemanticTrailerSegments(semantic, limit, contentLimit) : { segments: [], duration: 0 };
  const selected = [];
  const usedFiles = new Set();
  let total = semanticPlan.duration;
  for (const segment of semanticPlan.segments) {
    selected.push(segment);
    usedFiles.add(segment.fileId);
  }
  const indexed = semantic.length
    ? []
    : sourceFiles.filter((file) => (file.metadata.candidateWindows || []).length && !usedFiles.has(file.id));
  const indexedPlan = indexed.length ? createIndexedTrailerSegments(indexed, contentLimit, total) : { segments: [], duration: total };
  for (const segment of indexedPlan.segments) {
    selected.push(segment);
    usedFiles.add(segment.fileId);
  }
  total = indexedPlan.duration;

  const pool = semantic.length ? [] : approved.length >= 12 ? approved : sourceFiles;
  const ranked = sequenceTrailerShots(pool.filter((file) => !usedFiles.has(file.id)));
  let cursor = 0;
  while (total < contentLimit - 1 && cursor < ranked.length) {
    const progress = total / contentLimit;
    const desired = progress < 0.18 ? 8 : progress < 0.58 ? 7 : progress < 0.84 ? 5.5 : 3.5;
    const file = ranked[cursor++];
    const duration = Math.min(desired, contentLimit - total, file.metadata.duration);
    const focus = file.metadata.highlightStart ?? Math.max(0, file.metadata.duration - 16);
    selected.push({
      fileId: file.id,
      start: Math.max(0, Math.min(file.metadata.duration - duration, focus - duration * 0.45)),
      duration,
      score: file.metadata.actionScore || 50
    });
    total += duration;
  }
  return { segments: selected, duration: Math.round(total * 10) / 10 };
}

export function buildAgenticEditPlan(files, targetDuration = 150, options = {}) {
  const sourceFiles = files.filter(isUsableSourceForGeneration);
  const hardRejectStates = new Set(["menu", "scoreboard", "map", "loading", "death"]);
  if (["military_fps", "battle_royale"].includes(options.gameGenre)) {
    ["walking", "waiting", "travel"].forEach((state) => hardRejectStates.add(state));
  } else {
    hardRejectStates.add("waiting");
  }
  const candidates = [];
  const rejected = [];
  const reviewCandidateMinScore = Number(options.reviewCandidateMinScore ?? options.minScore ?? 64);
  const excludedIntervals = new Set(Array.isArray(options.excludedIntervals) ? options.excludedIntervals : []);
  const isExcluded = (candidate) => excludedIntervals.has(
    `${candidate.fileId}:${Math.round(candidate.start)}:${Math.round(candidate.duration)}`
  );

  for (const file of sourceFiles) {
    const metadata = file.metadata || {};
    const tags = [...new Set([...(metadata.semanticTags || []), ...(metadata.indexTags || [])])].slice(0, 6);
    const subject = metadata.semanticTraits?.subject || tags[0] || "other";
    const semanticEvents = metadata.semanticEvents || [];
    const hasConfirmedMoments = (metadata.confirmedHighlightMoments || []).length > 0;
    for (const moment of metadata.confirmedHighlightMoments || []) {
      const start = Math.max(0, Number(moment.start) || 0);
      const end = Math.min(metadata.duration || 0, Number(moment.end) || start + Number(moment.duration || 0));
      if (overlapsRejectedHighlight(metadata, start, end)) {
        rejected.push({ fileId: file.id, reason: "User rejected this confirmed interval as not a highlight" });
        continue;
      }
      if (end - start < 1) {
        rejected.push({ fileId: file.id, reason: "Confirmed highlight period is too short" });
        continue;
      }
      const candidate = {
        fileId: file.id,
        start,
        duration: end - start,
        minDuration: Math.max(1, end - start),
        score: clamp(Math.max(Number(moment.score) || 0, Number(metadata.semanticScore) || 0, Number(metadata.indexScore) || 0, 85) + 8, 0, 100),
        storyRole: moment.storyRole || "payoff",
        state: moment.state || "human-confirmed",
        action: moment.action || metadata.semanticTraits?.action || "confirmed highlight",
        subject,
        tags,
        confidence: "high",
        impactTime: end,
        source: "human-confirmed"
      };
      if (isExcluded(candidate)) rejected.push({ fileId: file.id, reason: "Visual reviewer rejected confirmed interval" });
      else candidates.push(candidate);
    }
    for (const event of semanticEvents) {
      const start = Math.max(0, Number(event.start) || 0);
      const end = Math.min(metadata.duration || 0, Number(event.end) || start + 6);
      if (overlapsRejectedHighlight(metadata, start, end)) {
        rejected.push({ fileId: file.id, reason: "User rejected this vision interval as not a highlight" });
        continue;
      }
      if (options.requireVerifiedVision && event.payoffVerified !== true) {
        rejected.push({ fileId: file.id, reason: "Legacy or incomplete vision event has no verified visible outcome" });
        continue;
      }
      if (hardRejectStates.has(event.state)) {
        rejected.push({ fileId: file.id, reason: `Rejected ${event.state || "short"} semantic event` });
        continue;
      }
      const storyRole = event.storyRole || event.payoffStage || "none";
      const impactTime = Number.isFinite(Number(event.impactTime)) ? Number(event.impactTime) : end;
      const highCutRisk = event.cutRisk === "high" || ["payoff", "impact", "reaction"].includes(storyRole) || ["impact", "reaction"].includes(event.state);
      const before = event.payoffVerified === true
        ? (highCutRisk ? 3.5 : 2)
        : ["payoff", "impact"].includes(storyRole) ? 4 : 2;
      const after = event.payoffVerified === true
        ? (highCutRisk ? 5 : 3)
        : ["payoff", "impact", "reaction"].includes(storyRole) ? 5 : 2.5;
      const windowEnd = Math.min(metadata.duration, Math.max(end + after, impactTime + after));
      const uncappedStart = Math.max(0, start - before);
      const maxWindow = highCutRisk ? 18 : 14;
      const windowStart = event.payoffVerified === true && windowEnd - uncappedStart > maxWindow
        ? Math.max(0, windowEnd - maxWindow)
        : uncappedStart;
      const protectedUntil = Math.min(metadata.duration, Math.max(end, impactTime + Math.min(after, 4.5)));
      if (windowEnd - windowStart < 3.5) {
        rejected.push({ fileId: file.id, reason: "Rejected short semantic event" });
        continue;
      }
      const candidate = {
        fileId: file.id,
        start: windowStart,
        duration: windowEnd - windowStart,
        minDuration: Math.max(4, Math.min(windowEnd - windowStart, protectedUntil - windowStart)),
        score: clamp(Number(event.score) || metadata.semanticScore || 60, 0, 100),
        storyRole,
        state: event.state || "other",
        action: event.action || metadata.semanticTraits?.action || "gameplay event",
        subject,
        tags,
        confidence: metadata.ratingConfidence || "high",
        impactTime,
        source: "vision"
      };
      if (isExcluded(candidate)) rejected.push({ fileId: file.id, reason: "Visual reviewer rejected interval" });
      else candidates.push(candidate);
    }

    if (options.allowReviewCandidates) {
      const allowWeakReviewCandidates = options.allowWeakReviewCandidates === true;
      const verifiedIntervals = semanticEvents
        .filter((event) => event.payoffVerified === true)
        .map((event) => ({
          start: Math.max(0, Number(event.start) || 0),
          end: Math.min(metadata.duration || 0, Number(event.end) || 0)
        }));
      for (const event of metadata.semanticCandidateHistory || []) {
        const start = Math.max(0, Number(event.start) || 0);
        const end = Math.min(metadata.duration || 0, Number(event.end) || start);
        if (overlapsRejectedHighlight(metadata, start, end)) {
          rejected.push({ fileId: file.id, reason: "User rejected this stored candidate as not a highlight" });
          continue;
        }
        const overlapsVerified = verifiedIntervals.some((interval) =>
          Math.max(interval.start, start) < Math.min(interval.end, end) - 1
        );
        if (options.requireVerifiedVision && !allowWeakReviewCandidates && event.payoffVerified !== true) {
          rejected.push({ fileId: file.id, reason: "Stored candidate has no verified visible payoff" });
          continue;
        }
        if (overlapsVerified || hardRejectStates.has(event.state) || end - start < 3.5) continue;
        const rawScore = Number(event.score) || metadata.semanticScore || 60;
        const confidence = event.payoffVerified === true
          ? "high"
          : rawScore >= 82 ? "medium" : rawScore >= 64 ? "medium" : "low";
        if (allowWeakReviewCandidates && event.payoffVerified !== true && rawScore < reviewCandidateMinScore) {
          rejected.push({ fileId: file.id, reason: "Weak stored candidate below auto-rank threshold" });
          continue;
        }
        const candidate = {
          fileId: file.id,
          start,
          duration: end - start,
          minDuration: Math.max(4, Math.min(end - start, (Number(event.impactTime) || end) - start + 3)),
          score: clamp(rawScore - (event.payoffVerified === true ? 2 : 6), 0, 100),
          storyRole: event.storyRole || event.payoffStage || "anticipation",
          state: event.state || "other",
          action: event.action || metadata.semanticTraits?.action || "candidate gameplay payoff",
          subject,
          tags,
          confidence,
          impactTime: Number(event.impactTime) || end,
          source: "vision-candidate"
        };
        if (isExcluded(candidate)) rejected.push({ fileId: file.id, reason: "Visual reviewer rejected candidate interval" });
          else candidates.push(candidate);
      }

      const hasPreciseCandidate = semanticEvents.length > 0
        || (metadata.semanticCandidateHistory || []).length > 0
        || (metadata.candidateWindows || []).length > 0;
      const summary = !hasPreciseCandidate || options.allowSemanticSummaryCandidates === true
        ? semanticSummaryEvidence(metadata)
        : null;
      if (summary) {
        const center = reliableFocusTime(metadata);
        const duration = Math.min(14, Math.max(7, Number(metadata.duration || 0) * 0.16 || 10));
        const start = Math.max(0, Math.min(Number(metadata.duration || duration) - duration, center - duration * 0.45));
        const end = Math.min(Number(metadata.duration || start + duration), start + duration);
        if (!overlapsRejectedHighlight(metadata, start, end) && end - start >= 3.5) {
          const candidate = {
            fileId: file.id,
            start,
            duration: end - start,
            minDuration: Math.max(4, Math.min(end - start, duration * 0.75)),
            score: clamp(summary.score - (summary.payoffVerified ? 0 : 5), 0, 100),
            storyRole: summary.storyRole,
            state: summary.state,
            action: summary.action,
            subject: summary.subject || subject,
            tags,
            confidence: summary.payoffVerified ? "high" : "medium",
            impactTime: Math.min(end, Math.max(start, center)),
            source: summary.payoffVerified ? "vision-summary" : "vision-summary-candidate"
          };
          if (isExcluded(candidate)) rejected.push({ fileId: file.id, reason: "Visual reviewer rejected semantic summary candidate" });
          else candidates.push(candidate);
        }
      }

      const localSignal = localSignalCandidateEvidence(metadata);
      if (localSignal) {
        const { start, end, duration } = localSignalCandidateWindow(metadata, localSignal);
        if (!overlapsRejectedHighlight(metadata, start, end) && end - start >= 3.5) {
          const candidate = {
            fileId: file.id,
            start,
            duration: end - start,
            minDuration: Math.max(4, Math.min(end - start, localSignal.focus - start + 2.5)),
            score: localSignal.score,
            storyRole: "anticipation",
            state: "local-signal",
            action: metadata.semanticTraits?.action || "local highlight signal",
            subject,
            tags,
            confidence: localSignal.confidence,
            impactTime: localSignal.focus,
            source: "local-signal"
          };
          if (isExcluded(candidate)) rejected.push({ fileId: file.id, reason: "Visual reviewer rejected local signal interval" });
          else candidates.push(candidate);
        }
      }
    }

    for (const window of options.disableIndexedFallback ? [] : metadata.candidateWindows || []) {
      if (hasConfirmedMoments && options.requireVerifiedVision) {
        rejected.push({ fileId: file.id, reason: "Indexed fallback skipped because user confirmed a highlight period" });
        continue;
      }
      if (options.requireVerifiedVision && Number(metadata.semanticFramesReviewed || 0) > 0 && options.allowIndexedAfterUncertainVision !== true) {
        rejected.push({
          fileId: file.id,
          reason: semanticEvents.length
            ? "Indexed fallback replaced by a verified vision event"
            : "Indexed fallback rejected because Vision AI found no complete event"
        });
        continue;
      }
      const start = Math.max(0, Number(window.start) || 0);
      const duration = Math.min(16, Number(window.duration) || Math.max(0, Number(window.end) - start) || 8);
      if (overlapsRejectedHighlight(metadata, start, start + duration)) {
        rejected.push({ fileId: file.id, reason: "User rejected this indexed window as not a highlight" });
        continue;
      }
      const semanticPenalty = semanticEvents.length
        ? 8
        : metadata.ratingConfidence === "low" && Number(metadata.semanticScore || 0) < 20 ? 24
          : options.allowIndexedAfterUncertainVision && Number(metadata.semanticFramesReviewed || 0) > 0 ? 12
            : 0;
      const score = clamp(
        Number(window.score || metadata.indexScore || 50) * 0.68
        + Number(metadata.indexScore || 50) * 0.2
        + Number(metadata.qualityScore || 70) * 0.12
        - semanticPenalty,
        0,
        100
      );
      if (score < Math.max(58, Number(options.minScore) || 64)) {
        rejected.push({ fileId: file.id, reason: "Low-confidence indexed window" });
        continue;
      }
      const candidate = {
        fileId: file.id,
        start,
        duration,
        minDuration: Math.max(4, Math.min(duration, duration * 0.82)),
        score,
        storyRole: window.storyRole || "setup",
        state: "indexed",
        action: metadata.semanticTraits?.action || window.reason || "gameplay action",
        subject,
        tags,
        confidence: score >= 82 && metadata.ratingConfidence !== "low" ? "medium" : score >= 64 ? "medium" : "low",
        impactTime: start + duration * 0.72,
        source: "index"
      };
      if (isExcluded(candidate)) rejected.push({ fileId: file.id, reason: "Visual reviewer rejected interval" });
      else candidates.push(candidate);
    }
  }

  const unique = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    const overlaps = unique.some((item) =>
      item.fileId === candidate.fileId &&
      Math.max(item.start, candidate.start) < Math.min(item.start + item.duration, candidate.start + candidate.duration) - 1
    );
    if (overlaps) {
      rejected.push({ fileId: candidate.fileId, reason: "Duplicate source interval" });
      continue;
    }
    unique.push(candidate);
  }

  const durationLimit = Math.min(MAX_DURATION, Math.max(30, Number(targetDuration) || 150));
  const selected = [];
  const subjectCounts = new Map();
  const actionCounts = new Map();
  let elapsed = 0;
  while (elapsed < durationLimit - 2 && unique.length) {
    const progress = elapsed / durationLimit;
    const desiredIntensity = 52 + progress * 45;
    let bestIndex = 0;
    let bestValue = -Infinity;
    unique.forEach((candidate, index) => {
      const subjectUses = subjectCounts.get(candidate.subject) || 0;
      const actionUses = actionCounts.get(candidate.action) || 0;
      const roleBonus = progress > 0.72
        ? (["payoff", "impact", "reaction"].includes(candidate.storyRole) ? 20 : -8)
        : progress < 0.18 && candidate.storyRole === "setup" ? 8 : 0;
      const diversity = subjectUses === 0 ? 13 : subjectUses === 1 ? 3 : -14;
      const actionDiversity = actionUses === 0 ? 9 : actionUses === 1 ? 1 : -12;
      const intensityFit = 18 - Math.abs(candidate.score - desiredIntensity) * 0.18;
      const confidence = candidate.confidence === "high" ? 8 : candidate.confidence === "low" ? -5 : 2;
      const value = candidate.score * 0.58 + roleBonus + diversity + actionDiversity + intensityFit + confidence;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    });
    const candidate = unique.splice(bestIndex, 1)[0];
    const remaining = durationLimit - elapsed;
    const duration = Math.min(candidate.duration, remaining);
    if (duration < 3.5) break;
    selected.push({ ...candidate, duration: Math.round(duration * 100) / 100 });
    subjectCounts.set(candidate.subject, (subjectCounts.get(candidate.subject) || 0) + 1);
    actionCounts.set(candidate.action, (actionCounts.get(candidate.action) || 0) + 1);
    elapsed += duration;
  }

  const orderedSelected = orderTrailerArc(selected);
  const critique = critiqueAgenticPlan(orderedSelected, durationLimit, options);
  return {
    segments: orderedSelected.map(({ fileId, start, duration, score, minDuration, storyRole, source, confidence }) => ({
      fileId,
      start: Math.round(start * 100) / 100,
      duration,
      minDuration: Math.round(Math.min(duration, Math.max(1, Number(minDuration) || duration)) * 100) / 100,
      score: Math.round(score),
      storyRole,
      source,
      confidence
    })),
    duration: Math.round(elapsed * 10) / 10,
    workflow: {
      version: 1,
      status: critique.approved ? "approved" : "revised",
      requestedDuration: durationLimit,
      selectedMoments: orderedSelected.length,
      rejectedMoments: rejected.length,
      sourceVideosUsed: new Set(orderedSelected.map((item) => item.fileId)).size,
      specialists: {
        action: critique.action,
        boringFrames: critique.boringFrames,
        story: critique.story,
        diversity: critique.diversity
      },
      critique
    }
  };
}

export function maxLogoOutroDuration(musicDuration = 0) {
  const duration = Math.max(0, Number(musicDuration) || 0);
  if (!duration) return 0;
  return Math.round(Math.min(10, Math.max(4, duration * 0.07)) * 10) / 10;
}

export function extendDraftToMusicDuration(draft, files, musicDuration, options = {}) {
  if (draft.style !== "Trailer" || !Number(musicDuration)) return draft;
  const allowWeakFill = options.allowWeakFill === true;
  const maxOutro = Number(options.maxLogoOutroDuration ?? maxLogoOutroDuration(musicDuration));
  const targetContentDuration = Math.max(1, Math.min(MAX_DURATION, Number(musicDuration)) - maxOutro);
  const sources = files.filter(isUsableSourceForGeneration);
  const sourceById = new Map(sources.map((file) => [file.id, file]));
  const segments = (draft.segments || [])
    .filter((segment) => sourceById.has(segment.fileId))
    .map((segment) => ({ ...segment }));
  const overlaps = (a, b) =>
    a.fileId === b.fileId &&
    Math.max(Number(a.start) || 0, Number(b.start) || 0) <
      Math.min((Number(a.start) || 0) + (Number(a.duration) || 0), (Number(b.start) || 0) + (Number(b.duration) || 0)) - 0.75;
  const totalDuration = () => segments.reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0);
  let addedSegments = 0;
  let addedSeconds = 0;
  if (options.lockReviewedCuts === true) {
    const finalDuration = Math.round(totalDuration() * 10) / 10;
    return {
      ...draft,
      segments,
      duration: Math.max(Number(draft.duration) || 0, finalDuration),
      workflow: {
        ...(draft.workflow || {}),
        musicExtension: {
          targetContentDuration: Math.round(targetContentDuration * 10) / 10,
          maxLogoOutroDuration: maxOutro,
          addedSegments: 0,
          addedSeconds: 0,
          contentDuration: finalDuration,
          lockedReviewedCuts: true
        }
      }
    };
  }
  const appendCandidate = (candidate, source = "music-fill") => {
    const file = sourceById.get(candidate.fileId);
    if (!file) return false;
    const currentTotal = totalDuration();
    const remaining = targetContentDuration - currentTotal;
    if (remaining < 2.5) return false;
    const start = Math.max(0, Number(candidate.start) || 0);
    const sourceDuration = Number(file.metadata?.duration) || 0;
    const available = Math.max(0, sourceDuration - start);
    const duration = Math.min(remaining, available, Math.max(0, Number(candidate.duration) || 0));
    if (duration < 3.5) return false;
    const next = {
      ...candidate,
      start: Math.round(start * 100) / 100,
      duration: Math.round(duration * 100) / 100,
      minDuration: Math.round(Math.min(duration, Math.max(3.5, Number(candidate.minDuration) || duration)) * 100) / 100,
      source
    };
    if (segments.some((segment) => overlaps(segment, next))) return false;
    segments.push(next);
    addedSegments += 1;
    addedSeconds += next.duration;
    return true;
  };

  const extensionPlan = buildAgenticEditPlan(sources, targetContentDuration, {
    minScore: allowWeakFill ? 42 : 64,
    requireVerifiedVision: !allowWeakFill,
    allowReviewCandidates: allowWeakFill,
    allowWeakReviewCandidates: false,
    disableIndexedFallback: !allowWeakFill,
    qualityFirst: !allowWeakFill,
    gameGenre: options.gameGenre
  });
  for (const segment of extensionPlan.segments || []) {
    if (totalDuration() >= targetContentDuration - 0.5) break;
    appendCandidate(segment, segment.source || (allowWeakFill ? "relaxed-ai-fill" : "verified-ai-fill"));
  }

  if (allowWeakFill) {
    const trailerFallback = createTrailerSegments(sources, targetContentDuration);
    for (const segment of trailerFallback.segments || []) {
      if (totalDuration() >= targetContentDuration - 0.5) break;
      appendCandidate(segment, "ranked-fill");
    }

    const localFallback = createSegments(sources, targetContentDuration, options.intensity ?? draft.intensity ?? 78);
    for (const segment of localFallback.segments || []) {
      if (totalDuration() >= targetContentDuration - 0.5) break;
      appendCandidate(segment, "local-fill");
    }
  }

  if (options.lockExistingCuts !== true) {
    let remaining = targetContentDuration - totalDuration();
    for (const segment of [...segments].sort((a, b) => (b.score || 0) - (a.score || 0))) {
      if (remaining < 1) break;
      const file = sourceById.get(segment.fileId);
      if (!file) continue;
      const sourceDuration = Number(file.metadata?.duration) || 0;
      const end = (Number(segment.start) || 0) + (Number(segment.duration) || 0);
      const extra = Math.min(remaining, allowWeakFill ? 10 : 3, Math.max(0, sourceDuration - end));
      if (extra < 1) continue;
      const currentMinDuration = Number(segment.minDuration) || Math.min(segment.duration, 4);
      segment.duration = Math.round((Number(segment.duration) + extra) * 100) / 100;
      segment.minDuration = Math.round(Math.max(currentMinDuration, Math.min(segment.duration, currentMinDuration + extra)) * 100) / 100;
      addedSeconds += extra;
      remaining -= extra;
    }
  }

  const finalDuration = Math.round(totalDuration() * 10) / 10;
  return {
    ...draft,
    segments,
    duration: Math.max(Number(draft.duration) || 0, finalDuration),
    workflow: {
      ...(draft.workflow || {}),
      musicExtension: {
        targetContentDuration: Math.round(targetContentDuration * 10) / 10,
        maxLogoOutroDuration: maxOutro,
        addedSegments,
        addedSeconds: Math.round(addedSeconds * 10) / 10,
        contentDuration: finalDuration,
        lockExistingCuts: options.lockExistingCuts === true
      }
    }
  };
}

export function applyVisualReviewEditsToDraft(draft, visualReview = {}, options = {}) {
  const minSegmentDuration = Math.max(1, Number(options.minSegmentDuration) || 2.5);
  const rejectedIndexes = new Set((visualReview.rejectSegmentIndexes || []).map((index) => Number(index) - 1));
  const trimEdits = new Map();
  for (const edit of visualReview.trimSegmentEdits || []) {
    const index = Number(edit.segmentIndex) - 1;
    if (!Number.isInteger(index) || index < 0) continue;
    trimEdits.set(index, edit);
  }

  const segments = [];
  let trimmedSegments = 0;
  let rejectedByTrim = 0;
  for (const [index, segment] of (draft.segments || []).entries()) {
    if (rejectedIndexes.has(index)) continue;
    const originalStart = Math.max(0, Number(segment.start) || 0);
    const originalEnd = originalStart + Math.max(0, Number(segment.duration) || 0);
    const edit = trimEdits.get(index);
    if (!edit) {
      segments.push({ ...segment });
      continue;
    }
    const requestedStart = Number(edit.start ?? edit.keepStart ?? edit.trimStart);
    const requestedEnd = Number(edit.end ?? edit.keepEnd ?? edit.trimEnd);
    const nextStart = Number.isFinite(requestedStart)
      ? Math.max(originalStart, Math.min(originalEnd, requestedStart))
      : originalStart;
    const nextEnd = Number.isFinite(requestedEnd)
      ? Math.max(nextStart, Math.min(originalEnd, requestedEnd))
      : originalEnd;
    const nextDuration = nextEnd - nextStart;
    if (nextDuration < minSegmentDuration) {
      rejectedByTrim += 1;
      continue;
    }
    const trimmed = Math.abs(nextStart - originalStart) > 0.05 || Math.abs(nextEnd - originalEnd) > 0.05;
    if (trimmed) trimmedSegments += 1;
    segments.push({
      ...segment,
      start: Math.round(nextStart * 100) / 100,
      duration: Math.round(nextDuration * 100) / 100,
      minDuration: Math.round(Math.min(nextDuration, Math.max(1, Number(segment.minDuration) || minSegmentDuration)) * 100) / 100,
      trimReason: String(edit.reason || "Final review trimmed this shot.").slice(0, 160)
    });
  }

  const duration = Math.round(segments.reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0) * 10) / 10;
  return {
    ...draft,
    segments,
    duration,
    workflow: {
      ...(draft.workflow || {}),
      selectedMoments: segments.length,
      rejectedMoments: Number(draft.workflow?.rejectedMoments || 0) + rejectedIndexes.size + rejectedByTrim,
      visualReview: {
        ...(draft.workflow?.visualReview || {}),
        ...visualReview,
        trimmedSegments,
        rejectedByTrim
      },
      visualReviewEditsApplied: true
    }
  };
}

function intervalKey(segment) {
  return `${segment.fileId}:${Math.round(Number(segment.start) || 0)}:${Math.round(Number(segment.duration) || 0)}`;
}

function segmentOverlaps(a, b, tolerance = 0.75) {
  if (a.fileId !== b.fileId) return false;
  const aStart = Number(a.start) || 0;
  const bStart = Number(b.start) || 0;
  return Math.max(aStart, bStart) <
    Math.min(aStart + (Number(a.duration) || 0), bStart + (Number(b.duration) || 0)) - tolerance;
}

function sourceDurationFor(filesById, fileId) {
  return Number(filesById.get(fileId)?.metadata?.duration) || 0;
}

function polishSegmentAroundKnownPeak(segment, file) {
  const metadata = file?.metadata || {};
  const sourceDuration = Number(metadata.duration) || 0;
  const start = Math.max(0, Number(segment.start) || 0);
  const duration = Math.max(0, Number(segment.duration) || 0);
  const end = Math.min(sourceDuration || start + duration, start + duration);
  if (end - start < 1) return null;
  const candidatePeaks = [
    Number(segment.impactTime),
    Number(metadata.semanticTopFrame),
    Number(metadata.highlightStart),
    Number(metadata.localSignalTime),
    Number(metadata.actionPeakTime)
  ].filter((time) => Number.isFinite(time) && time >= start - 1 && time <= end + 1);
  for (const event of metadata.semanticEvents || []) {
    const eventStart = Number(event.start);
    const eventEnd = Number(event.end);
    const impact = Number(event.impactTime);
    if (Number.isFinite(impact) && impact >= start - 1 && impact <= end + 1) candidatePeaks.push(impact);
    else if (Number.isFinite(eventStart) && Number.isFinite(eventEnd) &&
      Math.max(start, eventStart) < Math.min(end, eventEnd) - 0.5) {
      candidatePeaks.push(Math.min(eventEnd, Math.max(eventStart, eventStart + (eventEnd - eventStart) * 0.72)));
    }
  }
  if (!candidatePeaks.length) return { ...segment, start: Math.round(start * 100) / 100, duration: Math.round((end - start) * 100) / 100 };
  const peak = candidatePeaks.sort((a, b) => {
    const center = start + (end - start) * 0.62;
    return Math.abs(a - center) - Math.abs(b - center);
  })[0];
  const role = segment.storyRole || segment.state || "";
  const highImpact = ["payoff", "impact", "reaction"].includes(role);
  const before = highImpact ? 2.5 : 1.6;
  const after = highImpact ? 4.2 : 3;
  const minDuration = Math.max(2.5, Math.min(Number(segment.minDuration) || 3.5, highImpact ? 5.5 : 4));
  let nextStart = Math.max(start, peak - before);
  let nextEnd = Math.min(end, peak + after);
  if (nextEnd - nextStart < minDuration) {
    const missing = minDuration - (nextEnd - nextStart);
    nextStart = Math.max(start, nextStart - missing * 0.45);
    nextEnd = Math.min(end, nextEnd + missing * 0.55);
  }
  if (nextEnd - nextStart < 2.5) return { ...segment, start: Math.round(start * 100) / 100, duration: Math.round((end - start) * 100) / 100 };
  const changed = Math.abs(nextStart - start) > 0.15 || Math.abs(nextEnd - end) > 0.15;
  return {
    ...segment,
    start: Math.round(nextStart * 100) / 100,
    duration: Math.round((nextEnd - nextStart) * 100) / 100,
    minDuration: Math.round(Math.min(nextEnd - nextStart, Math.max(1, Number(segment.minDuration) || minDuration)) * 100) / 100,
    ...(changed ? { trimReason: segment.trimReason || "Final editor centered this cut around the strongest detected moment." } : {})
  };
}

export function polishFinalTimeline(draft, files, targetDuration = 90, options = {}) {
  const sources = files.filter(isUsableSourceForGeneration);
  const filesById = new Map(sources.map((file) => [file.id, file]));
  const target = Math.min(MAX_DURATION, Math.max(12, Number(targetDuration) || Number(draft.duration) || 90));
  const minimumUsefulDuration = Math.min(target, Math.max(8, target * 0.55));
  const minimumUsefulSegments = Math.min(6, Math.max(2, Math.ceil(target / 24)));
  const segments = [];
  let trimmedSegments = 0;
  let removedSegments = 0;

  for (const segment of draft.segments || []) {
    const file = filesById.get(segment.fileId);
    const sourceDuration = sourceDurationFor(filesById, segment.fileId);
    if (!file || !sourceDuration) {
      removedSegments += 1;
      continue;
    }
    const start = Math.max(0, Math.min(sourceDuration, Number(segment.start) || 0));
    const duration = Math.min(Math.max(0, Number(segment.duration) || 0), Math.max(0, sourceDuration - start));
    if (duration < 2.5) {
      removedSegments += 1;
      continue;
    }
    const polished = polishSegmentAroundKnownPeak({ ...segment, start, duration }, file);
    if (!polished || Number(polished.duration || 0) < 2.5) {
      removedSegments += 1;
      continue;
    }
    if (segments.some((item) => segmentOverlaps(item, polished))) {
      removedSegments += 1;
      continue;
    }
    if (Math.abs(Number(polished.start) - start) > 0.05 || Math.abs(Number(polished.duration) - duration) > 0.05) trimmedSegments += 1;
    segments.push(polished);
  }

  let currentDuration = segments.reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0);
  const excludedIntervals = new Set([
    ...segments.map(intervalKey),
    ...(Array.isArray(options.excludedIntervals) ? options.excludedIntervals : [])
  ]);
  const replacementPlan = buildAgenticEditPlan(sources, target, {
    minScore: Number(options.minScore) || 64,
    relaxedMinScore: Number(options.relaxedMinScore) || 58,
    reviewCandidateMinScore: Number(options.reviewCandidateMinScore) || 64,
    requireVerifiedVision: false,
    allowReviewCandidates: true,
    allowWeakReviewCandidates: false,
    allowIndexedAfterUncertainVision: true,
    allowSemanticSummaryCandidates: true,
    gameGenre: options.gameGenre,
    qualityFirst: true,
    excludedIntervals: [...excludedIntervals]
  });
  let replacementSegments = 0;
  for (const candidate of replacementPlan.segments || []) {
    if (currentDuration >= minimumUsefulDuration && segments.length >= minimumUsefulSegments) break;
    const file = filesById.get(candidate.fileId);
    if (!file) continue;
    const polished = polishSegmentAroundKnownPeak({ ...candidate, source: candidate.source || "final-polish-fill" }, file);
    if (!polished || Number(polished.duration || 0) < 2.5) continue;
    if (segments.some((segment) => segmentOverlaps(segment, polished))) continue;
    const remaining = target - currentDuration;
    if (remaining < 2.5) break;
    const duration = Math.min(Number(polished.duration) || 0, remaining);
    segments.push({
      ...polished,
      duration: Math.round(duration * 100) / 100,
      minDuration: Math.round(Math.min(duration, Math.max(1, Number(polished.minDuration) || duration)) * 100) / 100,
      source: polished.source || "final-polish-fill"
    });
    replacementSegments += 1;
    currentDuration += duration;
  }

  const ordered = orderTrailerArc(segments).slice(0, 40);
  const duration = Math.round(ordered.reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0) * 10) / 10;
  const critique = critiqueAgenticPlan(ordered, target, { qualityFirst: true });
  return {
    ...draft,
    segments: ordered,
    duration,
    workflow: {
      ...(draft.workflow || {}),
      selectedMoments: ordered.length,
      rejectedMoments: Number(draft.workflow?.rejectedMoments || 0) + removedSegments,
      status: ordered.length ? "final-polished" : "needs-stronger-sources",
      critique,
      finalPolish: {
        enabled: true,
        targetDuration: Math.round(target * 10) / 10,
        trimmedSegments,
        removedSegments,
        replacementSegments,
        replacementCandidates: replacementPlan.segments?.length || 0,
        contentDuration: duration,
        mode: "auto-polish"
      }
    }
  };
}

export function fitTimelineToDuration(draft, targetDuration = 0, options = {}) {
  const target = Math.min(MAX_DURATION, Math.max(1, Number(targetDuration) || Number(draft.duration) || MAX_DURATION));
  const minSegmentDuration = Math.max(1, Number(options.minSegmentDuration) || 2.5);
  const maxSourceUses = Math.max(1, Math.round(Number(options.maxSourceUses) || 1));
  const valueFor = (segment) => {
    const role = segment.storyRole || segment.state;
    const roleBonus = ["payoff", "impact", "reaction"].includes(role) ? 14 : role === "anticipation" ? 6 : 0;
    return (Number(segment.score) || 0) + roleBonus + (segment.confidence === "high" ? 8 : segment.confidence === "low" ? -5 : 0);
  };
  const eligibleSegments = (draft.segments || [])
    .map((segment, index) => ({
      ...segment,
      originalIndex: index,
      start: Math.max(0, Number(segment.start) || 0),
      duration: Math.max(0, Number(segment.duration) || 0),
      score: Math.round(Number(segment.score) || 60)
    }))
    .filter((segment) => segment.duration >= minSegmentDuration);
  const bySource = new Map();
  for (const segment of eligibleSegments) {
    const key = String(segment.fileId || "");
    const bucket = bySource.get(key) || [];
    bucket.push(segment);
    bucket.sort((a, b) => valueFor(b) - valueFor(a));
    bySource.set(key, bucket.slice(0, maxSourceUses));
  }
  const originalSegments = [...bySource.values()].flat().sort((a, b) => a.originalIndex - b.originalIndex);
  const originalDuration = originalSegments.reduce((sum, segment) => sum + segment.duration, 0);
  if (!originalSegments.length || originalDuration <= target + 0.05) {
    const segments = originalSegments.map(({ originalIndex: _, ...segment }) => segment);
    return {
      ...draft,
      segments,
      duration: Math.round(Math.min(originalDuration, target) * 10) / 10,
      workflow: {
        ...(draft.workflow || {}),
        timelineFit: {
          targetDuration: Math.round(target * 10) / 10,
          originalDuration: Math.round(originalDuration * 10) / 10,
          removedSegments: Math.max(0, eligibleSegments.length - originalSegments.length),
          trimmedSegments: 0,
          duplicateSourcesRemoved: Math.max(0, eligibleSegments.length - originalSegments.length),
          mode: options.mode || "duration-fit"
        }
      }
    };
  }

  const ranked = [...originalSegments].sort((a, b) => {
    return valueFor(b) - valueFor(a);
  });
  const selected = [];
  const fileUses = new Map();
  let total = 0;
  let trimmedSegments = 0;
  for (const candidate of ranked) {
    const remaining = target - total;
    if (remaining < minSegmentDuration) break;
    if ((fileUses.get(candidate.fileId) || 0) >= maxSourceUses) continue;
    let duration = candidate.duration;
    if (duration > remaining) {
      if (remaining < Math.max(minSegmentDuration, Number(candidate.minDuration) || minSegmentDuration)) continue;
      duration = remaining;
      trimmedSegments += 1;
    }
    selected.push({
      ...candidate,
      duration: Math.round(duration * 100) / 100,
      minDuration: Math.round(Math.min(duration, Math.max(1, Number(candidate.minDuration) || minSegmentDuration)) * 100) / 100
    });
    fileUses.set(candidate.fileId, (fileUses.get(candidate.fileId) || 0) + 1);
    total += duration;
  }

  if (!selected.length) {
    const first = originalSegments[0];
    const duration = Math.min(first.duration, target);
    selected.push({
      ...first,
      duration: Math.round(duration * 100) / 100,
      minDuration: Math.round(Math.min(duration, Math.max(1, Number(first.minDuration) || minSegmentDuration)) * 100) / 100
    });
    trimmedSegments += first.duration > duration ? 1 : 0;
    total = duration;
  }

  const ordered = options.preserveOrder === true
    ? selected.sort((a, b) => a.originalIndex - b.originalIndex)
    : orderTrailerArc(selected);
  const segments = ordered.map(({ originalIndex: _, ...segment }) => segment);
  const duration = Math.round(segments.reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0) * 10) / 10;
  return {
    ...draft,
    segments,
    duration,
    workflow: {
      ...(draft.workflow || {}),
      selectedMoments: segments.length,
      status: draft.workflow?.status || "duration-fit",
      timelineFit: {
        targetDuration: Math.round(target * 10) / 10,
        originalDuration: Math.round(originalDuration * 10) / 10,
        removedSegments: Math.max(0, eligibleSegments.length - segments.length),
        trimmedSegments,
        duplicateSourcesRemoved: Math.max(0, eligibleSegments.length - originalSegments.length),
        mode: options.mode || "duration-fit"
      }
    }
  };
}

function orderTrailerArc(segments) {
  const phase = (segment) => {
    const role = segment.storyRole || segment.state || "other";
    if (role === "setup") return 0.08;
    if (role === "anticipation" || role === "aim") return 0.28;
    if (role === "combat" || role === "indexed") return 0.48;
    if (role === "payoff" || role === "impact") return 0.76;
    if (role === "reaction") return 0.92;
    return 0.52;
  };
  const remaining = [...segments].sort((a, b) => {
    const phaseDiff = phase(a) - phase(b);
    if (Math.abs(phaseDiff) > 0.08) return phaseDiff;
    const payoffA = ["payoff", "impact", "reaction"].includes(a.storyRole || a.state);
    const payoffB = ["payoff", "impact", "reaction"].includes(b.storyRole || b.state);
    if (payoffA || payoffB) return (a.score || 0) - (b.score || 0);
    return (b.score || 0) - (a.score || 0);
  });
  const ordered = [];
  let previous = null;
  while (remaining.length) {
    let index = 0;
    let best = -Infinity;
    remaining.forEach((candidate, candidateIndex) => {
      const base = 100 - candidateIndex;
      const variety = previous && candidate.subject === previous.subject ? -22 : 0;
      const actionVariety = previous && candidate.action === previous.action ? -18 : 0;
      const value = base + variety + actionVariety;
      if (value > best) {
        best = value;
        index = candidateIndex;
      }
    });
    previous = remaining[index];
    ordered.push(remaining.splice(index, 1)[0]);
  }
  return ordered;
}

function critiqueAgenticPlan(segments, targetDuration, options = {}) {
  const sourceIntervals = new Set();
  const subjects = new Set();
  let duplicateIntervals = 0;
  let payoffMoments = 0;
  let lowConfidenceMoments = 0;
  for (const segment of segments) {
    const interval = `${segment.fileId}:${Math.round(segment.start)}:${Math.round(segment.duration)}`;
    if (sourceIntervals.has(interval)) duplicateIntervals += 1;
    sourceIntervals.add(interval);
    subjects.add(segment.subject);
    if (["payoff", "impact", "reaction"].includes(segment.storyRole)) payoffMoments += 1;
    if (segment.confidence === "low") lowConfidenceMoments += 1;
  }
  const duration = segments.reduce((sum, segment) => sum + segment.duration, 0);
  const coverage = targetDuration ? duration / targetDuration : 1;
  const score = Math.round(clamp(
    72
    + Math.min(12, payoffMoments * 2)
    + Math.min(10, subjects.size * 2.5)
    - duplicateIntervals * 18
    - Math.max(0, lowConfidenceMoments - 2) * 2
    - (options.qualityFirst ? 0 : Math.max(0, 0.82 - coverage) * 40),
    0,
    100
  ));
  const approved = options.qualityFirst
    ? score >= 85 && duplicateIntervals === 0 && payoffMoments > 0 && lowConfidenceMoments <= 2
    : score >= 90 && duplicateIntervals === 0 && payoffMoments > 0;
  return {
    approved,
    score,
    coverage: Math.round(coverage * 100),
    duplicateIntervals,
    payoffMoments,
    lowConfidenceMoments,
    action: payoffMoments ? "Payoff moments preserved with setup and reaction context." : "No verified payoff was available.",
    boringFrames: lowConfidenceMoments <= 2 ? "Low-confidence windows are limited." : `${lowConfidenceMoments} low-confidence windows remain.`,
    story: `${payoffMoments} payoff or reaction moments form the escalation.`,
    diversity: `${subjects.size} distinct subjects represented.`
  };
}

export function recommendTrailerDuration(files, requestedDuration = 0) {
  if (Number(requestedDuration) > 0) return Math.min(MAX_DURATION, Math.max(45, Number(requestedDuration)));
  const sourceFiles = files.filter(isUsableSourceForGeneration);
  const verifiedSeconds = sourceFiles.reduce((sum, file) => {
    const confirmedSeconds = (file.metadata.confirmedHighlightMoments || []).slice(0, 3)
      .filter((moment) => !overlapsRejectedHighlight(file.metadata || {}, Number(moment.start) || 0, intervalEnd(moment)))
      .reduce((momentSum, moment) => momentSum + Math.min(18, Math.max(4, Number(moment.duration) || (Number(moment.end) - Number(moment.start)) || 0)), 0);
    const events = [...(file.metadata.semanticEvents || [])]
      .filter((event) => !overlapsRejectedHighlight(file.metadata || {}, Number(event.start) || 0, intervalEnd(event)))
      .filter((event) => !["menu", "scoreboard", "map", "loading", "death", "waiting"].includes(event.state))
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, 2);
    return sum + confirmedSeconds + events.reduce((eventSum, event) =>
      eventSum + Math.min(10, Math.max(5, Number(event.end || 0) - Number(event.start || 0) + 2)), 0);
  }, 0);
  const fallbackSeconds = sourceFiles.reduce((sum, file) =>
    sum + (file.metadata.candidateWindows || []).filter((window) => Number(window.score) >= 85).slice(0, 1)
      .filter((window) => !overlapsRejectedHighlight(file.metadata || {}, Number(window.start) || 0, intervalEnd(window)))
      .reduce((windowSum, window) => windowSum + Math.min(12, Number(window.duration) || 8), 0), 0);
  const target = verifiedSeconds || fallbackSeconds || sourceFiles.length * 7;
  return Math.min(180, MAX_DURATION, Math.max(45, Math.round(target / 5) * 5));
}

function looksLikeGeneratedExport(name = "") {
  return /(?:vision reviewed|created with highlightai|highlightai export|trailer - vision|assets\.json|^warsaw\b.*trailer)/i.test(name);
}

function isUsableSourceForGeneration(file) {
  const metadata = file?.metadata || {};
  return Boolean(file) &&
    !looksLikeGeneratedExport(file.name) &&
    Number(metadata.duration || 0) > 0 &&
    metadata.videoCodec !== "pending" &&
    metadata.aiDecision !== "rejected";
}

function createSemanticTrailerSegments(files, limit, contentLimit) {
  const events = [];
  for (const file of files) {
    for (const event of file.metadata.semanticEvents || []) {
      const traits = file.metadata.semanticTraits || {};
      const start = Math.max(0, Number(event.start) || 0);
      const end = Math.min(file.metadata.duration || 0, Number(event.end) || Number(event.start) + 3);
      if (overlapsRejectedHighlight(file.metadata || {}, start, end)) continue;
      events.push({
        file,
        start,
        end,
        score: Number(event.score) || file.metadata.semanticScore || 60,
        state: event.state || "other",
        cutRisk: event.cutRisk || "medium",
        storyRole: event.storyRole || event.payoffStage || "none",
        traits
      });
    }
  }
  events.sort((a, b) => b.score - a.score);
  const selected = [];
  const usedFiles = new Set();
  const subjectCounts = new Map();
  let total = 0;
  for (const event of events) {
    if (total >= contentLimit - 1) break;
    if (["menu", "scoreboard", "map", "loading", "death", "waiting"].includes(event.state)) continue;
    if (!["payoff", "impact", "reaction", "anticipation"].includes(event.storyRole) && event.score < 78) continue;
    const subject = event.traits.subject || "other";
    if (usedFiles.has(event.file.id)) continue;
    if ((subjectCounts.get(subject) || 0) >= 4) continue;
    const progress = total / contentLimit;
    const desired = storyWindowDuration(event, progress);
    const eventDuration = Math.max(1.5, event.end - event.start);
    const contextBefore = ["payoff", "impact"].includes(event.storyRole) ? 2.5 : 1;
    const contextAfter = ["payoff", "impact", "reaction"].includes(event.storyRole) ? 2.5 : 1;
    const start = Math.max(0, event.start - contextBefore);
    const available = Math.max(0, event.file.metadata.duration - start);
    const completeEventDuration = Math.max(eventDuration + contextBefore + contextAfter, desired);
    const duration = Math.min(Math.min(16, completeEventDuration), contentLimit - total, available);
    if (duration < 4) continue;
    selected.push({
      fileId: event.file.id,
      start: Math.max(0, Math.min(event.file.metadata.duration - duration, start)),
      duration,
      score: Math.round(event.score)
    });
    usedFiles.add(event.file.id);
    subjectCounts.set(subject, (subjectCounts.get(subject) || 0) + 1);
    total += duration;
  }
  return { segments: selected, duration: Math.round(Math.min(total, contentLimit) * 10) / 10 };
}

function createIndexedTrailerSegments(files, contentLimit, initialTotal = 0) {
  const windows = [];
  for (const file of files) {
    for (const window of file.metadata.candidateWindows || []) {
      const start = Math.max(0, Number(window.start) || 0);
      const duration = Math.max(4, Number(window.duration) || ((Number(window.end) || 0) - (Number(window.start) || 0)) || 8);
      if (overlapsRejectedHighlight(file.metadata || {}, start, start + duration)) continue;
      windows.push({
        file,
        start,
        duration,
        score: Number(window.score) || 50,
        storyRole: window.storyRole || "setup",
        cutRisk: window.cutRisk || "medium"
      });
    }
  }
  windows.sort((a, b) => b.score - a.score);
  const selected = [];
  const usedFiles = new Set();
  let total = initialTotal;
  for (const window of windows) {
    if (total >= contentLimit - 1) break;
    if (usedFiles.has(window.file.id) && usedFiles.size < files.length) continue;
    const progress = total / contentLimit;
    const desired = storyWindowDuration(window, progress);
    const duration = Math.min(Math.max(desired, window.duration), contentLimit - total, window.file.metadata.duration - window.start);
    if (duration < 4) continue;
    selected.push({
      fileId: window.file.id,
      start: Math.max(0, Math.min(window.file.metadata.duration - duration, window.start)),
      duration: Math.round(duration * 10) / 10,
      score: Math.round(window.score)
    });
    usedFiles.add(window.file.id);
    total += duration;
  }
  return { segments: selected, duration: Math.round(Math.min(total, contentLimit) * 10) / 10 };
}

function storyWindowDuration(event, progress) {
  if (event.cutRisk === "high") return 14;
  if (event.storyRole === "payoff" || event.storyRole === "impact") return progress < 0.84 ? 12 : 8;
  if (event.storyRole === "anticipation" || event.storyRole === "setup") return progress < 0.58 ? 10 : 7;
  if (event.storyRole === "reaction") return 8;
  return progress < 0.18 ? 10 : progress < 0.58 ? 8 : 6;
}

function sequenceTrailerShots(files) {
  const remaining = [...files].sort((a, b) =>
    ((b.metadata.visionScore || 0) + (b.metadata.actionScore || 0) * 0.1) -
    ((a.metadata.visionScore || 0) + (a.metadata.actionScore || 0) * 0.1)
  );
  const ordered = [];
  let previous = null;
  while (remaining.length) {
    const progress = ordered.length / Math.max(1, files.length - 1);
    let index = 0;
    let best = -Infinity;
    remaining.forEach((file, candidateIndex) => {
      const traits = file.metadata.visionTraits || {};
      const intensityFit = 100 - Math.abs((traits.intensity || 60) - (35 + progress * 65));
      const clarity = traits.clarity || file.metadata.visionScore || 50;
      const spectacle = traits.spectacle || 50;
      const novelty = previous
        ? (traits.subject !== previous.subject ? 20 : 0) + (traits.shotScale !== previous.shotScale ? 14 : 0) + (traits.environment !== previous.environment ? 8 : 0)
        : 20;
      const openingBoost = progress < 0.2 ? (traits.shotScale === "wide" ? 20 : 0) : 0;
      const climaxBoost = progress > 0.7 ? spectacle * 0.25 : 0;
      const score = intensityFit * 0.35 + clarity * 0.25 + spectacle * 0.2 + novelty + openingBoost + climaxBoost;
      if (score > best) { best = score; index = candidateIndex; }
    });
    previous = remaining[index].metadata.visionTraits || null;
    ordered.push(remaining.splice(index, 1)[0]);
  }
  return ordered;
}

export async function alignTrailerSegmentsToMusic(draft, musicPath) {
  if (draft.style !== "Trailer" || !musicPath) return draft;
  const musicDuration = (await probe(musicPath)).duration;
  if (musicDuration > MAX_DURATION + 0.1) {
    throw new Error(`Soundtrack exceeds the ${MAX_DURATION}-second video limit and cannot be preserved without trimming.`);
  }
  const repeats = Math.max(1, Math.min(2, Math.round(Number(draft.musicRepeats) || 1)));
  const availableMusic = Math.max(1, Math.min(MAX_DURATION, musicDuration * repeats));
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-i", musicPath,
    "-af", "asetnsamples=n=22050,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
    "-f", "null", "-"
  ]);
  const frames = [...stderr.matchAll(/pts_time:([\d.]+)[\s\S]*?lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/g)]
    .map((match) => ({ time: Number(match[1]), level: Number(match[2]) }))
    .filter((frame) => Number.isFinite(frame.level));
  const firstPassPeaks = frames.filter((frame, index) =>
    index > 0 && index < frames.length - 1 &&
    frame.level >= frames[index - 1].level && frame.level >= frames[index + 1].level
  );
  const sourcePeaks = firstPassPeaks.filter((peak) => peak.time <= musicDuration);
  const peaks = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const peak of sourcePeaks) {
      const time = peak.time + repeat * musicDuration;
      if (time <= availableMusic) peaks.push({ ...peak, time });
    }
  }
  const chooseBeat = (elapsed, naturalEnd, minDuration, maxDuration) => {
    const earliest = elapsed + minDuration;
    const latest = elapsed + maxDuration;
    const candidates = peaks
      .filter((peak) => peak.time >= earliest && peak.time <= latest)
      .map((peak) => ({
        ...peak,
        value: -Math.abs(peak.time - naturalEnd) * 4 + Math.max(0, peak.level + 36) * 0.16
      }))
      .sort((a, b) => b.value - a.value);
    const close = candidates.find((peak) => Math.abs(peak.time - naturalEnd) <= 1.25);
    return close?.time ?? candidates[0]?.time ?? naturalEnd;
  };
  let elapsed = 0;
  const maxContentDuration = Math.min(availableMusic, Math.max(1, Number(draft.duration) || availableMusic));
  const segments = [];
  for (const segment of draft.segments) {
    const remaining = maxContentDuration - elapsed;
    if (remaining <= 0.2) break;
    const protectedDuration = Math.min(remaining, Math.max(1, Number(segment.minDuration) || 0));
    const maxSegment = draft.style === "Trailer" ? 18 : 5.8;
    const minSegment = draft.style === "Trailer" ? Math.min(remaining, Math.max(4, protectedDuration)) : Math.min(remaining, Math.max(1.4, protectedDuration));
    const naturalDuration = Math.min(remaining, Math.max(minSegment, Math.min(maxSegment, Number(segment.duration) || minSegment)));
    const target = elapsed + naturalDuration;
    const beat = chooseBeat(elapsed, target, minSegment, Math.min(remaining, maxSegment));
    const duration = Math.min(remaining, Math.max(minSegment, Math.min(maxSegment, beat - elapsed)));
    elapsed += duration;
    segments.push({ ...segment, duration: Math.round(duration * 100) / 100 });
  }
  const contentDuration = Math.round(elapsed * 10) / 10;
  const maximumOutro = maxLogoOutroDuration(availableMusic);
  const timelineDuration = Math.round(Math.min(availableMusic, contentDuration + maximumOutro) * 10) / 10;
  const outroDuration = Math.max(0, Math.round((timelineDuration - contentDuration) * 10) / 10);
  return {
    ...draft,
    segments,
    duration: timelineDuration,
    contentDuration,
    outroDuration,
    musicDuration: Math.round(musicDuration * 10) / 10,
    musicRepeats: repeats,
    musicPlan: {
      sourceDuration: Math.round(musicDuration * 10) / 10,
      contentDuration,
      timelineDuration,
      outroDuration,
      repeats,
      ending: outroDuration > 0.2 ? "full-track ending with game logo" : "full-track ending",
      syncPoints: peaks.length
    }
  };
}

export async function renderHighlight({ project, draft, outputPath, workRoot, musicPath, signal, onProgress }) {
  const tempDir = path.join(workRoot || path.dirname(outputPath), `render-${Date.now()}-${process.pid}`);
  await mkdir(tempDir, { recursive: true });
  const segmentFiles = new Array(draft.segments.length);
  const style = styleFilters(draft.style, draft.format);
  let completed = 0;
  try {
    await runWithConcurrency(draft.segments.map((segment, i) => async () => {
      if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
      const source = project.files.find((file) => file.id === segment.fileId);
      if (!source) return;
      const output = path.join(tempDir, `segment-${String(i).padStart(3, "0")}.mp4`);
      const args = ["-y", "-ss", String(segment.start), "-t", String(segment.duration), "-i", source.path];
      if (!source.metadata.hasAudio) args.push("-f", "lavfi", "-t", String(segment.duration), "-i", "anullsrc=r=48000:cl=stereo");
      const highQuality = draft.style === "Trailer";
      args.push(
        "-vf", style.video,
        ...(source.metadata.hasAudio ? ["-af", style.audio] : ["-map", "0:v", "-map", "1:a", "-shortest"]),
        "-r", "30", "-c:v", "libx264", "-preset", highQuality ? "medium" : "veryfast", "-crf", highQuality ? "17" : "21",
        "-c:a", "aac", "-b:a", highQuality ? "256k" : "192k", "-ar", "48000", "-ac", "2",
        output
      );
      await run("ffmpeg", args, { signal });
      segmentFiles[i] = output;
      completed += 1;
      await onProgress?.({ completed, total: draft.segments.length, phase: "segments" });
    }), Math.min(3, Math.max(1, draft.segments.length)));

    const orderedFiles = segmentFiles.filter(Boolean);
    if (!orderedFiles.length) throw new Error("No usable video segments were produced.");
    const concatPath = path.join(tempDir, "concat.txt");
    await writeFile(concatPath, orderedFiles.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
    const joinedPath = path.join(tempDir, "joined.mp4");
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", joinedPath], { signal });
    let visualPath = joinedPath;
    if (musicPath && Number(draft.outroDuration || 0) > 0.2) {
      const outroPath = path.join(tempDir, "game-logo-outro.mp4");
      await renderGameLogoOutro(outroPath, joinedPath, project, Number(draft.outroDuration), signal);
      const fullConcatPath = path.join(tempDir, "full-concat.txt");
      await writeFile(fullConcatPath, [joinedPath, outroPath].map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
      visualPath = path.join(tempDir, "joined-with-logo.mp4");
      await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", fullConcatPath, "-c", "copy", visualPath], { signal });
    }
    await onProgress?.({ completed, total: draft.segments.length, phase: "mixing" });

    if (musicPath) {
      const trailer = draft.style === "Trailer";
      const musicVolume = trailer ? 1 : 0.16;
      const gameVolume = trailer ? 0.12 : 1;
      const repeats = Math.max(1, Math.min(2, Math.round(Number(draft.musicRepeats) || 1)));
      const visualDuration = Number((await probe(visualPath, signal)).duration) || Number(draft.duration) || MAX_DURATION;
      const sourceMusicDuration = Number(draft.musicDuration) || Number((await probe(musicPath, signal)).duration) || visualDuration;
      const availableMusicDuration = Math.max(0.1, Math.min(MAX_DURATION, sourceMusicDuration * repeats));
      const mixDuration = Math.round(Math.min(MAX_DURATION, visualDuration, Number(draft.duration) || visualDuration, availableMusicDuration) * 100) / 100;
      draft.duration = mixDuration;
      const fadeDuration = Math.round(Math.min(1.8, Math.max(0.25, mixDuration * 0.12)) * 100) / 100;
      const fadeStart = Math.round(Math.max(0, mixDuration - fadeDuration) * 100) / 100;
      const baseArgs = [
        "-y", "-i", visualPath, ...(repeats > 1 ? ["-stream_loop", String(repeats - 1)] : []), "-i", musicPath,
        "-filter_complex", trailer
          ? `[1:a]atrim=duration=${mixDuration},loudnorm=I=-11:TP=-1:LRA=7,afade=t=out:st=${fadeStart}:d=${fadeDuration},volume=${musicVolume}[music];[0:a]volume=${gameVolume},highpass=f=90,acompressor=threshold=-24dB:ratio=6:attack=8:release=150[game];[music][game]amix=inputs=2:duration=first:dropout_transition=1:weights='1 0.08':normalize=0,alimiter=limit=0.95,volume=-1.2dB[a]`
          : `[0:a]volume=${gameVolume}[a0];[1:a]atrim=duration=${mixDuration},afade=t=out:st=${fadeStart}:d=${fadeDuration},volume=${musicVolume}[a1];[a0][a1]amix=inputs=2:duration=first[a]`,
        "-map", "0:v", "-map", "[a]", "-c:a", "aac", "-b:a", trailer ? "224k" : "192k",
        "-t", String(mixDuration)
      ];
      await onProgress?.({ completed, total: draft.segments.length, phase: "compressing" });
      draft.encoding = await encodeFinalVideo(baseArgs, outputPath, signal);
    } else {
      await onProgress?.({ completed, total: draft.segments.length, phase: "compressing" });
      draft.encoding = await encodeFinalVideo([
        "-y", "-i", visualPath,
        "-map", "0:v", "-map", "0:a?",
        "-c:a", "aac", "-b:a", "192k",
        "-t", String(Math.min(MAX_DURATION, draft.duration))
      ], outputPath, signal);
    }
    return outputPath;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function renderGameLogoOutro(outputPath, joinedPath, project, duration, signal) {
  const media = await probe(joinedPath, signal);
  const width = Math.max(2, Number(media.width) || 1920);
  const height = Math.max(2, Number(media.height) || 1080);
  const backgroundPath = path.join(path.dirname(outputPath), "game-logo-background.jpg");
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-sseof", "-0.25", "-i", joinedPath,
    "-frames:v", "1", "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`, backgroundPath
  ], { signal });

  const logoAsset = (project.assets || []).find((asset) =>
    /\.(png|jpe?g|webp|bmp)$/i.test(asset.path || asset.name || "") &&
    /(logo|cover|icon|keyart|key-art|artwork)/i.test(asset.name || path.basename(asset.path || ""))
  );
  const frames = Math.max(1, Math.ceil(duration * 30));
  const fadeOutStart = Math.max(0, duration - Math.min(1.2, duration * 0.25));
  const background = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=22,eq=brightness=-0.22:saturation=0.72,zoompan=z='min(zoom+0.00035,1.08)':d=${frames}:s=${width}x${height}:fps=30,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.24:t=fill[bg]`;
  let args;
  if (logoAsset?.path) {
    const logoWidth = Math.round(width * 0.46);
    const logoHeight = Math.round(height * 0.46);
    const filter = [
      background,
      `[1:v]scale=${logoWidth}:${logoHeight}:force_original_aspect_ratio=decrease,format=rgba,fade=t=in:st=0:d=0.7:alpha=1,fade=t=out:st=${fadeOutStart}:d=${Math.max(0.2, duration - fadeOutStart)}:alpha=1[logo]`,
      `[bg][logo]overlay=(W-w)/2:(H-h)/2,fade=t=out:st=${fadeOutStart}:d=${Math.max(0.2, duration - fadeOutStart)}[v]`
    ].join(";");
    args = [
      "-y", "-loop", "1", "-i", backgroundPath, "-loop", "1", "-i", logoAsset.path,
      "-f", "lavfi", "-t", String(duration), "-i", "anullsrc=r=48000:cl=stereo",
      "-filter_complex", filter, "-map", "[v]", "-map", "2:a", "-t", String(duration)
    ];
  } else {
    const font = process.platform === "win32" ? "C\\:/Windows/Fonts/arialbd.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    const title = escapeDrawText(project.name || "GAME HIGHLIGHT");
    const subtitle = escapeDrawText("HIGHLIGHT REEL");
    const foreground = [
      `[bg]drawtext=fontfile='${font}':text='${title}':fontcolor=white:fontsize=${Math.max(48, Math.round(width * 0.055))}:x=(w-text_w)/2:y=(h-text_h)/2-24:shadowcolor=black@0.8:shadowx=4:shadowy=4`,
      `drawtext=fontfile='${font}':text='${subtitle}':fontcolor=0xb9ff66:fontsize=${Math.max(18, Math.round(width * 0.015))}:x=(w-text_w)/2:y=(h-text_h)/2+72:shadowcolor=black@0.8:shadowx=2:shadowy=2`,
      `fade=t=in:st=0:d=0.7,fade=t=out:st=${fadeOutStart}:d=${Math.max(0.2, duration - fadeOutStart)}[v]`
    ].join(",");
    const filter = `${background};${foreground}`;
    args = [
      "-y", "-loop", "1", "-i", backgroundPath,
      "-f", "lavfi", "-t", String(duration), "-i", "anullsrc=r=48000:cl=stereo",
      "-filter_complex", filter, "-map", "[v]", "-map", "1:a", "-t", String(duration)
    ];
  }
  args.push(
    "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2", outputPath
  );
  try {
    await run("ffmpeg", args, { signal });
  } finally {
    await rm(backgroundPath, { force: true }).catch(() => undefined);
  }
}

function escapeDrawText(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll("%", "\\%");
}

async function encodeFinalVideo(baseArgs, outputPath, signal) {
  const common = [
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-tag:v", "hvc1"
  ];
  const profiles = [
    {
      name: "NVIDIA HEVC",
      codec: "hevc",
      args: ["-c:v", "hevc_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "24", "-b:v", "0", "-maxrate", "12M", "-bufsize", "24M"]
    },
    {
      name: "Software HEVC",
      codec: "hevc",
      args: ["-c:v", "libx265", "-preset", "medium", "-crf", "23", "-x265-params", "log-level=error"]
    }
  ];
  let lastError;
  for (const profile of profiles) {
    try {
      await run("ffmpeg", [...baseArgs, ...profile.args, ...common, outputPath], { signal });
      const result = await probe(outputPath, signal);
      return {
        codec: profile.codec,
        encoder: profile.name,
        width: result.width,
        height: result.height,
        bitrate: result.bitrate,
        size: result.size,
        qualityMode: profile.name === "NVIDIA HEVC" ? "CQ 24" : "CRF 23"
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      await rm(outputPath, { force: true }).catch(() => undefined);
    }
  }
  throw lastError || new Error("No HEVC encoder could create the final MP4.");
}

async function runWithConcurrency(tasks, concurrency) {
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      await task();
    }
  });
  await Promise.all(workers);
}

async function renderTitleCard(outputPath, title, subtitle, duration) {
  const font = process.platform === "win32" ? "C\\:/Windows/Fonts/arialbd.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const filter = [
    `drawtext=fontfile='${font}':text='${title}':fontcolor=white:fontsize=92:x=(w-text_w)/2:y=(h-text_h)/2-38`,
    `drawtext=fontfile='${font}':text='${subtitle}':fontcolor=0xffb347:fontsize=24:x=(w-text_w)/2:y=(h-text_h)/2+72`,
    `fade=t=in:st=0:d=0.7`,
    `fade=t=out:st=${Math.max(0, duration - 0.8)}:d=0.8`,
    "format=yuv420p"
  ].join(",");
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `color=c=0x05070a:s=2560x1440:r=30:d=${duration}`,
    "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${duration}`,
    "-vf", filter, "-map", "0:v", "-map", "1:a", "-shortest",
    "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-c:a", "aac", "-b:a", "320k", outputPath
  ]);
}

function styleFilters(style, format) {
  const scale = format === "Vertical"
    ? "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
    : "scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black";
  const look = style === "Trailer"
    ? "hqdn3d=1.2:1.2:3:3,eq=contrast=1.08:saturation=1.02:brightness=-0.008,colorbalance=bs=.012:rs=.01,vignette=PI/7,unsharp=5:5:0.18"
    : style === "Cinematic"
    ? "eq=contrast=1.12:saturation=0.88:brightness=-0.025,vignette=PI/5"
    : style === "Comedy"
      ? "eq=contrast=1.04:saturation=1.18:brightness=0.02"
      : "eq=contrast=1.15:saturation=1.12,unsharp=5:5:0.35";
  return {
    video: `${scale},${look},fps=30,format=yuv420p`,
    audio: style === "Trailer" ? "volume=0.35,acompressor=threshold=-16dB:ratio=3:attack=12:release=180" : "loudnorm=I=-14:TP=-1.5:LRA=11,acompressor=threshold=-18dB:ratio=3:attack=20:release=250"
  };
}

const jsonWriteQueues = new Map();

const transientReplaceErrors = new Set(["EACCES", "EBUSY", "EPERM"]);

async function writeJsonAtomically(filePath, serialized) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(tempPath, serialized);
    let lastError;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      try {
        await rename(tempPath, filePath);
        return;
      } catch (error) {
        lastError = error;
        if (!transientReplaceErrors.has(error?.code) || attempt === 6) break;
        await new Promise((resolve) => setTimeout(resolve, 20 * (2 ** attempt)));
      }
    }
    if (process.platform !== "win32" || !transientReplaceErrors.has(lastError?.code)) throw lastError;
    // Windows scanners can briefly lock an existing JSON file. Copying over it
    // is the last-resort durable replacement after bounded atomic retries.
    await copyFile(tempPath, filePath);
  } catch (error) {
    throw error;
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export function saveJson(filePath, data) {
  const serialized = JSON.stringify(data, null, 2);
  const previous = jsonWriteQueues.get(filePath) || Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => writeJsonAtomically(filePath, serialized));
  jsonWriteQueues.set(filePath, operation);
  operation.finally(() => {
    if (jsonWriteQueues.get(filePath) === operation) jsonWriteQueues.delete(filePath);
  }).catch(() => undefined);
  return operation;
}

export async function loadJson(filePath) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      lastError = error;
      if (!(error instanceof SyntaxError) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  throw lastError;
}
