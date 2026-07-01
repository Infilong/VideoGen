import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  Download,
  ExternalLink,
  FolderSearch,
  Gauge,
  Grid2X2,
  HardDrive,
  ImagePlus,
  Layers3,
  List,
  LoaderCircle,
  MessageCircle,
  Moon,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Upload,
  Video,
  WandSparkles,
  X
} from "lucide-react";
import { clampDuration, curatedIdeas, formatBytes, formatTime, toAsset } from "./services/analyzer";
import { addAssets, cancelRenderJob, checkAiModel, confirmHighlightMoment, deleteProject, estimateFastIndex, estimatePreprocess, findPublicAudio, generateDraft, getDiagnostics, getFastIndexJob, getProject, importPublicAudio, ingestFiles, ingestLocalFolder, issueFromError, listProjects, localMediaUrl, markHighlightReviewed, pauseFastIndexJob, pauseIngestJob, pausePreprocessJob, pauseRenderJob, reconcileProject, rejectHighlightMoment, removeHighlightConfirmation, renderDraft, requestAdvancedAdvice, requestVisionReview, resumeFastIndexJob, resumeIngestJob, resumePreprocessJob, resumeRenderJob, reviewDraft, runFastIndex, runPreprocess, updateDraft } from "./services/api";
import type { AiModelStatus, Analysis, Diagnostics, Draft, FastIndexEstimate, FastIndexJob, IngestProgress, MediaAsset, OperationIssue, PreprocessEstimate, PreprocessJob, Project, PublicAudio, RenderJob, Segment, Stage, VideoIdea } from "./types";

const suggestions = [
  "Make it more cinematic",
  "Use only the best kills",
  "Create a fast vertical short"
];

type AiConfig = { endpoint: string; apiKey: string; model: string };
type VisionReviewMode = "light" | "balanced" | "thorough";
type AiResourceLimits = { maxVisionWorkers: number; maxFramesPerVideo: number; maxVideosPerRun: number };
type PauseTask = "ingest" | "fast-index" | "vision" | "render";
type HighlightReviewItem = {
  id: string;
  file: MediaAsset;
  start: number;
  end: number;
  duration: number;
  score: number;
  state?: string;
  action?: string;
  storyRole?: string;
  source: string;
  label: string;
  confidence: "high" | "medium" | "low";
  confirmed: boolean;
  reviewed?: boolean;
};
type HighlightReviewSession = {
  items: HighlightReviewItem[];
  index: number;
  total: number;
  reviewed: number;
  confirmed: number;
};
type ConfirmedHighlightMoment = {
  start: number;
  end: number;
  duration?: number;
  score?: number;
  state?: string;
  action?: string;
  storyRole?: string;
  source?: string;
};
type HighlightSidebarPart = {
  id: string;
  file: MediaAsset;
  start: number;
  end: number;
  action?: string;
  source?: string;
  status: "pending" | "confirmed";
  confidence?: "high" | "medium" | "low";
  item?: HighlightReviewItem;
  moment?: ConfirmedHighlightMoment;
};
type ReviewMusicCoveragePrompt = {
  clipDuration: number;
  musicDuration: number;
  musicName: string;
  clipCount: number;
};
type HighlightDiscard = { fileId: string; start: number; end: number; duration: number; source: string; reason: "skip-this-time" };
const semanticReviewVersion = 2;
const maxSemanticReviewAttempts = 2;
const defaultTextAi: AiConfig = { endpoint: "https://api.openai.com/v1/chat/completions", apiKey: "", model: "gpt-4.1-mini" };
const defaultVisionAi: AiConfig = { endpoint: "http://127.0.0.1:11434/v1/chat/completions", apiKey: "", model: "qwen2.5vl:7b" };
const defaultAiResourceLimits: AiResourceLimits = { maxVisionWorkers: 2, maxFramesPerVideo: 10, maxVideosPerRun: 0 };

function isLocalAiEndpoint(endpoint = "") {
  return /(?:localhost|127\.0\.0\.1)/i.test(endpoint);
}

function defaultVisionReviewMode(config: AiConfig): VisionReviewMode {
  return isLocalAiEndpoint(config.endpoint) ? "light" : "balanced";
}

function visionReviewProfile(mode: VisionReviewMode) {
  if (mode === "thorough") return { batchSize: 20, framesPerClip: 10, sampleInterval: 5, concurrency: 2 };
  if (mode === "balanced") return { batchSize: 12, framesPerClip: 8, sampleInterval: 6, concurrency: 2 };
  return { batchSize: 12, framesPerClip: 10, sampleInterval: 8, concurrency: 1 };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function normalizeAiResourceLimits(value: Partial<AiResourceLimits> = {}): AiResourceLimits {
  return {
    maxVisionWorkers: clampInteger(value.maxVisionWorkers, 1, 6, defaultAiResourceLimits.maxVisionWorkers),
    maxFramesPerVideo: clampInteger(value.maxFramesPerVideo, 3, 18, defaultAiResourceLimits.maxFramesPerVideo),
    maxVideosPerRun: clampInteger(value.maxVideosPerRun, 0, 200, defaultAiResourceLimits.maxVideosPerRun)
  };
}

function loadAiResourceLimits() {
  try {
    return normalizeAiResourceLimits(JSON.parse(localStorage.getItem("highlight-ai-resource-limits") || "{}"));
  } catch {
    return defaultAiResourceLimits;
  }
}

function resourceLimitedVisionProfile(mode: VisionReviewMode, limits: AiResourceLimits) {
  const profile = visionReviewProfile(mode);
  return {
    ...profile,
    concurrency: Math.min(profile.concurrency, limits.maxVisionWorkers),
    framesPerClip: Math.min(profile.framesPerClip, limits.maxFramesPerVideo)
  };
}

function isLocalOllamaVisionEndpoint(endpoint = "") {
  try {
    const url = new URL(endpoint);
    return ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "11434";
  } catch {
    return false;
  }
}

function effectiveVisionProfile(mode: VisionReviewMode, limits: AiResourceLimits, endpoint: string) {
  const profile = resourceLimitedVisionProfile(mode, limits);
  return {
    ...profile,
    concurrency: isLocalOllamaVisionEndpoint(endpoint) ? 1 : profile.concurrency
  };
}

function limitVisionQueue<T>(files: T[], limits: AiResourceLimits): T[] {
  return limits.maxVideosPerRun > 0 ? files.slice(0, limits.maxVideosPerRun) : files;
}

function normalizedFastIndexCounts(job?: { status?: string; processedFiles?: number; totalFiles?: number } | null) {
  const rawProcessed = Math.max(0, Number(job?.processedFiles || 0));
  const rawTotal = Math.max(0, Number(job?.totalFiles || 0));
  const completed = ["completed", "completed_with_warnings"].includes(String(job?.status || ""));
  const total = completed ? Math.max(rawTotal, rawProcessed) : rawTotal || rawProcessed;
  const processed = completed
    ? total
    : Math.min(total || rawProcessed, rawProcessed);
  return { processed, total };
}

function loadAiConfig(key: string, fallback: AiConfig, legacy = false) {
  try {
    const saved = localStorage.getItem(key) || (legacy ? localStorage.getItem("highlight-ai-provider") : "");
    return saved ? { ...fallback, ...JSON.parse(saved) } as AiConfig : fallback;
  } catch {
    return fallback;
  }
}

function usefulTags(file: MediaAsset) {
  const tags = new Set<string>();
  const ignored = new Set(["unknown", "none", "gameplay", "gameplay highlight", "action", "combat", "payoff", "setup", "spectacle", "environment", "exploration", "other"]);
  for (const tag of [...(file.metadata?.semanticTags || []), ...(file.metadata?.indexTags || [])]) {
    if (!ignored.has(tag.toLowerCase())) tags.add(tag);
  }
  const traits = file.metadata?.semanticTraits;
  if (traits?.subject && !ignored.has(traits.subject.toLowerCase())) tags.add(traits.subject);
  if (traits?.action && !ignored.has(traits.action.toLowerCase())) tags.add(traits.action);
  for (const event of file.metadata?.semanticEvents || []) {
    if (event.action && !ignored.has(event.action.toLowerCase())) tags.add(event.action);
  }
  for (const event of file.metadata?.semanticCandidateHistory || []) {
    if (event.action && !ignored.has(event.action.toLowerCase())) tags.add(event.action);
  }
  return [...tags].slice(0, 6);
}

function metadataIntervalEnd(item: { start?: number; end?: number; duration?: number }) {
  const start = Number(item?.start) || 0;
  return Number(item?.end) || start + (Number(item?.duration) || 0);
}

function overlapsRejectedMoment(metadata: MediaAsset["metadata"], start = 0, end = start) {
  return (metadata?.rejectedHighlightMoments || []).some((item) =>
    item.reason === "not-highlight" &&
    Math.max(Number(item.start) || 0, start) < Math.min(metadataIntervalEnd(item), end) - 0.75
  );
}

function hasStrongSemanticSummary(metadata: MediaAsset["metadata"]) {
  if (!metadata) return false;
  if (hasBoringSemanticEvidence({ metadata } as MediaAsset)) return false;
  const rating = metadata.semanticRating || null;
  const traits = metadata.semanticTraits || null;
  if (!rating || !traits) return false;
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

function hasFinalSemanticReview(file: MediaAsset) {
  const metadata = file.metadata;
  if (!metadata || metadata.semanticReviewLastError) return false;
  const attemptVersion = Number(metadata.semanticReviewAttemptVersion || 0);
  const attempts = attemptVersion === semanticReviewVersion ? Number(metadata.semanticReviewAttempts || 0) : 0;
  return metadata.semanticFineReviewed === true || attempts >= maxSemanticReviewAttempts;
}

function hasBoringSemanticEvidence(file: MediaAsset) {
  const metadata = file.metadata;
  if (!metadata || !hasFinalSemanticReview(file)) return false;
  if ((metadata.confirmedHighlightMoments || []).length > 0) return false;
  const rating = metadata.semanticRating || null;
  const reject = String(rating?.excludeReason || metadata.semanticRejectReason || "").toLowerCase();
  const hardRejects = new Set(["menu", "scoreboard", "map", "loading", "death", "unreadable", "duplicate"]);
  if (reject.split(/[^a-z_]+/).some((part) => hardRejects.has(part))) return true;
  const reason = String(metadata.semanticRejectReason || "").toLowerCase();
  if (/\b(menu|scoreboard|loading screen|map screen|death screen|unreadable|duplicate)\b/i.test(reason)) return true;
  return false;
}

function hasRecoverableGameplaySignal(file: MediaAsset) {
  const metadata = file.metadata;
  if (!metadata?.duration || metadata.videoCodec === "pending") return false;
  if (hasBoringSemanticEvidence(file)) return false;
  return Number(metadata.indexScore || 0) >= 30 || Number(metadata.actionScore || 0) >= 20;
}

function hasAutoUsableHighlightCandidate(file: MediaAsset) {
  const metadata = file.metadata;
  if (!metadata) return false;
  if (metadata.aiDecision === "rejected" || hasBoringSemanticEvidence(file)) return false;
  if (metadata.aiDecision === "confirmed") return true;
  if ((metadata.confirmedHighlightMoments || []).length > 0) return true;
  if ((metadata.semanticCandidateHistory || []).some((event) => Number(event.score || 0) >= 64 && !overlapsRejectedMoment(metadata, Number(event.start) || 0, metadataIntervalEnd(event)))) return true;
  if ((metadata.candidateWindows || []).some((window) => Number(window.score || 0) >= 72 && !overlapsRejectedMoment(metadata, Number(window.start) || 0, metadataIntervalEnd(window)))) return true;
  return hasStrongSemanticSummary(metadata) || hasRecoverableGameplaySignal(file);
}

function semanticState(file: MediaAsset) {
  const metadata = file.metadata;
  if (!metadata?.duration || metadata.videoCodec === "pending") return "pending";
  if (metadata.aiDecision === "rejected" || hasBoringSemanticEvidence(file)) return "rejected";
  if (metadata.aiDecision === "confirmed") return "verified";
  const reviewedFrames = Number(metadata.semanticFramesReviewed || 0);
  const attempts = semanticReviewAttempts(file);
  const verifiedEvents = (metadata.semanticEvents || []).filter((event) => event.payoffVerified === true).length;
  const strongVisionScore = metadata.visionApproved === true && Number(metadata.visionScore || 0) >= 70;
  const strongSemanticScore = Number(metadata.semanticScore || 0) >= 70 &&
    (metadata.ratingSource === "vision-ai" || metadata.ratingConfidence === "high");
  const strongSummaryPayoff = metadata.semanticTraits?.payoffVerified === true &&
    Number(metadata.semanticScore || 0) >= 70 &&
    Number(metadata.semanticRating?.trailerUsefulness || 0) >= 70 &&
    String(metadata.semanticRating?.excludeReason || "none").toLowerCase() === "none";
  if (verifiedEvents > 0 || metadata.semanticQuality === "verified" || strongVisionScore || strongSemanticScore || strongSummaryPayoff) return "verified";
  if (metadata.semanticReviewLastError && reviewedFrames && Number(metadata.semanticReviewVersion || 0) >= semanticReviewVersion && metadata.semanticFineReviewed !== true) return "reviewed";
  if (Number(metadata.semanticReviewVersion || 0) >= semanticReviewVersion && metadata.semanticFineReviewed === true) return "uncertain";
  if (Number(metadata.semanticReviewVersion || 0) >= semanticReviewVersion && attempts >= maxSemanticReviewAttempts) return "uncertain";
  if (reviewedFrames && Number(metadata.semanticReviewVersion || 0) >= semanticReviewVersion) return "reviewed";
  return "needs_check";
}

function potentialMomentRanges(file: MediaAsset) {
  const rejected = file.metadata?.rejectedHighlightMoments || [];
  const overlapsRejected = (item: { start?: number; end?: number; duration?: number }) => rejected.some((rejection) => {
    const start = Number(item.start) || 0;
    const end = Number(item.end) || start + (Number(item.duration) || 0);
    return rejection.reason === "not-highlight" &&
      Math.max(Number(rejection.start) || 0, start) < Math.min(Number(rejection.end) || Number(rejection.start) + Number(rejection.duration), end) - 0.75;
  });
  const ranges = [
    ...(file.metadata?.semanticEvents || []),
    ...(file.metadata?.semanticCandidateHistory || []),
    ...(file.metadata?.candidateWindows || [])
  ]
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start && !overlapsRejected(item))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const unique: Array<{ start: number; end: number }> = [];
  for (const item of ranges) {
    const candidate = { start: Number(item.start), end: Number(item.end) };
    if (unique.some((existing) => intervalsOverlapMeaningfully(existing, candidate))) continue;
    unique.push(candidate);
    if (unique.length >= 3) break;
  }
  return unique.map((item) => `${formatTime(item.start)}-${formatTime(item.end)}`);
}

function potentialMomentSummary(file: MediaAsset) {
  const ranges = potentialMomentRanges(file);
  if (ranges.length) return `Potential moments: ${ranges.join(", ")}.`;
  const bestTime = reliableFocusTime(file);
  if (Number.isFinite(bestTime)) return `Potential highlight near ${formatTime(bestTime || 0)}.`;
  return "";
}

function reliableFocusTime(file: MediaAsset) {
  const metadata = (file.metadata || {}) as NonNullable<MediaAsset["metadata"]>;
  const semanticEvents = [...(metadata.semanticEvents || []), ...(metadata.semanticCandidateHistory || [])];
  const weakVisionMiss = Number(metadata.semanticFramesReviewed || 0) > 0 &&
    !semanticEvents.length &&
    (metadata.ratingConfidence === "low" || metadata.semanticQuality === "missed" || Number(metadata.semanticScore || 0) < 25);
  if (weakVisionMiss && Number.isFinite(Number(metadata.highlightStart))) return Number(metadata.highlightStart);
  return Number(metadata.semanticTopFrame ?? metadata.highlightStart ?? metadata.duration / 2);
}

function localSignalReviewWindow(file: MediaAsset, fallbackCenter: number, fallbackDuration: number) {
  const metadata = file.metadata;
  const duration = Number(metadata?.duration || 0);
  const sustainedSignal = semanticState(file) !== "uncertain" &&
    Number(metadata?.indexScore || 0) >= 30 &&
    Number(metadata?.actionScore || 0) >= 15 &&
    !(metadata?.semanticEvents || []).length &&
    !(metadata?.semanticCandidateHistory || []).length &&
    !(metadata?.candidateWindows || []).length;
  if (sustainedSignal) {
    const windowDuration = Math.min(24, Math.max(14, duration * 0.27 || 18));
    const start = Math.max(0, Math.min(Math.max(0, duration - windowDuration), Math.ceil(fallbackCenter + 2)));
    return { start, end: Math.min(duration || start + windowDuration, start + windowDuration) };
  }
  const start = Math.max(0, Math.min(duration - 1, fallbackCenter - fallbackDuration * 0.55));
  return { start, end: Math.min(duration || start + fallbackDuration, start + fallbackDuration) };
}

function intervalsOverlapMeaningfully(a: { start: number; end: number }, b: { start: number; end: number }) {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  if (overlap <= 0) return false;
  const shorter = Math.max(1, Math.min(a.end - a.start, b.end - b.start));
  return overlap >= 5 || overlap / shorter >= 0.35;
}

function confidenceFromScore(score: number, fallback: "high" | "medium" | "low" = "medium") {
  if (!Number.isFinite(score)) return fallback;
  if (score >= 82) return "high";
  if (score >= 64) return "medium";
  return "low";
}

function confidenceLabel(confidence?: "high" | "medium" | "low") {
  if (confidence === "high") return "High confidence";
  if (confidence === "low") return "Low confidence";
  return "Medium confidence";
}

export function highlightReviewCandidates(file: MediaAsset): HighlightReviewItem[] {
  const metadata = file.metadata;
  if (!metadata?.duration || metadata.videoCodec === "pending") return [];
  if (metadata.reviewed === true) return [];
  if ((metadata.confirmedHighlightMoments || []).length > 0) return [];
  const confirmed = metadata.confirmedHighlightMoments || [];
  const rejected = metadata.rejectedHighlightMoments || [];
  const overlapsConfirmed = (item: { start: number; end: number }) => confirmed.some((confirmation) => {
    const start = Number(confirmation.start) || 0;
    const end = Number(confirmation.end) || start + (Number(confirmation.duration) || 0);
    return intervalsOverlapMeaningfully({ start, end }, item);
  });
  const overlapsRejected = (item: { start: number; end: number }) => rejected.some((rejection) =>
    rejection.reason === "not-highlight" &&
    Math.max(Number(rejection.start) || 0, item.start) < Math.min(Number(rejection.end) || Number(rejection.start) + Number(rejection.duration), item.end) - 0.75
  );
  const state = semanticState(file);
  const verifiedEvents = (metadata.semanticEvents || [])
    .filter((event) => event.payoffVerified === true)
    .map((event) => ({
      start: Number(event.start) || 0,
      end: Number(event.end) || 0,
      score: Number(event.score) || Number(metadata.semanticScore) || 80,
      state: event.state,
      action: event.action,
      storyRole: event.storyRole || event.payoffStage || "payoff",
      source: "vision",
      label: "AI verified",
      confidence: "high" as const
    }));
  const potentialEvents = [
    ...(metadata.semanticCandidateHistory || []).map((event) => ({
      start: Number(event.start) || 0,
      end: Number(event.end) || 0,
      score: Number(event.score) || Number(metadata.semanticScore) || 65,
      state: event.state,
      action: event.action,
      storyRole: event.storyRole || event.payoffStage || "candidate",
      source: "vision-candidate",
      label: state === "verified" ? "AI candidate" : "Potential highlight",
      confidence: (Number(event.score) || Number(metadata.semanticScore) || 65) >= 64 ? "medium" as const : "low" as const
    })),
    ...(metadata.candidateWindows || []).map((window) => ({
      start: Number(window.start) || 0,
      end: Number(window.end) || (Number(window.start) || 0) + (Number(window.duration) || 8),
      score: Number(window.score) || Number(metadata.indexScore) || 55,
      state: "indexed",
      action: window.reason,
      storyRole: window.storyRole || "candidate",
      source: "index",
      label: state === "verified" ? "Indexed backup" : "Potential highlight",
      confidence: confidenceFromScore(Number(window.score) || Number(metadata.indexScore) || 55, "low")
    }))
  ];
  const fallbackCenter = reliableFocusTime(file);
  const fallbackDuration = state === "uncertain" ? 12 : 8;
  const { start: fallbackStart, end: fallbackEnd } = localSignalReviewWindow(file, fallbackCenter, fallbackDuration);
  const shouldAddFallback = (state === "uncertain" || hasRecoverableGameplaySignal(file)) && !verifiedEvents.length && !potentialEvents.length && fallbackEnd > fallbackStart;
  const fallbackEvents = shouldAddFallback
    ? [{
        start: fallbackStart,
        end: fallbackEnd,
        score: Number(metadata.semanticScore) || Number(metadata.indexScore) || 50,
        state: state === "uncertain" ? "uncertain" : "local-signal",
        action: state === "uncertain" ? "manual review needed" : "local highlight signal",
        storyRole: "candidate",
        source: state === "uncertain" ? "ai-uncertain" : "local-signal",
        label: state === "uncertain" ? "AI uncertain" : "Local signal",
        confidence: confidenceFromScore(Number(metadata.semanticScore) || Number(metadata.indexScore) || 50, "low")
      }]
    : [];
  const base = verifiedEvents.length ? verifiedEvents : [...potentialEvents, ...fallbackEvents];
  const unique: HighlightReviewItem[] = [];
  for (const item of base
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start && !overlapsConfirmed(item) && !overlapsRejected(item))
    .sort((a, b) => b.score - a.score)) {
    const start = Math.max(0, Math.min(metadata.duration, item.start));
    const end = Math.max(start + 1, Math.min(metadata.duration, item.end));
    const id = `${file.id}:${item.source}:${Math.round(start * 10)}:${Math.round(end * 10)}`;
    if (unique.some((candidate) => candidate.id === id)) continue;
    if (unique.some((candidate) => intervalsOverlapMeaningfully(candidate, { start, end }))) continue;
    unique.push({
      id,
      file,
      start,
      end,
      duration: end - start,
      score: Math.round(item.score),
      state: item.state,
      action: item.action,
      storyRole: item.storyRole,
      source: item.source,
      label: item.label,
      confidence: item.label === "AI verified" ? "high" : item.confidence,
      confirmed: false
    });
  }
  return unique;
}

function semanticReviewAttempts(file: MediaAsset) {
  const metadata = file.metadata;
  const attemptVersion = Number(metadata?.semanticReviewAttemptVersion || 0);
  return attemptVersion === semanticReviewVersion ? Number(metadata?.semanticReviewAttempts || 0) : 0;
}

function needsVisionTimelineRecheck(file: MediaAsset) {
  const metadata = file.metadata;
  if (!metadata?.duration || metadata.videoCodec === "pending") return false;
  if (semanticState(file) !== "reviewed") return false;
  if (metadata.semanticFineReviewed === true) return false;
  if (semanticReviewAttempts(file) >= maxSemanticReviewAttempts && !metadata.semanticReviewLastError) return false;
  return potentialMomentRanges(file).length > 0;
}

function needsVisionRecheck(file: MediaAsset) {
  return semanticState(file) === "needs_check" || needsVisionTimelineRecheck(file);
}

function isVisionReviewableSource(file: MediaAsset) {
  return !looksLikeGeneratedExport(file.name) &&
    Boolean(file.metadata?.duration) &&
    file.metadata?.videoCodec !== "pending";
}

function initialVisionCandidates(files: MediaAsset[]) {
  return files.filter((file) => isVisionReviewableSource(file) && semanticState(file) === "needs_check");
}

function timelineVisionCandidates(files: MediaAsset[]) {
  return files.filter((file) => isVisionReviewableSource(file) && needsVisionTimelineRecheck(file));
}

function visionReviewCandidates(files: MediaAsset[]) {
  return files
    .filter((file) => isVisionReviewableSource(file) && needsVisionRecheck(file))
    .sort((a, b) => {
      const attemptOrder = semanticReviewAttempts(a) - semanticReviewAttempts(b);
      if (attemptOrder) return attemptOrder;
      return Number(b.metadata?.indexScore || b.metadata?.actionScore || 0) -
        Number(a.metadata?.indexScore || a.metadata?.actionScore || 0);
    });
}

function intervalDurationSeconds(item: { start?: number; end?: number; duration?: number }) {
  const start = Number(item.start) || 0;
  const end = Number(item.end);
  return Math.max(0, Number(item.duration) || (Number.isFinite(end) ? end - start : 0));
}

function luckyPlanningDuration(file: MediaAsset) {
  const metadata = file.metadata;
  if (!metadata) return 0;
  const fileDuration = Number(metadata.duration || 0);
  const confirmedSeconds = (metadata.confirmedHighlightMoments || [])
    .reduce((sum, moment) => sum + Math.min(18, Math.max(4, intervalDurationSeconds(moment))), 0);
  const verifiedSeconds = (metadata.semanticEvents || [])
    .filter((event) => event.payoffVerified === true)
    .reduce((sum, event) => sum + Math.min(18, Math.max(6, intervalDurationSeconds(event) + 6)), 0);
  const candidateSeconds = (metadata.candidateWindows || [])
    .filter((window) => Number(window.score || 0) >= 72)
    .slice(0, 3)
    .reduce((sum, window) => sum + Math.min(16, Math.max(6, intervalDurationSeconds(window) || 8)), 0);
  const planned = confirmedSeconds + verifiedSeconds || candidateSeconds || Math.min(fileDuration, 18);
  return Math.min(fileDuration || planned, Math.max(4, planned));
}

export function chooseDiversifiedClips(
  files: MediaAsset[],
  recentSelections: string[][] = [],
  random: () => number = Math.random,
  limit = 20,
  targetDuration = 180
) {
  const ready = files.filter((file) =>
    !looksLikeGeneratedExport(file.name) &&
    file.metadata?.duration &&
    file.metadata.videoCodec !== "pending" &&
    semanticState(file) !== "rejected"
  );
  const verified = ready.filter((file) => semanticState(file) === "verified" || (file.metadata?.confirmedHighlightMoments || []).length > 0);
  const useVerifiedWindows = verified.length > 0;
  const eligible = useVerifiedWindows ? verified : ready;
  const plannedDuration = (file: MediaAsset) => useVerifiedWindows ? luckyPlanningDuration(file) : Number(file.metadata?.duration || 0);
  const selected: MediaAsset[] = [];
  const represented = new Map<string, number>();
  const recentUse = new Map<string, number>();
  const history = recentSelections.slice(-3);
  history.forEach((selection, age) => {
    const weight = age === history.length - 1 ? 3 : age + 1;
    selection.forEach((id) => recentUse.set(id, (recentUse.get(id) || 0) + weight));
  });
  const selectionDuration = () => selected.reduce((sum, file) => sum + plannedDuration(file), 0);

  while (selected.length < Math.min(limit, eligible.length)) {
    const currentDuration = selectionDuration();
    const remaining = eligible.filter((file) => !selected.some((item) => item.id === file.id));
    if (!remaining.length) break;
    const candidate = remaining
      .map((file) => {
        const tags = usefulTags(file);
        const duration = plannedDuration(file);
        const projected = currentDuration + duration;
        const diversity = tags.reduce((sum, tag) => {
          const uses = represented.get(tag) || 0;
          return sum + (uses === 0 ? 18 : uses === 1 ? 4 : -12);
        }, tags.length ? 0 : -10);
        const quality = Number(file.metadata?.semanticScore ?? file.metadata?.indexScore ?? file.metadata?.actionScore ?? 0);
        const underfillBonus = projected <= targetDuration ? Math.min(34, duration / 2) : 0;
        const overTargetPenalty = projected > targetDuration ? (projected - targetDuration) * 0.7 : 0;
        const shortfallPenalty = projected < targetDuration * 0.7 ? (targetDuration * 0.7 - projected) * 0.18 : 0;
        return {
          file,
          tags,
          value: quality * 0.72 + diversity + underfillBonus - overTargetPenalty - shortfallPenalty - (recentUse.get(file.id) || 0) * 9 + random() * 12
        };
      })
      .sort((a, b) => b.value - a.value || a.file.id.localeCompare(b.file.id))[0];
    if (!candidate) break;
    selected.push(candidate.file);
    candidate.tags.forEach((tag) => represented.set(tag, (represented.get(tag) || 0) + 1));
  }

  if (!selected.length && eligible.length) selected.push(eligible[0]);

  const previous = new Set(recentSelections.at(-1) || []);
  if (eligible.length > selected.length && selected.length && selected.every((file) => previous.has(file.id))) {
    const currentDuration = selectionDuration();
    const removedDuration = selected.length ? plannedDuration(selected[selected.length - 1]) : 0;
    const replacement = eligible
      .filter((file) => !previous.has(file.id) && !selected.some((item) => item.id === file.id))
      .sort((a, b) => {
        const aProjected = currentDuration - removedDuration + plannedDuration(a);
        const bProjected = currentDuration - removedDuration + plannedDuration(b);
        return Math.abs(aProjected - targetDuration) - Math.abs(bProjected - targetDuration) ||
          Number(b.metadata?.semanticScore ?? b.metadata?.indexScore ?? b.metadata?.actionScore ?? 0) -
          Number(a.metadata?.semanticScore ?? a.metadata?.indexScore ?? a.metadata?.actionScore ?? 0);
      })[0];
    if (replacement) selected[selected.length - 1] = replacement;
  }
  return selected.map((file) => file.id);
}

function looksLikeGeneratedExport(name: string) {
  return /vision reviewed|created with highlightai|highlightai export|trailer - vision|assets\.json|^warsaw\b.*trailer/i.test(name);
}

function isSelectableSourceClip(file: MediaAsset) {
  return !looksLikeGeneratedExport(file.name) &&
    Boolean(file.metadata?.duration) &&
    file.metadata?.videoCodec !== "pending";
}

function normalizeAssets(assets: MediaAsset[]) {
  return assets.map((file) => ({
    ...file,
    type: file.name.match(/\.(mp3|wav|m4a|aac|flac|ogg)$/i) ? "audio" as const : "image" as const,
    source: file.source || "local-asset"
  }));
}

function assetDuration(asset: MediaAsset | null) {
  return Number(asset?.duration || asset?.metadata?.duration || 0);
}

function effectiveMusicDuration(asset: MediaAsset | null, repeats: number) {
  const duration = assetDuration(asset);
  if (!duration) return 0;
  return Math.min(180, duration * Math.max(1, repeats || 1));
}

function totalSourceClipDuration(files: MediaAsset[]) {
  return Math.round(files.reduce((sum, file) => sum + Math.max(0, Number(file.metadata?.duration) || 0), 0) * 10) / 10;
}

function totalSegmentDuration(segments: Segment[]) {
  return Math.round(segments.reduce((sum, segment) => sum + Math.max(0, Number(segment.duration) || 0), 0) * 10) / 10;
}

function App() {
  const [stage, setStage] = useState<Stage>("start");
  const [recordings, setRecordings] = useState<MediaAsset[]>([]);
  const [localAssets, setLocalAssets] = useState<MediaAsset[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [activeDraft, setActiveDraft] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [generating, setGenerating] = useState(false);
  const [renderJob, setRenderJob] = useState<RenderJob | null>(null);
  const [clipSearch, setClipSearch] = useState("");
  const [clipSort, setClipSort] = useState<"score" | "duration" | "name">("score");
  const [activeTag, setActiveTag] = useState("");
  const [visibleClipLimit, setVisibleClipLimit] = useState(40);
  const [libraryView, setLibraryView] = useState<"grid" | "grid-4" | "list" | "detail">(() => {
    const saved = localStorage.getItem("highlight-ai-library-view");
    return saved === "grid-4" || saved === "list" || saved === "detail" ? saved : "grid";
  });
  const [theme, setTheme] = useState<"dark" | "light">(() => localStorage.getItem("highlight-ai-theme") === "light" ? "light" : "dark");
  const [appRoute, setAppRoute] = useState<"dashboard" | "review">(() => window.location.pathname === "/review" ? "review" : "dashboard");
  const [previewVideo, setPreviewVideo] = useState<{ title: string; url: string; generated?: boolean; localPath?: string } | null>(null);
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const [assetBrowser, setAssetBrowser] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generatedLibraryOpen, setGeneratedLibraryOpen] = useState(false);
  const [reviewMusicCoveragePrompt, setReviewMusicCoveragePrompt] = useState<ReviewMusicCoveragePrompt | null>(null);
  const [assetQuery, setAssetQuery] = useState("cinematic gaming");
  const [publicAudio, setPublicAudio] = useState<PublicAudio[]>([]);
  const [advancedAdvice, setAdvancedAdvice] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);
  const [operationIssue, setOperationIssue] = useState<OperationIssue | null>(null);
  const [generationAdvice, setGenerationAdvice] = useState("");
  const [fastIndexEstimate, setFastIndexEstimate] = useState<FastIndexEstimate | null>(null);
  const [fastIndexJob, setFastIndexJob] = useState<FastIndexJob | null>(null);
  const [preprocessEstimate, setPreprocessEstimate] = useState<PreprocessEstimate | null>(null);
  const [preprocessJob, setPreprocessJob] = useState<PreprocessJob | null>(null);
  const [pausePending, setPausePending] = useState<Partial<Record<PauseTask, boolean>>>({});
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([]);
  const [selectedAudioAssetId, setSelectedAudioAssetId] = useState("");
  const [musicRepeats, setMusicRepeats] = useState<1 | 2>(1);
  const [highlightReview, setHighlightReview] = useState<HighlightReviewSession | null>(null);
  const [highlightReviewPlaying, setHighlightReviewPlaying] = useState(false);
  const [highlightTrim, setHighlightTrim] = useState<{ start: number; end: number } | null>(null);
  const [highlightSessionDiscards, setHighlightSessionDiscards] = useState<HighlightDiscard[]>([]);
  const [pendingHighlightGenerateIdea, setPendingHighlightGenerateIdea] = useState<VideoIdea | null>(null);
  const [pendingReviewDraftId, setPendingReviewDraftId] = useState("");
  const [reviewGeneratePrompt, setReviewGeneratePrompt] = useState(false);
  const [reviewGeneratePromptDismissed, setReviewGeneratePromptDismissed] = useState(false);
  const [visionModelStatus, setVisionModelStatus] = useState<AiModelStatus | null>(null);
  const [textModelStatus, setTextModelStatus] = useState<AiModelStatus | null>(null);
  const [autoAiStatus, setAutoAiStatus] = useState<{ state: "idle" | "waiting" | "vision" | "text" | "complete" | "error"; message: string }>({
    state: "idle",
    message: ""
  });
  const [autoAiRetry, setAutoAiRetry] = useState(0);
  const [modelTestState, setModelTestState] = useState<Record<"vision" | "text", { state: "idle" | "testing" | "success" | "error"; message: string }>>({
    vision: { state: "idle", message: "" },
    text: { state: "idle", message: "" }
  });
  const [visionAiConfig, setVisionAiConfig] = useState(() => loadAiConfig("highlight-ai-vision-provider", defaultVisionAi));
  const [textAiConfig, setTextAiConfig] = useState(() => loadAiConfig("highlight-ai-text-provider", defaultTextAi, true));
  const [aiResourceLimits, setAiResourceLimits] = useState<AiResourceLimits>(() => loadAiResourceLimits());
  const [visionReviewMode, setVisionReviewMode] = useState<VisionReviewMode>(() => {
    const saved = localStorage.getItem("highlight-ai-vision-review-mode") as VisionReviewMode | null;
    return saved === "light" || saved === "balanced" || saved === "thorough"
      ? saved
      : defaultVisionReviewMode(loadAiConfig("highlight-ai-vision-provider", defaultVisionAi));
  });
  const recordingInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const assetInput = useRef<HTMLInputElement>(null);
  const cancelIngest = useRef<() => void>(() => undefined);
  const cancelFastIndex = useRef<() => void>(() => undefined);
  const cancelPreprocess = useRef<() => void>(() => undefined);
  const cancelRender = useRef<() => void>(() => undefined);
  const highlightReviewVideo = useRef<HTMLVideoElement>(null);
  const highlightReviewFrame = useRef<number | null>(null);
  const clipPageSentinel = useRef<HTMLDivElement>(null);
  const autoAiAttempt = useRef("");
  const luckySelectionHistory = useRef<string[][]>([]);

  function noticeFromError(error: unknown, fallback: string) {
    const issue = issueFromError(error);
    return issue.message || fallback;
  }

  useEffect(() => {
    void listProjects().then(setRecentProjects).catch(() => undefined);
    void getDiagnostics().then(setDiagnostics).catch(() => undefined);
  }, []);

  useEffect(() => {
    const syncRoute = () => setAppRoute(window.location.pathname === "/review" ? "review" : "dashboard");
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("highlight-ai-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("highlight-ai-library-view", libraryView);
  }, [libraryView]);

  useEffect(() => {
    setReviewMusicCoveragePrompt(null);
  }, [selectedAudioAssetId, musicRepeats, selectedVideoIds.join("|")]);

  useEffect(() => {
    if (!project?.id) return;
    let stopped = false;
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const next = await reconcileProject(project.id);
        if (stopped) return;
        if (next.fastIndex?.jobId) {
          const job = await getFastIndexJob(next.fastIndex.jobId).catch(() => null);
          if (!stopped && job) setFastIndexJob(job);
        }
        setProject(next);
        setRecordings(next.files.map((file) => ({ ...file, type: "video", source: "recording" })));
        setDrafts(next.drafts || []);
        setActiveDraft(Math.max(0, (next.drafts || []).length - 1));
        setAnalysis(next.analysis || null);
        const validIds = new Set(next.files.map((file) => file.id));
        setSelectedVideoIds((current) => current.filter((id) => validIds.has(id)));
        setRecentProjects((current) => current.map((item) => item.id === next.id ? next : item));
      } catch {
        // A temporary refresh failure should not interrupt the active workflow.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const onVisibility = () => void refresh();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [project?.id]);

  useEffect(() => {
    setVisibleClipLimit(40);
  }, [project?.id, clipSearch, clipSort, activeTag]);

  useEffect(() => {
    const target = clipPageSentinel.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleClipLimit((current) => {
          const maxVisible = Math.max(0, visibleLibrary.length);
          if (current >= maxVisible) return current;
          return Math.min(current + 40, maxVisible);
        });
      }
    }, { rootMargin: "500px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [visibleClipLimit, project?.id, clipSearch, clipSort, activeTag]);

  useEffect(() => {
    const closeModal = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (appRoute === "review") {
        navigateToDashboard();
        return;
      }
      if (previewVideo) setPreviewVideo(null);
      else if (generatedLibraryOpen) setGeneratedLibraryOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
      else if (assetBrowser) setAssetBrowser(false);
    };
    window.addEventListener("keydown", closeModal);
    return () => window.removeEventListener("keydown", closeModal);
  }, [appRoute, assetBrowser, generatedLibraryOpen, previewVideo, settingsOpen]);

  useEffect(() => {
    const current = highlightReview?.items[highlightReview.index];
    if (highlightReviewFrame.current !== null) {
      window.cancelAnimationFrame(highlightReviewFrame.current);
      highlightReviewFrame.current = null;
    }
    if (!current) {
      setHighlightTrim(null);
      setHighlightReviewPlaying(false);
      return;
    }
    setHighlightTrim({ start: current.start, end: current.end });
    setHighlightReviewPlaying(false);
    window.setTimeout(() => {
      const video = highlightReviewVideo.current;
      if (!video) return;
      video.currentTime = current.start;
    }, 0);
  }, [highlightReview?.index, highlightReview?.items]);

  useEffect(() => () => {
    if (highlightReviewFrame.current !== null) window.cancelAnimationFrame(highlightReviewFrame.current);
  }, []);

  useEffect(() => {
    if (!project || stage !== "advice") return;
    const reviewProfile = effectiveVisionProfile(visionReviewMode, aiResourceLimits, visionAiConfig.endpoint);
    const initialQueue = limitVisionQueue(initialVisionCandidates(project.files), aiResourceLimits);
    const timelineQueue = limitVisionQueue(timelineVisionCandidates(project.files), aiResourceLimits);
    const estimateQueue = initialQueue.length ? initialQueue : timelineQueue;
    void estimateFastIndex(project.id, { concurrency: 3, maxWindowsPerFile: 6, windowDuration: 14 }).then(setFastIndexEstimate).catch(() => undefined);
    if (estimateQueue.length > 0) {
      void estimatePreprocess(project.id, {
        sampleInterval: reviewProfile.sampleInterval,
        concurrency: reviewProfile.concurrency,
        maxFiles: estimateQueue.length,
        maxFrames: estimateQueue.length * reviewProfile.framesPerClip,
        endpoint: visionAiConfig.endpoint,
        refineReviewed: initialQueue.length === 0
      }).then(setPreprocessEstimate).catch(() => undefined);
    } else {
      setPreprocessEstimate(null);
    }
  }, [project?.id, stage, visionReviewMode, visionAiConfig.endpoint, aiResourceLimits]);

  useEffect(() => {
    if (!project?.id) return;
    const indexReady = ["completed", "completed_with_warnings"].includes(String(project.fastIndex?.status || ""));
    const missingVision = visionReviewCandidates(project.files);
    if (!indexReady) return;
    if (!missingVision.length) {
      const reviewedFiles = project.files.filter((file) =>
        !looksLikeGeneratedExport(file.name) &&
        Number(file.metadata?.semanticFramesReviewed || 0) > 0
      );
      const eventsFound = reviewedFiles.reduce((sum, file) => sum + (file.metadata?.semanticEvents || []).filter((event) => event.payoffVerified === true).length, 0);
      const confirmedFiles = reviewedFiles.filter((file) => semanticState(file) === "verified" || hasAutoUsableHighlightCandidate(file)).length;
      const rejectedFiles = reviewedFiles.filter((file) => semanticState(file) === "rejected").length;
      const uncertainFiles = reviewedFiles.filter((file) =>
        semanticState(file) === "uncertain" &&
        !hasAutoUsableHighlightCandidate(file)
      ).length;
      setAutoAiStatus({
        state: "complete",
        message: uncertainFiles
          ? `Vision AI confirmed ${confirmedFiles} highlight-ready clip${confirmedFiles === 1 ? "" : "s"} and rejected ${rejectedFiles} low-signal clip${rejectedFiles === 1 ? "" : "s"}. ${uncertainFiles} clip${uncertainFiles === 1 ? " is" : "s are"} still low confidence. Nothing is running.`
          : `Vision AI confirmed ${confirmedFiles} highlight-ready clip${confirmedFiles === 1 ? "" : "s"} and rejected ${rejectedFiles} low-signal clip${rejectedFiles === 1 ? "" : "s"}. Nothing is running.`
      });
      return;
    }
    if (["processing", "paused"].includes(String(preprocessJob?.status || ""))) return;
    const attemptKey = `${project.id}:${missingVision.map((file) => `${file.id}:${file.metadata?.semanticReviewAttempts || 0}:${file.metadata?.semanticReviewAttemptVersion || 0}`).join(",")}:${visionAiConfig.endpoint}:${visionAiConfig.model}:${visionAiConfig.apiKey}:${textAiConfig.endpoint}:${textAiConfig.model}:${textAiConfig.apiKey}:${visionReviewMode}:${aiResourceLimits.maxVisionWorkers}:${aiResourceLimits.maxFramesPerVideo}:${aiResourceLimits.maxVideosPerRun}`;
    if (autoAiAttempt.current === attemptKey) return;
    autoAiAttempt.current = attemptKey;
    let stopped = false;

    const runAutomaticAi = async () => {
      try {
        setAutoAiStatus({ state: "waiting", message: "Checking the configured Vision AI model..." });
        const visionStatus = await checkAiModel(visionAiConfig);
        if (stopped) return;
        setVisionModelStatus(visionStatus);
        let indexedProject = project;
        const reviewProfile = effectiveVisionProfile(visionReviewMode, aiResourceLimits, visionAiConfig.endpoint);
        let totalEventsFound = 0;
        const firstPassQueue = limitVisionQueue(initialVisionCandidates(indexedProject.files), aiResourceLimits);
        if (firstPassQueue.length) {
          setAutoAiStatus({
            state: "vision",
            message: `Vision AI is checking ${firstPassQueue.length} videos in the background.`
          });
          const job = await runVisionPreprocessPass(
            indexedProject.id,
            firstPassQueue,
            reviewProfile,
            "Find complete rare gameplay highlights. Preserve game-specific setup, decisive action, visible result, and reaction. Reject irrelevant interface screens, inactivity, repetition, and incomplete events."
          );
          if (stopped) return;
          totalEventsFound += job.eventsFound || 0;
          if (job.result?.project) {
            indexedProject = job.result.project;
          }
          setProject(indexedProject);
          setRecordings(indexedProject.files.map((file) => ({ ...file, type: "video", source: "recording" })));
          setAnalysis(indexedProject.analysis || analysis);
          setRecentProjects((current) => current.map((item) => item.id === indexedProject.id ? indexedProject : item));
          if (job.status === "completed_with_warnings" && job.failures.length) {
            const pendingReview = visionReviewCandidates(indexedProject.files).length;
            setAutoAiStatus({
              state: "error",
              message: `Vision AI stopped because the model failed during review. ${pendingReview} videos are still pending review. Check Ollama, then run Vision AI check again.`
            });
            return;
          }
        }
        const timelineQueue = limitVisionQueue(timelineVisionCandidates(indexedProject.files), aiResourceLimits);
        if (timelineQueue.length) {
          setAutoAiStatus({
            state: "vision",
            message: `Vision AI is rechecking ${timelineQueue.length} potential highlight timeline${timelineQueue.length === 1 ? "" : "s"}.`
          });
          const job = await runVisionPreprocessPass(
            indexedProject.id,
            timelineQueue,
            reviewProfile,
            "Recheck only the supplied potential highlight timelines. Confirm a complete setup, decisive action, visible result, and reaction; if the sampled timeline still does not prove the payoff, keep it uncertain.",
            true
          );
          if (stopped) return;
          totalEventsFound += job.eventsFound || 0;
          if (job.result?.project) {
            indexedProject = job.result.project;
          }
          setProject(indexedProject);
          setRecordings(indexedProject.files.map((file) => ({ ...file, type: "video", source: "recording" })));
          setAnalysis(indexedProject.analysis || analysis);
          setRecentProjects((current) => current.map((item) => item.id === indexedProject.id ? indexedProject : item));
          if (job.status === "completed_with_warnings" && job.failures.length) {
            const pendingReview = visionReviewCandidates(indexedProject.files).length;
            setAutoAiStatus({
              state: "error",
              message: `Vision AI stopped during timeline recheck. ${pendingReview} videos are still pending review. Check Ollama, then run Vision AI check again.`
            });
            return;
          }
        }
        if (stopped) return;

        const textConfigured = Boolean(textAiConfig.model && textAiConfig.endpoint)
          && (Boolean(textAiConfig.apiKey) || /localhost|127\.0\.0\.1/i.test(textAiConfig.endpoint));
        let textCompleted = false;
        if (textConfigured) {
          try {
            setAutoAiStatus({ state: "text", message: "Text AI is organizing descriptions, tags, and creative suggestions." });
            const summary = await requestAdvancedAdvice(
              indexedProject.id,
              textAiConfig,
              "Summarize the indexed gameplay folder, identify its most varied highlight categories, and recommend a concise trailer direction. Use only the supplied metadata."
            );
            if (!stopped) {
              setAdvancedAdvice(summary);
              textCompleted = true;
            }
          } catch {
            textCompleted = false;
          }
        }
        if (!stopped) {
          const reviewedFiles = indexedProject.files.filter((file) => !looksLikeGeneratedExport(file.name) && Number(file.metadata?.semanticFramesReviewed || 0) > 0).length;
          const pendingReview = visionReviewCandidates(indexedProject.files).length;
          setAutoAiStatus({
            state: pendingReview ? "waiting" : "complete",
            message: pendingReview
              ? `Vision AI stopped before folder review finished. ${pendingReview} videos are still pending review.`
              : textCompleted
                ? `Background Vision and Text AI reviewed ${reviewedFiles} videos. ${totalEventsFound} new highlight events are indexed.`
                : `Vision AI finished reviewing ${reviewedFiles} videos. ${totalEventsFound} new highlight events are indexed.`
          });
        }
      } catch (error) {
        if (stopped || (error instanceof Error && /cancel/i.test(error.message))) return;
        const issue = issueFromError(error);
        setAutoAiStatus({
          state: "error",
          message: `${issue.message} Open Ollama yourself, then choose Check again.`
        });
      }
    };

    void runAutomaticAi();
    return () => { stopped = true; };
  }, [
    project?.id,
    project?.fastIndex?.status,
    visionAiConfig.endpoint,
    visionAiConfig.model,
    visionAiConfig.apiKey,
    textAiConfig.endpoint,
    textAiConfig.model,
    textAiConfig.apiKey,
    visionReviewMode,
    aiResourceLimits,
    autoAiRetry
  ]);

  function resumeProject(next: Project) {
    const assets = normalizeAssets(next.assets);
    setProject(next);
    setRecordings(next.files.map((file) => ({ ...file, type: "video", source: "recording" })));
    setLocalAssets(assets);
    setSelectedAudioAssetId(assets.find((asset) => asset.type === "audio")?.id || "");
    setDrafts(next.drafts);
    setActiveDraft(Math.max(0, next.drafts.length - 1));
    setSelectedVideoIds([]);
    if (next.fastIndex?.jobId) {
      void getFastIndexJob(next.fastIndex.jobId).then(setFastIndexJob).catch(() => setFastIndexJob(null));
    } else {
      setFastIndexJob(null);
    }
    setActiveDraft(0);
    const totalDuration = next.files.reduce((sum, file) => sum + (file.metadata?.duration || 0), 0);
    setAnalysis(next.analysis || {
      qualityScore: Math.round(next.files.reduce((sum, file) => sum + (file.metadata?.qualityScore || 0), 0) / Math.max(1, next.files.length)),
      actionMoments: Math.max(3, Math.min(40, Math.round(totalDuration / 18))),
      totalDuration,
      totalSize: next.files.reduce((sum, file) => sum + file.size, 0),
      notes: ["Saved local project restored.", "All source footage remains available.", "Choose a direction or continue with an existing draft."],
      ideas: curatedIdeas
    });
    setStage(next.drafts.length ? "drafts" : "advice");
    const indexReady = ["completed", "completed_with_warnings"].includes(String(next.fastIndex?.status || ""));
    setAutoAiStatus({
      state: "waiting",
      message: indexReady
        ? "Vision AI and the configured Text AI will verify this folder automatically in the background."
        : "Local indexing will continue first, followed automatically by Vision AI and configured Text AI."
    });
  }

  function showProject(next: Project, preserveSelection = true) {
    const assets = normalizeAssets(next.assets);
    setProject(next);
    setRecordings(next.files.map((file) => ({ ...file, type: "video", source: "recording" })));
    setLocalAssets(assets);
    setSelectedAudioAssetId(assets.find((asset) => asset.type === "audio")?.id || "");
    setAnalysis(next.analysis || null);
    setDrafts(next.drafts || []);
    setActiveDraft(Math.max(0, (next.drafts || []).length - 1));
    const nextIds = new Set(next.files.map((file) => file.id));
    setSelectedVideoIds((current) =>
      preserveSelection && current.length
        ? current.filter((id) => {
            const file = next.files.find((item) => item.id === id);
            return file && nextIds.has(id) && isSelectableSourceClip(file);
          })
        : []
    );
    setRecentProjects((current) => [next, ...current.filter((item) => item.id !== next.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    setStage("advice");
    const indexReady = ["completed", "completed_with_warnings"].includes(String(next.fastIndex?.status || ""));
    setAutoAiStatus({
      state: "waiting",
      message: indexReady
        ? "Vision AI and the configured Text AI will analyze this folder automatically in the background."
        : "Local indexing starts now. Vision AI and the configured Text AI will continue automatically afterward."
    });
  }

  async function openSavedPath(next: Project) {
    try {
      setBusy("Loading saved path...");
      const fresh = await getProject(next.id);
      resumeProject(fresh);
    } catch (error) {
      setOperationIssue(issueFromError(error));
      setNotice(noticeFromError(error, "Could not load that saved path."));
    } finally {
      setBusy("");
    }
  }

  async function removeSavedProject(next: Project) {
    const label = next.sourcePath ? "folder from HighlightAI" : "upload project";
    if (!window.confirm(`Remove this ${label}? Original source files will not be deleted.`)) return;
    try {
      await deleteProject(next.id);
      setRecentProjects((current) => current.filter((item) => item.id !== next.id));
      if (project?.id === next.id) reset();
      setNotice(`${next.name} was removed from HighlightAI. Original source files were preserved.`);
    } catch (error) {
      setNotice(noticeFromError(error, "Could not remove this folder."));
    }
  }

  async function searchPublicAssets() {
    setAssetBrowser(true);
    try {
      setBusy("Searching Creative Commons audio...");
      setPublicAudio(await findPublicAudio(assetQuery));
    } catch (error) {
      setNotice(noticeFromError(error, "Could not search public audio."));
    } finally {
      setBusy("");
    }
  }

  async function addPublicAsset(audio: PublicAudio) {
    if (!project) return;
    try {
      setBusy("Downloading and recording license details...");
      const updated = await importPublicAudio(project.id, audio);
      setProject(updated);
      const assets = normalizeAssets(updated.assets);
      setLocalAssets(assets);
      const added = [...assets].reverse().find((asset) => asset.type === "audio");
      if (added) setSelectedAudioAssetId(added.id);
      setAssetBrowser(false);
      setNotice(`${audio.title} is selected as the soundtrack.`);
    } catch (error) {
      setNotice(noticeFromError(error, "Could not import public audio."));
    } finally {
      setBusy("");
    }
  }

  async function importFiles(list: FileList | null) {
    if (!list) return;
    const imported = Array.from(list).map((file) => toAsset(file, "recording"));
    const videos = imported.filter((file) => file.type === "video");
    if (!videos.length) {
      setNotice("No supported video files were found.");
      return;
    }
    const files = Array.from(list).filter((file) => file.type.startsWith("video/") || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file.name));
    setRecordings(videos);
    setPendingFiles(files);
    setOperationIssue(null);
    setStage("analyzing");
    setIngestProgress(null);
    try {
      const result = await ingestFiles(files, setIngestProgress, (cancel) => { cancelIngest.current = cancel; });
      showProject(result.project);
      if (result.job.failures.length) {
        setNotice(`${result.project.files.length} videos are ready. ${result.job.failures.length} unreadable video${result.job.failures.length === 1 ? " was" : "s were"} skipped.`);
      }
    } catch (error) {
      setOperationIssue(issueFromError(error));
      setStage("start");
    }
  }

  async function startImport() {
    if (!pendingFiles.length) return;
    setStage("analyzing");
    setOperationIssue(null);
    setIngestProgress(null);
    try {
      const result = await ingestFiles(pendingFiles, setIngestProgress, (cancel) => { cancelIngest.current = cancel; });
      setProject(result.project);
      setRecordings(result.project.files.map((file) => ({ ...file, type: "video", source: "recording" })));
      setSelectedVideoIds([]);
      setAnalysis(result.analysis);
      if (result.job.failures.length) setNotice(`${result.project.files.length} videos are ready. ${result.job.failures.length} unreadable video${result.job.failures.length === 1 ? " was" : "s were"} skipped.`);
      setStage("advice");
    } catch (error) {
      setOperationIssue(issueFromError(error));
      setStage("preflight");
    }
  }

  async function chooseLocalFolder() {
    if (!window.highlightAI?.chooseFolder) {
      folderInput.current?.click();
      return;
    }
    try {
      const folder = await window.highlightAI.chooseFolder();
      if (!folder) return;
      setNotice("Folder added. Local indexing, Vision AI, and configured Text AI will run automatically in the background.");
      setStage("analyzing");
      setOperationIssue(null);
      setIngestProgress(null);
      const result = await ingestLocalFolder(
        folder,
        setIngestProgress,
        (cancel) => { cancelIngest.current = cancel; },
        (nextProject) => showProject(nextProject)
      );
      showProject(result.project);
      if (result.job.failures.length) setNotice(`${result.project.files.length} videos are ready. ${result.job.failures.length} unreadable files were skipped.`);
      setStage("advice");
    } catch (error) {
      const issue = issueFromError(error);
      setOperationIssue({
        ...issue,
        title: issue.title === "Something went wrong" ? "Folder import failed" : issue.title,
        action: issue.action || "Restart the desktop app and try again. If this repeats, use the browser file picker while we inspect the desktop bridge."
      });
      setNotice(`${issue.title}: ${issue.message}`);
      setStage("start");
    }
  }

  function stopImport() {
    cancelIngest.current();
    setOperationIssue({
      title: "Import cancelled",
      message: "Processing stopped at your request.",
      action: "Files already copied into HighlightAI were preserved. Start processing again to create a new clean import.",
      recoverable: true
    });
    setStage("preflight");
  }

  async function toggleImportPause() {
    if (!ingestProgress?.id) return;
    const previous = ingestProgress;
    const pausing = previous.status !== "paused";
    setPausePending((current) => ({ ...current, ingest: true }));
    setIngestProgress({
      ...previous,
      status: pausing ? "paused" : "processing",
      phase: pausing ? "paused" : "probing",
      activeFileBytes: 0,
      activeFileSize: 0
    });
    setNotice(pausing ? "Pausing import..." : "Resuming import...");
    try {
      const next = pausing ? await pauseIngestJob(previous.id) : await resumeIngestJob(previous.id);
      setIngestProgress({ ...next, activeFileBytes: 0, activeFileSize: 0 });
      setNotice(next.status === "paused" ? "Import paused after saving completed files." : "Import resumed from saved progress.");
    } catch (error) {
      setIngestProgress(previous);
      setNotice(noticeFromError(error, "Could not change the import state."));
    } finally {
      setPausePending((current) => ({ ...current, ingest: false }));
    }
  }

  async function importAssets(list: FileList | null) {
    if (!list) return;
    if (!project) {
      setLocalAssets((current) => [...current, ...Array.from(list).map((file) => toAsset(file, "local-asset"))]);
      setNotice("Assets are ready and will be added after you select footage.");
      return;
    }
    try {
      setBusy("Adding local assets...");
      const updated = await addAssets(project.id, Array.from(list));
      setProject(updated);
      const assets = normalizeAssets(updated.assets);
      setLocalAssets(assets);
      const addedNames = new Set(Array.from(list).map((file) => file.name));
      const addedAudio = [...assets].reverse().find((asset) => asset.type === "audio" && addedNames.has(asset.name));
      if (addedAudio) setSelectedAudioAssetId(addedAudio.id);
      setNotice(addedAudio ? `${addedAudio.name} is selected as the soundtrack.` : `${list.length} local asset${list.length === 1 ? "" : "s"} added.`);
    } catch (error) {
      setNotice(noticeFromError(error, "Could not add assets."));
    } finally {
      setBusy("");
    }
  }

  function isSessionDiscardedCandidate(item: HighlightReviewItem) {
    return highlightSessionDiscards.some((discard) =>
      discard.fileId === item.file.id &&
      Math.max(discard.start, item.start) < Math.min(discard.end, item.end) - 0.75
    );
  }

  function isAlreadyConfirmedCandidate(item: HighlightReviewItem) {
    return (item.file.metadata?.confirmedHighlightMoments || []).some((moment) => {
      const start = Number(moment.start) || 0;
      const end = Number(moment.end) || start + (Number(moment.duration) || 0);
      return intervalsOverlapMeaningfully({ start, end }, item);
    });
  }

  function candidateItemsForReview(files: MediaAsset[]) {
    return files
      .flatMap(highlightReviewCandidates)
      .filter((item) => !isAlreadyConfirmedCandidate(item) && !isSessionDiscardedCandidate(item))
      .sort((a, b) => b.score - a.score);
  }

  function optionalReviewItems(files: MediaAsset[], limit = 10) {
    const items = candidateItemsForReview(files);
    const uncertain = items.filter((item) => item.label !== "AI verified" && item.confidence !== "high");
    return (uncertain.length ? uncertain : items).slice(0, limit);
  }

  function navigateToReviewPage() {
    if (window.location.pathname !== "/review") window.history.pushState(null, "", "/review");
    setAppRoute("review");
  }

  function navigateToDashboard() {
    if (window.location.pathname === "/review") window.history.pushState(null, "", "/");
    setAppRoute("dashboard");
  }

  function makeHighlightReviewSession(items: HighlightReviewItem[], overrides: Partial<HighlightReviewSession> = {}): HighlightReviewSession {
    const reviewed = Math.max(0, overrides.reviewed ?? items.filter((item) => item.reviewed).length);
    const confirmed = Math.max(0, overrides.confirmed ?? items.filter((item) => item.confirmed || item.reviewed && item.confirmed).length);
    return {
      items,
      index: Math.max(0, Math.min(items.length - 1, overrides.index ?? 0)),
      total: Math.max(overrides.total ?? items.length, items.length),
      reviewed,
      confirmed
    };
  }

  function beginHighlightReview(items: HighlightReviewItem[], message: string) {
    setReviewGeneratePrompt(false);
    setReviewGeneratePromptDismissed(false);
    setHighlightReview(makeHighlightReviewSession(items));
    setHighlightTrim(items[0] ? { start: items[0].start, end: items[0].end } : null);
    navigateToReviewPage();
    setNotice(message);
  }

  function confirmedMomentOverlaps(file: MediaAsset, item: { start: number; end: number }) {
    return (file.metadata?.confirmedHighlightMoments || []).some((moment) => {
      const start = Number(moment.start) || 0;
      const end = Number(moment.end) || start + (Number(moment.duration) || 0);
      return intervalsOverlapMeaningfully({ start, end }, item);
    });
  }

  function draftSegmentsToReviewItems(draft: Draft, files: MediaAsset[], source = "draft-plan") {
    const fileById = new Map(files.map((file) => [file.id, file]));
    return (draft.segments || [])
      .map((segment, index) => {
        const file = fileById.get(segment.fileId);
        if (!file?.metadata?.duration) return null;
        const duration = Number(file.metadata.duration) || 0;
        const start = Math.max(0, Math.min(Math.max(0, duration - 1), Number(segment.start) || 0));
        const rawEnd = start + Math.max(1, Number(segment.duration) || 1);
        const end = Math.max(start + 1, Math.min(duration || rawEnd, rawEnd));
        const alreadyConfirmed = confirmedMomentOverlaps(file, { start, end });
        const alreadyReviewed = file.metadata?.reviewed === true || alreadyConfirmed;
        return {
          id: `${file.id}:${source}:${draft.id}:${index}:${Math.round(start * 10)}:${Math.round(end * 10)}`,
          file,
          start,
          end,
          duration: end - start,
          score: Math.round(Number(segment.score) || Number(file.metadata.semanticScore) || Number(file.metadata.indexScore) || 65),
          state: "planned",
          action: segment.storyRole || "planned highlight",
          storyRole: segment.storyRole || "candidate",
          source: segment.source || source,
          label: source === "final-review" ? "Final review" : "Planned cut",
          confidence: segment.confidence || confidenceFromScore(Number(segment.score) || Number(file.metadata.semanticScore) || Number(file.metadata.indexScore) || 65, "medium"),
          confirmed: alreadyConfirmed,
          reviewed: alreadyReviewed
        } as HighlightReviewItem;
      })
      .filter(Boolean) as HighlightReviewItem[];
  }

  function selectedDraftReviewItems(draft: Draft, sourceProject: Project, plannedItems: HighlightReviewItem[], limit = 20) {
    const fileIds = [...new Set((draft.fileIds || []).map(String))];
    if (!fileIds.length || fileIds.length < limit) return plannedItems.filter((item) => !item.reviewed).slice(0, limit);
    const fileById = new Map(sourceProject.files.map((file) => [file.id, file]));
    const plannedReviewItems = plannedItems.filter((item) => !item.reviewed);
    const represented = new Set(plannedReviewItems.map((item) => item.file.id));
    const selectedFiles = fileIds
      .map((id) => fileById.get(id))
      .filter(Boolean) as MediaAsset[];
    const supplemental = candidateItemsForReview(selectedFiles)
      .filter((item) => !item.reviewed && !represented.has(item.file.id));
    const additions: HighlightReviewItem[] = [];
    for (const item of supplemental) {
      if (represented.has(item.file.id)) continue;
      represented.add(item.file.id);
      additions.push({
        ...item,
        id: `${item.id}:selected-review`,
        label: item.label === "AI verified" ? "Selected verified" : item.label
      });
      if (plannedReviewItems.length + additions.length >= limit) break;
    }
    return [...plannedReviewItems, ...additions].slice(0, Math.min(limit, selectedFiles.filter((file) => file.metadata?.reviewed !== true && !(file.metadata?.confirmedHighlightMoments || []).length).length || limit));
  }

  async function beginDraftSegmentReview(draft: Draft, sourceProject: Project, message = "Review the planned parts, trim weak edges, then generate the video.") {
    const reviewDraft = draft.fileIds?.length || !selectedVideoIds.length ? draft : { ...draft, fileIds: selectedVideoIds };
    const plannedItems = draftSegmentsToReviewItems(reviewDraft, sourceProject.files);
    const items = selectedDraftReviewItems(reviewDraft, sourceProject, plannedItems);
    const savedConfirmedCount = confirmedMomentSegmentsForDraft(reviewDraft, sourceProject.files).length;
    setPendingReviewDraftId(draft.id);
    setPendingHighlightGenerateIdea(null);
    setReviewGeneratePrompt(false);
    setReviewGeneratePromptDismissed(false);
    setReviewMusicCoveragePrompt(null);
    setHighlightReview(makeHighlightReviewSession(items, { total: items.length, index: 0, confirmed: savedConfirmedCount }));
    setHighlightTrim(items[0] ? { start: items[0].start, end: items[0].end } : null);
    navigateToReviewPage();
    if (items.length) {
      setNotice(message);
    } else if (savedConfirmedCount) {
      setNotice("All selected highlight parts are already confirmed. Checking music length before rendering.");
    } else {
      setNotice("No reviewable planned parts were found. Choose stronger clips or run Vision AI again.");
    }
  }

  function segmentSignature(segment: Segment) {
    return `${segment.fileId}:${Math.round((Number(segment.start) || 0) * 10)}:${Math.round((Number(segment.duration) || 0) * 10)}`;
  }

  function uniqueSegments(segments: Segment[]) {
    const seen = new Set<string>();
    const next: Segment[] = [];
    for (const segment of segments) {
      const key = segmentSignature(segment);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(segment);
    }
    return next;
  }

  function confirmedMomentSegmentsForDraft(draft: Draft, files: MediaAsset[]): Segment[] {
    const allowedIds = new Set((draft.fileIds || []).map(String));
    return files
      .filter((file) => !allowedIds.size || allowedIds.has(file.id))
      .flatMap((file) => (file.metadata?.confirmedHighlightMoments || []).map((moment) => {
        const start = Math.max(0, Number(moment.start) || 0);
        const end = Math.max(start, Number(moment.end) || start + Number(moment.duration || 0));
        const duration = Math.max(0, end - start);
        if (duration < 1) return null;
        return {
          fileId: file.id,
          start: Math.round(start * 10) / 10,
          duration: Math.round(duration * 10) / 10,
          minDuration: Math.min(Math.round(duration * 10) / 10, Math.max(1, Number(moment.duration || duration))),
          score: Math.round(Number(moment.score) || Number(file.metadata?.semanticScore) || Number(file.metadata?.indexScore) || 80),
          storyRole: moment.storyRole || "approved highlight",
          source: moment.source || "saved-confirmed",
          confidence: "high" as const
        } as Segment;
      }).filter(Boolean) as Segment[]);
  }

  function confirmedReviewItemsToSegments(session: HighlightReviewSession): Segment[] {
    return session.items
      .filter((item) => item.confirmed && item.end - item.start >= 1)
      .map((item) => ({
        fileId: item.file.id,
        start: Math.round(item.start * 10) / 10,
        duration: Math.round((item.end - item.start) * 10) / 10,
        minDuration: Math.min(Math.round((item.end - item.start) * 10) / 10, Math.max(1, Number(item.duration || item.end - item.start))),
        score: Math.round(Number(item.score) || Number(item.file.metadata?.semanticScore) || Number(item.file.metadata?.indexScore) || 70),
        storyRole: item.storyRole || "approved highlight",
        source: item.source === "draft-plan" ? "human-reviewed" : item.source || "human-reviewed",
        confidence: "high"
      }));
  }

  function approvedSegmentsForReviewDraft(draft: Draft, session: HighlightReviewSession, files: MediaAsset[]) {
    return uniqueSegments([
      ...confirmedMomentSegmentsForDraft(draft, files),
      ...confirmedReviewItemsToSegments(session)
    ]);
  }

  function confirmedMomentToReviewItem(file: MediaAsset, moment: ConfirmedHighlightMoment): HighlightReviewItem {
    const start = Number(moment.start) || 0;
    const end = Number(moment.end) || start + (Number(moment.duration) || 0);
    return {
      id: `confirmed-review:${file.id}:${Math.round(start * 10)}:${Math.round(end * 10)}`,
      file,
      start,
      end,
      duration: Math.max(1, end - start),
      score: Math.round(Number(moment.score) || Number(file.metadata?.semanticScore) || Number(file.metadata?.indexScore) || 80),
      state: moment.state,
      action: moment.action || "user verified highlight",
      storyRole: moment.storyRole || "payoff",
      source: moment.source || "user-verified",
      label: "user verified",
      confidence: "high",
      confirmed: true,
      reviewed: true
    };
  }

  function isDuplicateReviewItem(item: HighlightReviewItem, existing: HighlightReviewItem[]) {
    return existing.some((candidate) =>
      candidate.id === item.id ||
      candidate.file.id === item.file.id
    );
  }

  function beginFinalReviewDecision(job: RenderJob, reviewedDraft?: Draft) {
    if (!project) return;
    const request = job.reviewRequest;
    const fileById = new Map(project.files.map((file) => [file.id, file]));
    const fileIds = request?.fileIds?.length
      ? request.fileIds
      : reviewedDraft?.fileIds?.length
        ? reviewedDraft.fileIds
        : selectedVideoIds;
    const reviewItems = (request?.segments || [])
      .map((segment, index) => {
        const file = fileById.get(segment.fileId);
        if (!file || !file.metadata?.duration) return null;
        const start = Math.max(0, Math.min(Number(file.metadata.duration) - 1, Number(segment.start) || 0));
        const end = Math.max(start + 1, Math.min(Number(file.metadata.duration), start + (Number(segment.duration) || 6)));
        return {
          id: `${file.id}:final-review:${index}:${Math.round(start * 10)}:${Math.round(end * 10)}`,
          file,
          start,
          end,
          duration: end - start,
          score: Math.round(Number(segment.score) || Number(file.metadata.indexScore) || Number(file.metadata.semanticScore) || 60),
          state: "final-review",
          action: segment.storyRole || "final review candidate",
          storyRole: segment.storyRole || "candidate",
          source: segment.source || "final-review",
          label: "Final review",
          confidence: segment.confidence || "low"
        } as HighlightReviewItem;
      })
      .filter(Boolean) as HighlightReviewItem[];
    const fallbackItems = candidateItemsForReview(fileIds.map((id) => fileById.get(id)).filter(Boolean) as MediaAsset[]);
    const items = reviewItems.length ? reviewItems : fallbackItems.slice(0, 12);
    if (fileIds.length) setSelectedVideoIds([...new Set(fileIds)]);
    if (reviewedDraft) {
      setPendingReviewDraftId(reviewedDraft.id);
      setPendingHighlightGenerateIdea(null);
      setReviewGeneratePrompt(false);
      setReviewGeneratePromptDismissed(false);
      setDrafts((current) => current.map((item) => item.id === reviewedDraft.id ? reviewedDraft : item));
      setProject((current) => current ? { ...current, drafts: current.drafts.map((item) => item.id === reviewedDraft.id ? reviewedDraft : item) } : current);
    }
    setOperationIssue({
      title: request?.title || "Final review needs your decision",
      message: request?.problems?.[0] || request?.message || "The final reviewer could not approve the automatic timeline.",
      action: request?.action || "Review the proposed periods, trim or reject weak parts, then generate again.",
      recoverable: true
    });
    if (items.length) {
      setHighlightReview(makeHighlightReviewSession(items));
      setHighlightTrim({ start: items[0].start, end: items[0].end });
      navigateToReviewPage();
      setNotice("Final review paused generation. Edit or confirm the proposed periods, then generate again.");
    } else {
      navigateToDashboard();
      setNotice("Final review paused generation. Choose stronger clips or run Vision AI again before generating.");
    }
  }

  async function createDraft(idea: VideoIdea) {
    if (!project) return;
    const generationSourceVideos = selectedVideoIds.length ? selectedVideos : project.files.filter(isSelectableSourceClip);
    const generationVideoIds = generationSourceVideos
      .filter((file) => semanticState(file) !== "rejected")
      .map((file) => file.id);
    if (!generationVideoIds.length) {
      setNotice("No highlight-ready clips are available yet. Let Vision AI finish or choose stronger clips.");
      return;
    }
    const notReady = generationSourceVideos.filter((file) =>
      semanticState(file) !== "rejected" &&
      (!file.metadata?.duration || file.metadata.videoCodec === "pending")
    );
    if (notReady.length) {
      setNotice(`${notReady.length} selected video${notReady.length === 1 ? " is" : "s are"} still being analyzed. Wait until the folder progress finishes, then create the trailer.`);
      return;
    }
    setReviewMusicCoveragePrompt(null);
    setPendingHighlightGenerateIdea(null);
    setGenerating(true);
    setRenderJob(null);
    setOperationIssue(null);
    setGenerationAdvice("");
    let pausedFastIndexId = "";
    try {
      if (fastIndexJob?.status === "processing") {
        const paused = await pauseFastIndexJob(fastIndexJob.id);
        pausedFastIndexId = paused.id;
        setFastIndexJob(paused);
        setNotice("Folder indexing paused while Vision AI prepares this video.");
      }
      let workingProject = project;
      const needsTemporalVision = generationSourceVideos.filter((file) => {
        const events = file.metadata?.semanticEvents || [];
        const verifiedEvents = events.filter((event) => event.payoffVerified === true);
        const needsFinePass = verifiedEvents.length === 0
          && file.metadata?.semanticFineReviewed !== true;
        return needsVisionRecheck(file) || needsFinePass;
      }).sort((a, b) => (b.metadata?.indexScore || b.metadata?.semanticScore || b.metadata?.actionScore || 0)
        - (a.metadata?.indexScore || a.metadata?.semanticScore || a.metadata?.actionScore || 0))
        .slice(0, 12);
      const reviewProfile = effectiveVisionProfile(visionReviewMode, aiResourceLimits, visionAiConfig.endpoint);
      const limitedTemporalVision = limitVisionQueue(needsTemporalVision, aiResourceLimits);
      if (limitedTemporalVision.length) {
        setNotice(`Vision AI is densely reviewing ${limitedTemporalVision.length} selected clip${limitedTemporalVision.length === 1 ? "" : "s"} before editing so the cut includes the payoff moment.`);
        try {
          await checkAiModel(visionAiConfig);
          const visionJob = await runPreprocess(
            project.id,
            visionAiConfig,
            {
              referenceStyle: prompt || "Professional gameplay trailer. Keep complete, game-specific high-value actions through their visible result or reaction. Reject irrelevant interface screens, inactivity, repetition, and footage that does not advance the event.",
              sampleInterval: Math.min(6, reviewProfile.sampleInterval),
              concurrency: reviewProfile.concurrency,
              maxFiles: limitedTemporalVision.length,
              maxFrames: limitedTemporalVision.length * reviewProfile.framesPerClip,
              refineReviewed: true,
              fileIds: limitedTemporalVision.map((file) => file.id)
            },
            setPreprocessJob,
            (cancel) => { cancelPreprocess.current = cancel; }
          );
          if (visionJob.result?.project) {
            workingProject = visionJob.result.project;
            setProject(workingProject);
            setRecordings(workingProject.files.map((file) => ({ ...file, type: "video", source: "recording" })));
            setAnalysis(workingProject.analysis || analysis);
          }
        } catch (error) {
          setGenerationAdvice("Generation will continue with saved analysis. For better clip timing, start Ollama and let Vision AI finish reviewing this folder.");
        }
      }
      const reviewedGenerationSource = selectedVideoIds.length
        ? workingProject.files.filter((file) => selectedVideoIds.includes(file.id))
        : workingProject.files.filter(isSelectableSourceClip);
      const usableEvents = reviewedGenerationSource.reduce((sum, file) =>
        sum + (file.metadata?.semanticEvents || []).filter((event) => event.payoffVerified === true).length, 0);
      const indexedCandidates = reviewedGenerationSource.reduce((sum, file) => sum + (file.metadata?.candidateWindows || []).length, 0);
      if (usableEvents < 3) {
        const uncertainCandidates = reviewedGenerationSource.reduce((sum, file) => sum + (file.metadata?.semanticCandidateHistory || []).length, 0);
        setGenerationAdvice(`AI verified ${usableEvents} complete highlight event${usableEvents === 1 ? "" : "s"} in the generation pool. Generation will auto-rank ${uncertainCandidates} AI uncertain candidate${uncertainCandidates === 1 ? "" : "s"} and ${indexedCandidates} indexed moment${indexedCandidates === 1 ? "" : "s"} instead of blocking for manual review.`);
      }
      const primary = await generateDraft(
        workingProject.id,
        {
          ...idea,
          durationMode: "auto",
          fileIds: generationVideoIds,
          music: selectedAudioAsset?.name || "Game audio only"
        } as VideoIdea,
        84,
        highlightSessionDiscards.map((item) => ({
          fileId: item.fileId,
          start: item.start,
          duration: item.duration
        }))
      );
      const primaryWithFileIds = primary.fileIds?.length ? primary : { ...primary, fileIds: generationVideoIds };
      const nextDrafts = [...drafts, primaryWithFileIds];
      setDrafts(nextDrafts);
      setProject((current) => current ? { ...current, drafts: [...current.drafts, primaryWithFileIds] } : current);
      setActiveDraft(nextDrafts.length - 1);
      setStage("drafts");
      await beginDraftSegmentReview(primaryWithFileIds, {
        ...workingProject,
        drafts: [...(workingProject.drafts || []), primaryWithFileIds]
      }, "AI planned the edit. Review each part, trim weak edges, reject bad cuts, then generate.");
    } catch (error) {
      const issue = issueFromError(error);
      setOperationIssue(issue);
      setNotice(`${issue.title}: ${issue.message}`);
    } finally {
      if (pausedFastIndexId) {
        void resumeFastIndexJob(pausedFastIndexId).then(setFastIndexJob).catch(() => undefined);
      }
      setGenerating(false);
    }
  }

  async function refineDraft(instruction: string) {
    if (!instruction.trim() || !drafts.length || !project) return;
    const normalized = instruction.toLowerCase();
    const draft = drafts[activeDraft];
    if (normalized.includes("music")) {
      setAssetBrowser(true);
      setNotice("Choose another soundtrack, then render the revised video.");
      return;
    }
    try {
      setBusy("Replanning the edit...");
      const updated = await updateDraft(project.id, draft.id, { instruction } as Partial<Draft>);
      setDrafts((current) => current.map((item, index) => index === activeDraft ? updated : item));
      setProject((current) => current ? { ...current, drafts: current.drafts.map((item) => item.id === updated.id ? updated : item) } : current);
      setPrompt("");
      setNotice(`Applied "${instruction}". Rendering the revised version in the background.`);
      void renderSpecificDraft(updated);
    } catch (error) {
      setNotice(noticeFromError(error, "Could not update the draft."));
    } finally {
      setBusy("");
    }
  }

  async function exportDraft() {
    if (!project || !drafts[activeDraft]) return;
    const draft = drafts[activeDraft];
    if (draft.exportUrl) {
      setPreviewVideo({ title: draft.title, url: localMediaUrl(draft.exportUrl), generated: true, localPath: draft.exportPath });
      return;
    }
    await renderSpecificDraft(draft);
  }

  async function renderSpecificDraft(draft: Draft, resumeFastIndexId = "") {
    if (!project) return;
    let pausedFastIndexId = resumeFastIndexId;
    try {
      if (!pausedFastIndexId && fastIndexJob?.status === "processing") {
        const paused = await pauseFastIndexJob(fastIndexJob.id);
        pausedFastIndexId = paused.id;
        setFastIndexJob(paused);
      }
      setRenderJob(null);
      const result = await renderDraft(project.id, draft.id, selectedAudioAsset?.id, visionAiConfig, (job) => {
        setRenderJob(job);
        cancelRender.current = () => {
          void cancelRenderJob(job.id).then(setRenderJob).catch(() => undefined);
        };
      }, musicRepeats);
      if ("needsReview" in result) {
        beginFinalReviewDecision(result.job, result.draft);
        return;
      }
      const usedFileIds = new Set([
        ...(result.draft.fileIds || []),
        ...(result.draft.segments || []).map((segment) => segment.fileId)
      ].filter(Boolean));
      const usedAt = new Date().toISOString();
      const markFileUsed = (file: MediaAsset): MediaAsset => {
        if (!usedFileIds.has(file.id) || !file.metadata) return file;
        return {
          ...file,
          metadata: {
            ...file.metadata,
            generationUseCount: Math.max(0, Number(file.metadata?.generationUseCount || 0)) + 1,
            generationLastUsedAt: usedAt
          }
        };
      };
      setDrafts((current) => current.some((item) => item.id === result.draft.id)
        ? current.map((item) => item.id === result.draft.id ? result.draft : item)
        : [...current, result.draft]);
      if (usedFileIds.size) setRecordings((current) => current.map(markFileUsed));
      setProject((current) => current ? {
        ...current,
        files: usedFileIds.size ? current.files.map(markFileUsed) : current.files,
        drafts: current.drafts.some((item) => item.id === result.draft.id)
          ? current.drafts.map((item) => item.id === result.draft.id ? result.draft : item)
          : [...current.drafts, result.draft]
      } : current);
      setNotice("Export complete. Your MP4 is ready.");
      setPreviewVideo({ title: result.draft.title, url: localMediaUrl(result.url), generated: true, localPath: result.localPath || result.draft.exportPath });
    } catch (error) {
      const issue = issueFromError(error);
      setOperationIssue(issue);
      setNotice(`${issue.title}: ${issue.message}`);
    } finally {
      if (pausedFastIndexId) {
        void resumeFastIndexJob(pausedFastIndexId).then(setFastIndexJob).catch(() => undefined);
      }
    }
  }

  async function reviewActiveDraft() {
    if (!project || !drafts[activeDraft]) return;
    const draft = drafts[activeDraft];
    if (!draft.exportUrl) {
      setNotice("Render the MP4 before running the AI review team.");
      return;
    }
    try {
      setBusy("AI review team is scoring the rendered draft...");
      const result = await reviewDraft(project.id, draft.id, visionAiConfig);
      setDrafts((current) => current.map((item, index) => index === activeDraft ? { ...item, review: result.review } : item));
      setNotice(result.review?.approved
        ? `AI review team approved this draft at ${result.review.averageScore}/100.`
        : `AI review team scored this draft ${result.review?.averageScore ?? 0}/100. Use the revision plan before final export.`);
    } catch (error) {
      setNotice(noticeFromError(error, "Could not run the AI review team."));
      setSettingsOpen(true);
    } finally {
      setBusy("");
    }
  }

  async function cycleStyle() {
    if (!project || !drafts[activeDraft]) return;
    const styles = ["Cinematic", "High energy", "Comedy"];
    const draft = drafts[activeDraft];
    const style = styles[(styles.indexOf(draft.style) + 1) % styles.length];
    try {
      setBusy(`Applying ${style} style...`);
      const updated = await updateDraft(project.id, draft.id, { style, changes: [...draft.changes, `${style} style selected`] });
      setDrafts((current) => current.map((item, index) => index === activeDraft ? updated : item));
      setNotice(`${style} style applied. Render again to create the updated MP4.`);
    } catch (error) {
      setNotice(noticeFromError(error, "Could not change style."));
    } finally {
      setBusy("");
    }
  }

  async function askAdvancedAi() {
    if (!project) return;
    try {
      setBusy("Asking your configured AI model...");
      setAdvancedAdvice(await requestAdvancedAdvice(project.id, textAiConfig, prompt || "Give general advice and recommend the best highlight style."));
      setPrompt("");
    } catch (error) {
      setNotice(noticeFromError(error, "Could not get advanced AI advice."));
      setSettingsOpen(true);
    } finally {
      setBusy("");
    }
  }

  async function runVisionReview() {
    if (!project) return;
    try {
      setBusy("AI is reviewing sampled gameplay frames...");
      const maxCandidates = aiResourceLimits.maxVideosPerRun > 0
        ? Math.min(24, Math.max(1, aiResourceLimits.maxVideosPerRun * aiResourceLimits.maxFramesPerVideo))
        : 24;
      const result = await requestVisionReview(project.id, visionAiConfig, prompt || "Professional cinematic game trailer with readable action and escalating spectacle", { maxCandidates });
      setProject(result.project);
      setAnalysis(result.project.analysis || analysis);
      setNotice(`AI reviewed ${result.reviewed} candidate frames and approved ${result.approved}.`);
    } catch (error) {
      setNotice(noticeFromError(error, "Could not run vision review."));
      setSettingsOpen(true);
    } finally {
      setBusy("");
    }
  }

  async function runVisionPreprocessPass(
    projectId: string,
    queue: MediaAsset[],
    reviewProfile: ReturnType<typeof effectiveVisionProfile>,
    referenceStyle: string,
    refineReviewed = false
  ) {
    return runPreprocess(
      projectId,
      visionAiConfig,
      {
        referenceStyle,
        sampleInterval: refineReviewed ? Math.min(6, reviewProfile.sampleInterval) : reviewProfile.sampleInterval,
        concurrency: reviewProfile.concurrency,
        maxFiles: queue.length,
        maxFrames: queue.length * reviewProfile.framesPerClip,
        refineReviewed,
        fileIds: queue.map((file) => file.id)
      },
      setPreprocessJob,
      (cancel) => { cancelPreprocess.current = cancel; }
    );
  }

  async function checkConfiguredModel(kind: "vision" | "text") {
    const config = kind === "vision" ? visionAiConfig : textAiConfig;
    setModelTestState((current) => ({ ...current, [kind]: { state: "testing", message: "Connecting to the configured endpoint..." } }));
    try {
      const status = await checkAiModel(config);
      if (kind === "vision") setVisionModelStatus(status);
      else setTextModelStatus(status);
      setModelTestState((current) => ({ ...current, [kind]: { state: "success", message: `Connected to ${status.model} in ${(status.latencyMs / 1000).toFixed(1)}s.` } }));
    } catch (error) {
      if (kind === "vision") setVisionModelStatus(null);
      else setTextModelStatus(null);
      const issue = issueFromError(error);
      setModelTestState((current) => ({ ...current, [kind]: { state: "error", message: `${issue.message}${issue.action ? ` ${issue.action}` : ""}` } }));
    }
  }

  async function checkOllamaAndRetry() {
    setModelTestState((current) => ({
      ...current,
      vision: { state: "testing", message: "Checking the local Ollama service..." }
    }));
    try {
      const status = await checkAiModel(visionAiConfig);
      setVisionModelStatus(status);
      setModelTestState((current) => ({
        ...current,
        vision: { state: "success", message: `Connected to ${status.model} in ${(status.latencyMs / 1000).toFixed(1)}s.` }
      }));
      autoAiAttempt.current = "";
      setAutoAiStatus({ state: "waiting", message: "Ollama is ready. Automatic Vision AI analysis is resuming." });
      setAutoAiRetry((current) => current + 1);
      setNotice("Ollama is connected. Automatic Vision AI analysis is resuming.");
    } catch (error) {
      const issue = issueFromError(error);
      const message = `${issue.message}${issue.action ? ` ${issue.action}` : ""}`;
      setVisionModelStatus(null);
      setModelTestState((current) => ({
        ...current,
        vision: { state: "error", message }
      }));
      setAutoAiStatus({ state: "error", message });
    }
  }

  async function analyzeSelectedWithVision() {
    if (!project || !selectedVideoIds.length) {
      setNotice("Select clips first, then run Vision AI.");
      return;
    }
    try {
      setPreprocessJob(null);
      await checkAiModel(visionAiConfig);
      let workingProject = project;
      const reviewProfile = effectiveVisionProfile(visionReviewMode, aiResourceLimits, visionAiConfig.endpoint);
      const selectedFilesForVision = project.files.filter((file) => selectedVideoIds.includes(file.id));
      let totalEventsFound = 0;
      const firstPassQueue = limitVisionQueue(initialVisionCandidates(selectedFilesForVision), aiResourceLimits);
      if (firstPassQueue.length) {
        const job = await runVisionPreprocessPass(
          workingProject.id,
          firstPassQueue,
          reviewProfile,
          prompt || "Find complete rare gameplay highlights. Preserve game-specific setup, decisive action, visible result, and reaction. Reject irrelevant interface screens, inactivity, repetition, and incomplete events."
        );
        totalEventsFound += job.eventsFound || 0;
        if (job.result?.project) workingProject = job.result.project;
      }
      const timelineQueue = limitVisionQueue(
        timelineVisionCandidates(workingProject.files.filter((file) => selectedVideoIds.includes(file.id))),
        aiResourceLimits
      );
      if (timelineQueue.length) {
        const job = await runVisionPreprocessPass(
          workingProject.id,
          timelineQueue,
          reviewProfile,
          prompt || "Recheck the selected clips' potential highlight timelines and only verify complete visible payoffs.",
          true
        );
        totalEventsFound += job.eventsFound || 0;
        if (job.result?.project) workingProject = job.result.project;
      }
      setProject(workingProject);
      setRecordings(workingProject.files.map((file) => ({ ...file, type: "video", source: "recording" })));
      setAnalysis(workingProject.analysis || analysis);
      setNotice(`Vision AI indexed ${totalEventsFound} complete highlight event${totalEventsFound === 1 ? "" : "s"} in the selected clips.`);
    } catch (error) {
      const issue = issueFromError(error);
      setOperationIssue(issue);
      setNotice(`${issue.title}: ${issue.message}`);
      if (!visionModelStatus) setSettingsOpen(true);
    }
  }

  async function runVisionCheckService() {
    if (!project) return;
    const candidates = visionReviewCandidates(project.files);
    if (!candidates.length) {
      setNotice("There are no clips waiting for another Vision AI check.");
      return;
    }
    try {
      setPreprocessJob(null);
      setAutoAiStatus({ state: "waiting", message: "Checking the configured Vision AI model..." });
      await checkAiModel(visionAiConfig);
      let workingProject = project;
      const reviewProfile = effectiveVisionProfile(visionReviewMode, aiResourceLimits, visionAiConfig.endpoint);
      let totalEventsFound = 0;
      const firstPassQueue = limitVisionQueue(initialVisionCandidates(workingProject.files), aiResourceLimits);
      if (firstPassQueue.length) {
        setAutoAiStatus({ state: "vision", message: `Vision AI is checking ${firstPassQueue.length} videos in the background.` });
        const job = await runVisionPreprocessPass(
          workingProject.id,
          firstPassQueue,
          reviewProfile,
          prompt || "Find complete gameplay highlights. Preserve setup, decisive action, visible result, and reaction. If the sampled frames do not prove the result, mark the clip uncertain instead of guessing."
        );
        totalEventsFound += job.eventsFound || 0;
        if (job.result?.project) {
          workingProject = job.result.project;
        }
        setProject(workingProject);
        setRecordings(workingProject.files.map((file) => ({ ...file, type: "video", source: "recording" })));
        setAnalysis(workingProject.analysis || analysis);
        setRecentProjects((current) => current.map((item) => item.id === workingProject.id ? workingProject : item));
        if (job.status === "completed_with_warnings" && job.failures.length) {
          const pendingReview = visionReviewCandidates(workingProject.files).length;
          setAutoAiStatus({
            state: "error",
            message: `Vision AI stopped because the model failed during review. ${pendingReview} videos are still pending review. Check Ollama, then run Vision AI check again.`
          });
          setNotice(`Vision AI stopped because the model failed. ${pendingReview} videos are still pending review.`);
          return;
        }
      }
      const timelineQueue = limitVisionQueue(timelineVisionCandidates(workingProject.files), aiResourceLimits);
      if (timelineQueue.length) {
        setAutoAiStatus({ state: "vision", message: `Vision AI is rechecking ${timelineQueue.length} potential highlight timeline${timelineQueue.length === 1 ? "" : "s"}.` });
        const job = await runVisionPreprocessPass(
          workingProject.id,
          timelineQueue,
          reviewProfile,
          prompt || "Recheck only the supplied potential highlight timelines. Confirm setup, decisive action, visible result, and reaction before marking a clip verified.",
          true
        );
        totalEventsFound += job.eventsFound || 0;
        if (job.result?.project) {
          workingProject = job.result.project;
        }
        setProject(workingProject);
        setRecordings(workingProject.files.map((file) => ({ ...file, type: "video", source: "recording" })));
        setAnalysis(workingProject.analysis || analysis);
        setRecentProjects((current) => current.map((item) => item.id === workingProject.id ? workingProject : item));
        if (job.status === "completed_with_warnings" && job.failures.length) {
          const pendingReview = visionReviewCandidates(workingProject.files).length;
          setAutoAiStatus({
            state: "error",
            message: `Vision AI stopped during timeline recheck. ${pendingReview} videos are still pending review. Check Ollama, then run Vision AI check again.`
          });
          setNotice(`Vision AI stopped during timeline recheck. ${pendingReview} videos are still pending review.`);
          return;
        }
      }
      const pendingReview = visionReviewCandidates(workingProject.files).length;
      autoAiAttempt.current = "";
      setAutoAiRetry((current) => current + 1);
      setAutoAiStatus({
        state: pendingReview ? "waiting" : "complete",
        message: pendingReview
          ? `Vision AI stopped before folder review finished. ${pendingReview} videos are still pending review.`
          : `Vision AI finished reviewing the folder. ${totalEventsFound} new highlight event${totalEventsFound === 1 ? "" : "s"} indexed.`
      });
      setNotice(pendingReview
        ? `Vision AI stopped with ${pendingReview} videos still pending review.`
        : `Vision AI folder review complete. Verified ${totalEventsFound} highlight event${totalEventsFound === 1 ? "" : "s"}.`);
    } catch (error) {
      const issue = issueFromError(error);
      setAutoAiStatus({ state: "error", message: `${issue.message}${issue.action ? ` ${issue.action}` : ""}` });
      setOperationIssue(issue);
      setNotice(`${issue.title}: ${issue.message}`);
    }
  }

  async function startSemanticPreprocess() {
    if (!project) return;
    try {
      setPreprocessJob(null);
      const reviewProfile = effectiveVisionProfile(visionReviewMode, aiResourceLimits, visionAiConfig.endpoint);
      const queue = limitVisionQueue(initialVisionCandidates(project.files), aiResourceLimits);
      if (!queue.length) {
        setNotice("There are no clips waiting for a first Vision AI preprocess pass.");
        return;
      }
      const maxFiles = queue.length;
      const job = await runPreprocess(
        project.id,
        visionAiConfig,
        {
          referenceStyle: prompt || "Create a high quality gameplay highlight with readable action, complete payoffs, variety, and no menus or scoreboards.",
          sampleInterval: Math.min(6, reviewProfile.sampleInterval),
          concurrency: reviewProfile.concurrency,
          maxFiles,
          maxFrames: maxFiles * reviewProfile.framesPerClip,
          fileIds: queue.map((file) => file.id)
        },
        setPreprocessJob,
        (cancel) => { cancelPreprocess.current = cancel; }
      );
      const reviewedProject = job.result?.project;
      if (reviewedProject) {
        setProject(reviewedProject);
        setRecordings(reviewedProject.files.map((file) => ({ ...file, type: "video", source: "recording" })));
        setAnalysis(reviewedProject.analysis || analysis);
        setSelectedVideoIds((current) => current.filter((id) => {
          const file = reviewedProject.files.find((item) => item.id === id);
          return file && isSelectableSourceClip(file);
        }));
      }
      setNotice(`AI preprocessing complete. Found ${job.eventsFound} usable action event${job.eventsFound === 1 ? "" : "s"}.`);
    } catch (error) {
      setNotice(noticeFromError(error, "AI preprocessing stopped."));
    }
  }

  async function startFastIndex() {
    if (!project) return;
    try {
      setFastIndexJob(null);
      const job = await runFastIndex(
        project.id,
        { concurrency: 3, maxWindowsPerFile: 6, windowDuration: 14 },
        setFastIndexJob,
        (cancel) => { cancelFastIndex.current = cancel; }
      );
      const indexedProject = job.result?.project;
      if (indexedProject) {
        setProject(indexedProject);
        setRecordings(indexedProject.files.map((file) => ({ ...file, type: "video", source: "recording" })));
        setAnalysis(indexedProject.analysis || analysis);
        setSelectedVideoIds((current) => current.filter((id) => {
          const file = indexedProject.files.find((item) => item.id === id);
          return file && isSelectableSourceClip(file);
        }));
      }
      setNotice(`Fast index complete. Stored ${job.candidateWindows} reusable candidate windows.`);
    } catch (error) {
      setNotice(noticeFromError(error, "Fast index stopped."));
    }
  }

  function stopFastIndex() {
    cancelFastIndex.current();
    setNotice("Fast index cancellation requested. Completed candidate windows are preserved when the job finishes cleanly.");
  }

  async function toggleFastIndexPause() {
    if (!fastIndexJob) return;
    const previous = fastIndexJob;
    const pausing = previous.status !== "paused";
    setPausePending((current) => ({ ...current, "fast-index": true }));
    setFastIndexJob({ ...previous, status: pausing ? "paused" : "processing", phase: pausing ? "paused" : "scanning" });
    setNotice(pausing ? "Pausing fast index..." : "Resuming fast index...");
    try {
      const next = pausing ? await pauseFastIndexJob(previous.id) : await resumeFastIndexJob(previous.id);
      setFastIndexJob(next);
      setNotice(next.status === "paused" ? "Fast index paused. Completed files are saved." : "Fast index resumed.");
    } catch (error) {
      setFastIndexJob(previous);
      setNotice(noticeFromError(error, "Could not change the fast index state."));
    } finally {
      setPausePending((current) => ({ ...current, "fast-index": false }));
    }
  }

  function toggleVideoSelection(id: string) {
    const file = project?.files.find((item) => item.id === id);
    if (file && looksLikeGeneratedExport(file.name)) {
      setNotice("Generated exports are shown for visibility, but they are not selectable as source footage.");
      return;
    }
   setGenerationAdvice("");
    setSelectedVideoIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      return [...current, id];
    });
  }

  function selectDiversifiedClips() {
    if (!project) return;
    const next = chooseDiversifiedClips(rankedLibrary, luckySelectionHistory.current);
    luckySelectionHistory.current = [...luckySelectionHistory.current.slice(-2), next];
    setGenerationAdvice("");
    setSelectedVideoIds(next);
    setNotice(`Selected ${next.length} high-rated clips with a new mix of game-specific actions and subjects.`);
  }

  function selectFirstTwentyClips() {
    const eligible = visibleLibrary
      .filter(isSelectableSourceClip)
      .slice(0, 20)
      .map((file) => file.id);
    setGenerationAdvice("");
    setSelectedVideoIds(eligible);
    setNotice(`Selected the top ${eligible.length} matching clip${eligible.length === 1 ? "" : "s"}. You can still add more before generating.`);
  }

  function selectVisibleClips() {
    const next = visibleLibrary
      .filter(isSelectableSourceClip)
      .map((file) => file.id);
    setGenerationAdvice("");
    setSelectedVideoIds(next);
    setNotice(`Selected all ${next.length} visible clip${next.length === 1 ? "" : "s"}. AI will pick the strongest moments during generation.`);
  }

  function clearSelection() {
    setGenerationAdvice("");
    setSelectedVideoIds([]);
    setHighlightSessionDiscards([]);
    setNotice("Clip selection cleared.");
  }

  function startHighlightReview() {
    const items = reviewHighlightMoments;
    if (!items.length) {
      if (reviewConfirmedHighlightParts.length) {
        setHighlightReview(makeHighlightReviewSession([], { total: 0, reviewed: 0, confirmed: reviewConfirmedHighlightParts.length }));
        setHighlightTrim(null);
        navigateToReviewPage();
        setNotice("All saved highlight parts are already confirmed. Use Reconfirm only if you need to change one.");
        return;
      }
      setNotice("No AI uncertain or potential highlight periods are available for review yet.");
      return;
    }
    beginHighlightReview(
      items,
      aiUncertainReviewMoments.length
        ? `Optional review: checking the top ${items.length} low-confidence AI pick${items.length === 1 ? "" : "s"}. Generation can continue without this.`
        : `Optional review: checking ${items.length} highlight moment${items.length === 1 ? "" : "s"}. Trim only the parts you want to improve.`
    );
  }

  function addMoreHighlightCandidates() {
    const existing = highlightReview?.items || [];
    const activeDraftScopeIds = new Set(
      reviewingPlannedDraft
        ? (drafts.find((draft) => draft.id === pendingReviewDraftId)?.fileIds || existing.map((item) => item.file.id))
        : []
    );
    const scopedLibrary = reviewingPlannedDraft && activeDraftScopeIds.size
      ? rankedLibrary.filter((file) => activeDraftScopeIds.has(file.id))
      : rankedLibrary;
    const savedVerifiedItems = reviewingPlannedDraft
      ? scopedLibrary
        .flatMap((file) => (file.metadata?.confirmedHighlightMoments || []).map((moment) => confirmedMomentToReviewItem(file, moment)))
        .filter((item) => !isDuplicateReviewItem(item, existing))
      : [];
    const candidatePool = reviewingPlannedDraft
      ? optionalReviewItems(scopedLibrary, 40)
      : reviewHighlightMoments;
    const pendingItems = candidatePool.filter((item) =>
      !isDuplicateReviewItem(item, existing) &&
      !savedVerifiedItems.some((candidate) => candidate.file.id === item.file.id)
    );
    const additions = [...savedVerifiedItems, ...pendingItems].slice(0, 10);
    if (!additions.length) {
      setNotice("There are no more unique highlight parts to add. Choose more footage or use a shorter soundtrack.");
      return;
    }
    if (!highlightReview) {
      beginHighlightReview(additions, `Added ${additions.length} more highlight part${additions.length === 1 ? "" : "s"} to review.`);
      return;
    }
    const nextItems = [...existing, ...additions];
    const firstPendingAddition = additions.find((item) => !item.confirmed) || additions[0];
    const nextIndex = Math.max(0, nextItems.findIndex((item) => item.id === firstPendingAddition.id));
    setHighlightReview(makeHighlightReviewSession(nextItems, {
      index: nextIndex,
      total: highlightReview.total + additions.length
    }));
    setHighlightTrim(firstPendingAddition ? { start: firstPendingAddition.start, end: firstPendingAddition.end } : null);
    setReviewMusicCoveragePrompt(null);
    setReviewGeneratePrompt(false);
    setReviewGeneratePromptDismissed(false);
    setNotice(`Added ${additions.length} more unique highlight part${additions.length === 1 ? "" : "s"} without removing your approved picks.`);
  }

  function moveHighlightReview(delta: number) {
    setHighlightReview((current) => {
      if (!current) return current;
      const index = Math.max(0, Math.min(current.items.length - 1, current.index + delta));
      return { ...current, index };
    });
  }

  function updateHighlightTrim(part: "start" | "end", value: number) {
    const item = highlightReview?.items[highlightReview.index];
    if (!item) return;
    if (highlightReviewFrame.current !== null) {
      window.cancelAnimationFrame(highlightReviewFrame.current);
      highlightReviewFrame.current = null;
    }
    setHighlightReviewPlaying(false);
    setHighlightTrim((current) => {
      const base = current || { start: item.start, end: item.end };
      const minGap = 1;
      const duration = Math.max(minGap, Number(item.file.metadata?.duration || item.end || minGap));
      const next = { ...base, [part]: value };
      next.start = Math.max(0, Math.min(next.start, duration - minGap));
      next.end = Math.max(minGap, Math.min(next.end, duration));
      if (next.end - next.start < minGap) {
        if (part === "start") {
          next.end = Math.min(duration, next.start + minGap);
          if (next.end - next.start < minGap) next.start = Math.max(0, next.end - minGap);
        } else {
          next.start = Math.max(0, next.end - minGap);
        }
      }
      const video = highlightReviewVideo.current;
      if (video) {
        if (!video.paused) video.pause();
        video.currentTime = part === "start" ? next.start : next.end;
      }
      return {
        start: Math.round(next.start * 10) / 10,
        end: Math.round(next.end * 10) / 10
      };
    });
  }

  function clearHighlightPlaybackGuard() {
    if (highlightReviewFrame.current === null) return;
    window.cancelAnimationFrame(highlightReviewFrame.current);
    highlightReviewFrame.current = null;
  }

  function pauseHighlightAtPeriodEnd(end: number) {
    const video = highlightReviewVideo.current;
    clearHighlightPlaybackGuard();
    if (video) {
      video.pause();
      video.currentTime = end;
    }
    setHighlightReviewPlaying(false);
  }

  function guardHighlightPlaybackEnd(end: number) {
    clearHighlightPlaybackGuard();
    const tick = () => {
      const video = highlightReviewVideo.current;
      if (!video || video.paused || video.ended) {
        highlightReviewFrame.current = null;
        setHighlightReviewPlaying(false);
        return;
      }
      if (video.currentTime >= end - 0.04) {
        pauseHighlightAtPeriodEnd(end);
        return;
      }
      highlightReviewFrame.current = window.requestAnimationFrame(tick);
    };
    highlightReviewFrame.current = window.requestAnimationFrame(tick);
  }

  function playHighlightReview() {
    const item = highlightReview?.items[highlightReview.index];
    const trim = highlightTrim || (item ? { start: item.start, end: item.end } : null);
    const video = highlightReviewVideo.current;
    if (!item || !trim || !video) return;
    video.currentTime = trim.start;
    setHighlightReviewPlaying(true);
    void video.play()
      .then(() => guardHighlightPlaybackEnd(trim.end))
      .catch(() => setHighlightReviewPlaying(false));
  }

  function stopHighlightReview() {
    const item = highlightReview?.items[highlightReview.index];
    const trim = highlightTrim || (item ? { start: item.start, end: item.end } : null);
    const video = highlightReviewVideo.current;
    if (!video || !trim) return;
    clearHighlightPlaybackGuard();
    video.pause();
    video.currentTime = trim.start;
    setHighlightReviewPlaying(false);
  }

  function handleHighlightReviewTime() {
    const item = highlightReview?.items[highlightReview.index];
    const trim = highlightTrim || (item ? { start: item.start, end: item.end } : null);
    const video = highlightReviewVideo.current;
    if (!video || !trim) return;
    if (video.currentTime >= trim.end) {
      pauseHighlightAtPeriodEnd(trim.end);
    }
  }

  async function confirmCurrentHighlight() {
    if (!project || !highlightReview) return;
    const item = highlightReview.items[highlightReview.index];
    const trim = highlightTrim || { start: item.start, end: item.end };
    try {
      const next = await confirmHighlightMoment(project.id, item.file.id, {
        start: trim.start,
        end: trim.end,
        score: item.score,
        state: item.state,
        action: item.action,
        storyRole: item.storyRole,
        source: item.source,
        replaceStart: item.start,
        replaceEnd: item.end
      });
      setProject(next);
      setRecordings(next.files.map((file) => ({ ...file, type: "video", source: "recording" })));
      setRecentProjects((current) => current.map((candidate) => candidate.id === next.id ? next : candidate));
      setHighlightReview((current) => {
        if (!current) return current;
        const items = current.items.map((candidate, index) => index === current.index ? {
          ...candidate,
          start: trim.start,
          end: trim.end,
          duration: trim.end - trim.start,
          confirmed: true,
          reviewed: true
        } : candidate);
        const wasReviewed = Boolean(current.items[current.index]?.reviewed);
        const wasConfirmed = Boolean(current.items[current.index]?.confirmed);
        return makeHighlightReviewSession(items, {
          index: Math.min(current.index + 1, items.length - 1),
          total: current.total,
          reviewed: current.reviewed + (wasReviewed ? 0 : 1),
          confirmed: current.confirmed + (wasConfirmed ? 0 : 1)
        });
      });
      setNotice("Confirmed highlight period saved. Future generation will prioritize it.");
    } catch (error) {
      const issue = issueFromError(error);
      setOperationIssue(issue);
      setNotice(`${issue.title}: ${issue.message}`);
    }
  }

  function reconfirmHighlightPart(file: MediaAsset, moment: ConfirmedHighlightMoment) {
    const duration = Number(file.metadata?.duration || moment.end || 0);
    const start = Math.max(0, Math.min(duration, Number(moment.start) || 0));
    const end = Math.max(start + 1, Math.min(duration, Number(moment.end) || start + Number(moment.duration || 0) || start + 1));
    const item: HighlightReviewItem = {
      id: `${file.id}:reconfirm:${Math.round(start * 10)}:${Math.round(end * 10)}`,
      file,
      start,
      end,
      duration: end - start,
      score: Math.round(Number(moment.score) || Number(file.metadata?.semanticScore) || Number(file.metadata?.indexScore) || 75),
      state: moment.state || "human-confirmed",
      action: moment.action || "confirmed highlight",
      storyRole: moment.storyRole || "payoff",
      source: moment.source || "human-confirmed",
      label: "Reconfirm picked part",
      confidence: "high",
      confirmed: true
    };
    setHighlightReview(makeHighlightReviewSession([item], { confirmed: 1 }));
    setHighlightTrim({ start, end });
    navigateToReviewPage();
    setNotice("Adjust the picked highlight part, then confirm again to update the saved time.");
  }

  function viewConfirmedHighlightPart(file: MediaAsset, moment: ConfirmedHighlightMoment) {
    reconfirmHighlightPart(file, moment);
    setNotice("Previewing the saved highlight period. Use Reconfirm only if you need to change it.");
  }

  function viewHighlightReviewCandidate(item: HighlightReviewItem) {
    setHighlightReview((current) => {
      const existingIndex = current?.items.findIndex((candidate) => candidate.id === item.id) ?? -1;
      if (current && existingIndex >= 0) {
        return { ...current, index: existingIndex };
      }
      return makeHighlightReviewSession([item], { total: current?.total || 1 });
    });
    setHighlightTrim({ start: item.start, end: item.end });
    navigateToReviewPage();
    setNotice("Review this AI uncertain period, adjust it if needed, then agree or reject it.");
  }

  async function removeConfirmedHighlightPart(file: MediaAsset, moment: ConfirmedHighlightMoment) {
    if (!project) return;
    try {
      const next = await removeHighlightConfirmation(project.id, file.id, {
        start: moment.start,
        end: moment.end
      });
      setProject(next);
      setRecordings(next.files.map((item) => ({ ...item, type: "video", source: "recording" })));
      setRecentProjects((current) => current.map((candidate) => candidate.id === next.id ? next : candidate));
      setNotice("Removed the confirmed highlight period. It can still appear as a candidate unless you mark it not a highlight.");
    } catch (error) {
      const issue = issueFromError(error);
      setOperationIssue(issue);
      setNotice(`${issue.title}: ${issue.message}`);
    }
  }

  function advanceOrCloseHighlightReview(items: HighlightReviewItem[], currentIndex: number, progress: { reviewed?: number; confirmed?: number } = {}) {
    if (!items.length) {
      setHighlightReview((current) => makeHighlightReviewSession([], {
        total: current?.total || 0,
        reviewed: progress.reviewed ?? current?.reviewed ?? 0,
        confirmed: progress.confirmed ?? current?.confirmed ?? 0
      }));
      setHighlightTrim(null);
      setHighlightReviewPlaying(false);
      return;
    }
    setHighlightReview((current) => makeHighlightReviewSession(items, {
      index: Math.min(currentIndex, items.length - 1),
      total: current?.total || items.length,
      reviewed: progress.reviewed ?? current?.reviewed ?? 0,
      confirmed: progress.confirmed ?? current?.confirmed ?? 0
    }));
  }

  async function generateFromHighlightReview() {
    if (pendingReviewDraftId) {
      if (!project || !highlightReview) return;
      const draft = drafts.find((item) => item.id === pendingReviewDraftId) || project.drafts.find((item) => item.id === pendingReviewDraftId);
      if (!draft) {
        setNotice("The planned draft could not be found. Create the draft again.");
        return;
      }
      const segments = approvedSegmentsForReviewDraft(draft, highlightReview, project.files);
      if (!segments.length) {
        setNotice("Agree to at least one planned part before generating. Rejected and skipped parts will not be used.");
        return;
      }
      const duration = totalSegmentDuration(segments);
      const musicDuration = effectiveMusicDuration(selectedAudioAsset, musicRepeats);
      if (selectedAudioAsset && musicDuration > 0 && duration + 0.5 < musicDuration) {
        setReviewGeneratePrompt(false);
        setReviewGeneratePromptDismissed(false);
        setReviewMusicCoveragePrompt({
          clipDuration: duration,
          musicDuration,
          musicName: selectedAudioAsset.name,
          clipCount: new Set(segments.map((segment) => segment.fileId)).size
        });
        setNotice("The reviewed highlight parts are shorter than the soundtrack. Add more parts before generating for a stronger edit.");
        return;
      }
      setReviewMusicCoveragePrompt(null);
      try {
        setReviewGeneratePrompt(false);
        setReviewGeneratePromptDismissed(false);
        setGenerating(true);
        setRenderJob(null);
        setOperationIssue(null);
        const updated = await updateDraft(project.id, draft.id, {
          segments,
          duration,
          status: "ready",
          reviewedFileIds: [...new Set([...(draft.fileIds || []), ...highlightReview.items.map((item) => item.file.id)])],
          changes: [...(draft.changes || []), "User reviewed and approved planned cuts before rendering"]
        } as Partial<Draft> & { reviewedFileIds: string[] });
        setDrafts((current) => current.map((item) => item.id === updated.id ? updated : item));
        const reviewedIds = new Set([...(draft.fileIds || []), ...highlightReview.items.map((item) => item.file.id)]);
        setProject((current) => current ? {
          ...current,
          files: current.files.map((file) => reviewedIds.has(file.id) ? {
            ...file,
            metadata: file.metadata ? { ...file.metadata, reviewed: true, reviewedAt: file.metadata.reviewedAt || new Date().toISOString() } : file.metadata
          } : file),
          drafts: current.drafts.map((item) => item.id === updated.id ? updated : item)
        } : current);
        setActiveDraft(Math.max(0, drafts.findIndex((item) => item.id === updated.id)));
        setHighlightReview(null);
        setHighlightTrim(null);
        setPendingReviewDraftId("");
        setPendingHighlightGenerateIdea(null);
        navigateToDashboard();
        setNotice("Approved cuts saved. Rendering the reviewed video now.");
        await renderSpecificDraft(updated);
      } catch (error) {
        const issue = issueFromError(error);
        setOperationIssue(issue);
        setNotice(`${issue.title}: ${issue.message}`);
      } finally {
        setGenerating(false);
      }
      return;
    }
    if (!recommendedIdea) return;
    const idea = pendingHighlightGenerateIdea || recommendedIdea;
    setHighlightReview(null);
    setPendingHighlightGenerateIdea(null);
    navigateToDashboard();
    await createDraft(idea);
  }

  async function skipCurrentHighlightThisTime() {
    if (!project || !highlightReview) return;
    const item = highlightReview.items[highlightReview.index];
    try {
      const next = await markHighlightReviewed(project.id, item.file.id, true);
      setProject(next);
      setRecordings(next.files.map((file) => ({ ...file, type: "video", source: "recording" })));
      setRecentProjects((current) => current.map((candidate) => candidate.id === next.id ? next : candidate));
      setHighlightSessionDiscards((current) => [
        ...current,
        {
          fileId: item.file.id,
          start: item.start,
          end: item.end,
          duration: item.end - item.start,
          source: item.source,
          reason: "skip-this-time"
        }
      ]);
      const items = highlightReview.items.filter((candidate, index) => index !== highlightReview.index && candidate.file.id !== item.file.id);
      advanceOrCloseHighlightReview(items, highlightReview.index, { reviewed: highlightReview.reviewed + (item.reviewed ? 0 : 1) });
      setNotice("Marked this clip reviewed. It will not appear in future review queues.");
    } catch (error) {
      const issue = issueFromError(error);
      setOperationIssue(issue);
      setNotice(`${issue.title}: ${issue.message}`);
    }
  }

  async function rejectCurrentHighlightAsNotHighlight() {
    if (!project || !highlightReview) return;
    const item = highlightReview.items[highlightReview.index];
    try {
      const next = await rejectHighlightMoment(project.id, item.file.id, {
        start: item.start,
        end: item.end,
        source: item.source,
        reason: "not-highlight"
      });
      setProject(next);
      setRecordings(next.files.map((file) => ({ ...file, type: "video", source: "recording" })));
      setRecentProjects((current) => current.map((candidate) => candidate.id === next.id ? next : candidate));
      const items = highlightReview.items.filter((candidate) =>
        candidate.file.id !== item.file.id ||
        Math.max(candidate.start, item.start) >= Math.min(candidate.end, item.end) - 0.75
      );
      advanceOrCloseHighlightReview(items, highlightReview.index, { reviewed: highlightReview.reviewed + (item.reviewed ? 0 : 1) });
      setNotice("Marked as not a highlight. This period will not be shown or used again.");
    } catch (error) {
      const issue = issueFromError(error);
      setOperationIssue(issue);
      setNotice(`${issue.title}: ${issue.message}`);
    }
  }

  function openMusicBrowser() {
    setAssetBrowser(true);
    if (!publicAudio.length) void searchPublicAssets();
  }

  function stopSemanticPreprocess() {
    cancelPreprocess.current();
    setNotice("AI preprocessing cancellation requested. Completed video reviews are preserved.");
  }

  async function toggleSemanticPause() {
    if (!preprocessJob) return;
    const previous = preprocessJob;
    const pausing = previous.status !== "paused";
    setPausePending((current) => ({ ...current, vision: true }));
    setPreprocessJob({ ...previous, status: pausing ? "paused" : "processing", phase: pausing ? "paused" : "extracting_frames" });
    setAutoAiStatus({
      state: pausing ? "waiting" : "vision",
      message: pausing ? "Pausing Vision AI..." : "Resuming Vision AI..."
    });
    try {
      const next = pausing ? await pausePreprocessJob(previous.id) : await resumePreprocessJob(previous.id);
      setPreprocessJob(next);
      setAutoAiStatus({
        state: next.status === "paused" ? "waiting" : "vision",
        message: next.status === "paused"
          ? "Vision AI is paused. Completed clip reviews are saved."
          : "Vision AI resumed from saved clip reviews."
      });
      setNotice(next.status === "paused" ? "Vision AI paused and the active Ollama request was stopped." : "Vision AI resumed.");
    } catch (error) {
      setPreprocessJob(previous);
      const message = noticeFromError(error, "Could not change the Vision AI state.");
      setAutoAiStatus({ state: "error", message });
      setNotice(message);
    } finally {
      setPausePending((current) => ({ ...current, vision: false }));
    }
  }

  async function toggleRenderPause() {
    if (!renderJob) return;
    const previous = renderJob;
    const pausing = previous.status !== "paused";
    setPausePending((current) => ({ ...current, render: true }));
    setRenderJob({
      ...previous,
      status: pausing ? "paused" : "queued",
      phase: pausing ? "paused" : "queued",
      message: pausing ? "Render paused. Resume restarts encoding from the saved draft." : "Render queued to resume"
    });
    setNotice(pausing ? "Pausing render..." : "Resuming render...");
    try {
      const next = pausing ? await pauseRenderJob(previous.id) : await resumeRenderJob(previous.id);
      setRenderJob(next);
      setNotice(next.status === "paused"
        ? "Render paused. Resume will restart encoding from the saved draft."
        : "Render resumed.");
    } catch (error) {
      setRenderJob(previous);
      setNotice(noticeFromError(error, "Could not change the render state."));
    } finally {
      setPausePending((current) => ({ ...current, render: false }));
    }
  }

  function saveSettings() {
    localStorage.setItem("highlight-ai-vision-provider", JSON.stringify(visionAiConfig));
    localStorage.setItem("highlight-ai-text-provider", JSON.stringify(textAiConfig));
    localStorage.setItem("highlight-ai-vision-review-mode", visionReviewMode);
    localStorage.setItem("highlight-ai-resource-limits", JSON.stringify(aiResourceLimits));
    autoAiAttempt.current = "";
    setAutoAiRetry((current) => current + 1);
    if (project) setAutoAiStatus({ state: "waiting", message: "Updated AI settings saved. Automatic background analysis will retry." });
    setSettingsOpen(false);
    setNotice("Vision and text model settings saved locally.");
  }

  function stopGeneration() {
    if (renderJob && ["queued", "processing", "paused"].includes(renderJob.status)) {
      cancelRender.current();
      setNotice("Render cancellation requested. The draft and selected clips are preserved.");
      return;
    }
    cancelPreprocess.current();
    setNotice("Vision analysis cancellation requested. Completed reviews are preserved.");
  }

  function reset() {
    navigateToDashboard();
    setStage("start");
    setRecordings([]);
    setProject(null);
    setAnalysis(null);
    setDrafts([]);
    setNotice("");
    setPendingFiles([]);
    setIngestProgress(null);
    setFastIndexEstimate(null);
    setFastIndexJob(null);
    setPreprocessEstimate(null);
    setPreprocessJob(null);
    setSelectedVideoIds([]);
    setSelectedAudioAssetId("");
    setMusicRepeats(1);
    setHighlightReview(null);
    setHighlightReviewPlaying(false);
    setHighlightTrim(null);
    setHighlightSessionDiscards([]);
    setPendingHighlightGenerateIdea(null);
    setPendingReviewDraftId("");
    setReviewGeneratePrompt(false);
    setReviewGeneratePromptDismissed(false);
    setVisionModelStatus(null);
    setTextModelStatus(null);
    setOperationIssue(null);
    setGenerationAdvice("");
    setRenderJob(null);
    setAutoAiStatus({ state: "idle", message: "" });
    autoAiAttempt.current = "";
  }

  const selectedBytes = pendingFiles.reduce((sum, file) => sum + file.size, 0) || ingestProgress?.totalBytes || 0;
  const uploadBytes = (ingestProgress?.uploadedBytes || 0) + (ingestProgress?.activeFileBytes || 0);
  const ingestPercent = ingestProgress?.phase === "probing"
    ? Math.min(100, Math.round(((ingestProgress.uploadedFiles + ingestProgress.processedFiles) / Math.max(1, ingestProgress.totalFiles * 2)) * 100))
    : Math.min(100, Math.round((uploadBytes / Math.max(1, ingestProgress?.totalBytes || selectedBytes)) * 50));
  const ingestEta = ingestProgress?.etaSeconds ? formatTime(Math.max(0, Math.round(ingestProgress.etaSeconds))) : null;
  const fastIndexCounts = normalizedFastIndexCounts(fastIndexJob || project?.fastIndex);
  const fastIndexPercent = fastIndexCounts.total
    ? Math.min(100, Math.round((fastIndexCounts.processed / Math.max(1, fastIndexCounts.total)) * 100))
    : 0;
  const fastIndexEta = fastIndexJob?.etaSeconds
    ? formatTime(Math.max(0, Math.round(fastIndexJob.etaSeconds)))
    : project?.fastIndex?.etaSeconds
      ? formatTime(Math.max(0, Math.round(project.fastIndex.etaSeconds)))
      : fastIndexEstimate?.estimatedSeconds
        ? formatTime(Math.max(0, Math.round(fastIndexEstimate.estimatedSeconds)))
        : null;
  const preprocessEta = preprocessJob?.etaSeconds
    ? formatTime(Math.max(0, Math.round(preprocessJob.etaSeconds)))
    : preprocessEstimate?.estimatedSeconds
      ? formatTime(Math.max(0, Math.round(preprocessEstimate.estimatedSeconds)))
      : null;
  const reviewableFolderVideos = project?.files.filter((file) =>
    !looksLikeGeneratedExport(file.name) &&
    file.metadata?.duration &&
    file.metadata.videoCodec !== "pending"
  ) || [];
  const folderVideoTotal = reviewableFolderVideos.length || preprocessJob?.totalProjectFiles || preprocessJob?.totalFiles || 0;
  const semanticReadyFiles = reviewableFolderVideos.filter((file) => semanticState(file) === "verified" || hasAutoUsableHighlightCandidate(file)).length;
  const semanticRejectedFiles = reviewableFolderVideos.filter((file) => semanticState(file) === "rejected").length;
  const semanticUncertainFiles = reviewableFolderVideos.filter((file) =>
    semanticState(file) === "uncertain" &&
    !hasAutoUsableHighlightCandidate(file)
  ).length;
  const pendingVisionCheckFiles = reviewableFolderVideos.filter((file) => needsVisionRecheck(file)).length;
  const semanticReviewedFiles = reviewableFolderVideos.filter((file) =>
    ["verified", "reviewed", "uncertain", "rejected"].includes(semanticState(file)) && !needsVisionRecheck(file)
  ).length;
  const activePreprocessTotal = preprocessJob?.totalFiles || preprocessJob?.totalProjectFiles || folderVideoTotal;
  const activePreprocessChecked = Math.min(activePreprocessTotal, preprocessJob?.processedFiles || 0);
  const folderVideosChecked = preprocessJob
    ? activePreprocessChecked
    : Math.min(folderVideoTotal, semanticReviewedFiles);
  const folderVideosTotal = preprocessJob ? activePreprocessTotal : folderVideoTotal;
  const preprocessPercent = preprocessJob
    ? Math.min(100, Math.round((folderVideosChecked / Math.max(1, folderVideosTotal || 1)) * 100))
    : 0;
  const selectedVideos = project?.files.filter((file) => selectedVideoIds.includes(file.id)) || [];
  const folderImportActive = Boolean(ingestProgress && !["completed", "cancelled", "failed"].includes(ingestProgress.phase));
  const addedPathProjects = recentProjects.filter((item) => item.sourcePath);
  const recentNonPathProjects = recentProjects.filter((item) => !item.sourcePath);
  const rankedLibrary = project
    ? [...project.files]
      .sort((a, b) => {
        const exportRank = Number(looksLikeGeneratedExport(a.name)) - Number(looksLikeGeneratedExport(b.name));
        if (exportRank) return exportRank;
        return (b.metadata?.indexScore || b.metadata?.semanticScore || b.metadata?.actionScore || 0) - (a.metadata?.indexScore || a.metadata?.semanticScore || a.metadata?.actionScore || 0);
      })
    : [];
  const clipDescription = (file: MediaAsset) => {
    const tags = usefulTags(file);
    const bestTime = reliableFocusTime(file);
    const moments = potentialMomentSummary(file);
    const state = semanticState(file);
    if (state === "rejected") return "This clip was flagged by AI; you can still select it if this is a false red flag.";
    if (state === "needs_check") return "Needs Vision AI check before it is ranked as verified.";
    if (state === "reviewed") {
      return [
        "AI checked this clip but did not fully verify the payoff.",
        moments,
        tags.length ? `Tags: ${tags.join(", ")}.` : ""
      ].filter(Boolean).join(" ");
    }
    if (state === "uncertain") {
      return [
        "AI checked this clip several times and marked the payoff uncertain.",
        moments,
        tags.length ? `Tags: ${tags.join(", ")}.` : ""
      ].filter(Boolean).join(" ");
    }
    if (tags.length) return `${tags.join(" - ")}${Number.isFinite(bestTime) ? `. Strongest moment near ${formatTime(bestTime || 0)}.` : moments ? ` ${moments}` : "."}`;
    if (!file.metadata?.duration || file.metadata.videoCodec === "pending") return "Background analysis is preparing this clip.";
    return `Local signals found a candidate moment near ${formatTime(bestTime || 0)}. Vision AI will identify the game-specific subjects, actions, objectives, and result.`;
  };
  const allTags = [...new Set(rankedLibrary.flatMap(usefulTags))].sort((a, b) => a.localeCompare(b)).slice(0, 18);
  const visibleLibrary = rankedLibrary
    .filter((file) => {
      const haystack = `${file.name} ${file.metadata?.indexDescription || ""} ${usefulTags(file).join(" ")}`.toLowerCase();
      return (!clipSearch.trim() || haystack.includes(clipSearch.trim().toLowerCase()))
        && (!activeTag || usefulTags(file).includes(activeTag));
    })
    .sort((a, b) => clipSort === "duration"
      ? (b.metadata?.duration || 0) - (a.metadata?.duration || 0)
      : clipSort === "name"
        ? a.name.localeCompare(b.name)
        : (b.metadata?.indexScore || b.metadata?.semanticScore || b.metadata?.actionScore || 0) - (a.metadata?.indexScore || a.metadata?.semanticScore || a.metadata?.actionScore || 0));
  const visibleClipPage = visibleLibrary.slice(0, visibleClipLimit);
  const hasMoreVisibleClips = visibleClipLimit < visibleLibrary.length;
  const generatedVideos = drafts.filter((draft) => draft.exportUrl);
  const audioAssets = localAssets.filter((asset) => asset.type === "audio");
  const selectedAudioAsset = audioAssets.find((asset) => asset.id === selectedAudioAssetId) || null;
  const sourceVideoUrl = (file: MediaAsset) => project ? localMediaUrl(`/api/projects/${project.id}/files/${file.id}/stream`) : "";
  const thumbnailUrl = (file: MediaAsset) => project ? localMediaUrl(`/api/projects/${project.id}/files/${file.id}/thumbnail`) : "";
  const highlightScore = (file: MediaAsset) => Math.round(Math.max(
    Number(file.metadata?.semanticScore || 0),
    Number(file.metadata?.indexScore || 0),
    Number(file.metadata?.actionScore || 0)
  ));
  const scoreLabel = (file: MediaAsset) => {
    const state = semanticState(file);
    if (state === "rejected") return "AI rejected";
    if (state === "verified") return "AI verified";
    if (state === "uncertain" && hasAutoUsableHighlightCandidate(file)) return "AI verified";
    if (state === "reviewed") return "AI checked";
    if (state === "uncertain") return "AI uncertain";
    if (state === "needs_check") return "Pending review";
    return "Local signal";
  };
  const availableIdeas = analysis?.ideas?.length ? analysis.ideas : curatedIdeas;
  const recommendedIdea = availableIdeas.find((idea) => idea.id === "trailer") || availableIdeas[0];
  const generationSourceVideos = selectedVideoIds.length ? selectedVideos : rankedLibrary.filter(isSelectableSourceClip);
  const selectedRejectedVideos = selectedVideos.filter((file) => semanticState(file) === "rejected");
  const generationSourceLabel = selectedVideoIds.length
    ? `${selectedVideoIds.length} selected clip${selectedVideoIds.length === 1 ? "" : "s"}`
    : `${generationSourceVideos.length} confirmed clip${generationSourceVideos.length === 1 ? "" : "s"}`;
  const readySelectedVideos = selectedVideos.filter((file) => file.metadata?.duration && file.metadata.videoCodec !== "pending");
  const selectedVerifiedMoments = selectedVideos.reduce((sum, file) =>
    sum + (file.metadata?.semanticEvents || []).filter((event) => event.payoffVerified === true).length, 0);
  const selectedConfirmedMoments = selectedVideos.reduce((sum, file) => sum + (file.metadata?.confirmedHighlightMoments || []).length, 0);
  const aiUncertainVideos = rankedLibrary.filter((file) =>
    isVisionReviewableSource(file) &&
    semanticState(file) === "uncertain" &&
    !hasAutoUsableHighlightCandidate(file)
  );
  const aiUncertainReviewMoments = optionalReviewItems(aiUncertainVideos);
  const selectedReviewMoments = optionalReviewItems(selectedVideos);
  const allReviewMoments = optionalReviewItems(rankedLibrary);
  const selectedConfirmedHighlightParts = selectedVideos.flatMap((file) =>
    (file.metadata?.confirmedHighlightMoments || []).map((moment) => ({
      file,
      moment,
      id: `${file.id}:${Math.round(moment.start * 10)}:${Math.round(moment.end * 10)}`
    }))
  );
  const allConfirmedHighlightParts = rankedLibrary.flatMap((file) =>
    (file.metadata?.confirmedHighlightMoments || []).map((moment) => ({
      file,
      moment,
      id: `${file.id}:${Math.round(moment.start * 10)}:${Math.round(moment.end * 10)}`
    }))
  );
  const reviewConfirmedHighlightParts = aiUncertainVideos.length || !selectedVideoIds.length ? allConfirmedHighlightParts : selectedConfirmedHighlightParts;
  const reviewHighlightMoments = aiUncertainReviewMoments.length
    ? aiUncertainReviewMoments
    : selectedReviewMoments.length
      ? selectedReviewMoments
      : allReviewMoments;
  const reviewingPlannedDraft = Boolean(pendingReviewDraftId);
  const activeReviewQueueParts: HighlightSidebarPart[] = (highlightReview?.items || reviewHighlightMoments).map((item) => ({
    id: item.id,
    file: item.file,
    start: item.start,
    end: item.end,
    action: item.action,
    source: item.source,
    status: item.confirmed ? "confirmed" : "pending",
    confidence: item.confidence,
    item
  }));
  const reviewSidebarParts = [...activeReviewQueueParts];
  if (!reviewingPlannedDraft) {
    for (const { file, moment, id } of reviewConfirmedHighlightParts) {
      const start = Number(moment.start) || 0;
      const end = Number(moment.end) || start + (Number(moment.duration) || 0);
      if (reviewSidebarParts.some((part) => part.file.id === file.id && intervalsOverlapMeaningfully(part, { start, end }))) continue;
      reviewSidebarParts.push({
        id: `confirmed:${id}`,
        file,
        start,
        end,
        action: moment.action,
        source: moment.source,
        status: "confirmed",
        confidence: "high",
        moment
      });
    }
  }
  const pendingReviewSidebarCount = reviewSidebarParts.filter((part) => part.status === "pending").length;
  const savedReviewSidebarCount = reviewSidebarParts.filter((part) => part.status === "confirmed").length;
  const selectedWeakOrStale = selectedVideos.filter((file) => ["needs_check", "reviewed", "uncertain"].includes(semanticState(file))).length;
  const selectedIndexedCandidates = selectedVideos.reduce((sum, file) => sum + (file.metadata?.candidateWindows || []).length, 0);
  const selectionReady = selectedVideoIds.length
    ? readySelectedVideos.length === selectedVideoIds.length
    : generationSourceVideos.length > 0;
  const generationReady = selectionReady;
  const renderActive = Boolean(renderJob && !["completed", "needs_review", "failed", "cancelled"].includes(renderJob.status));
  const selectedDraft = drafts[activeDraft] || drafts[drafts.length - 1] || null;
  const latestExportedDraft = [...drafts].reverse().find((draft) => draft.exportUrl) || null;
  const currentDraft = generating || renderActive ? selectedDraft : selectedDraft?.exportUrl ? selectedDraft : latestExportedDraft || selectedDraft;
  const authoritativeFastIndex = fastIndexJob || project?.fastIndex || null;
  const fastIndexStatus = String(authoritativeFastIndex?.status || "not_started");
  const indexingComplete = ["completed", "completed_with_warnings"].includes(fastIndexStatus);
  const visionJobActive = Boolean(preprocessJob && ["processing", "paused"].includes(preprocessJob.status));
  const visionReviewIncomplete = Boolean(project && indexingComplete && pendingVisionCheckFiles > 0 && !visionJobActive);
  const backgroundNeedsAttention = autoAiStatus.state === "error" || visionReviewIncomplete;
  const backgroundProgress = folderImportActive
    ? ingestPercent
    : ["processing", "paused"].includes(fastIndexStatus)
      ? fastIndexPercent
      : preprocessJob && ["processing", "paused"].includes(preprocessJob.status)
        ? preprocessPercent
        : visionReviewIncomplete
          ? Math.min(99, Math.round((semanticReviewedFiles / Math.max(1, folderVideoTotal)) * 100))
          : autoAiStatus.state === "complete" ? 100 : 0;
  const backgroundTitle = folderImportActive
    ? ingestProgress?.status === "paused" ? "Folder import paused" : "Importing and analyzing footage"
    : fastIndexStatus === "processing"
      ? "Indexing videos in the background"
      : fastIndexStatus === "paused"
        ? "Background indexing is paused"
        : ["queued", "not_started", "failed", "cancelled"].includes(fastIndexStatus)
          ? "Background indexing is ready to start"
          : preprocessJob?.status === "processing"
            ? "Vision AI is checking videos"
            : preprocessJob?.status === "paused"
              ? "Vision AI video check is paused"
              : visionReviewIncomplete
                ? "Vision AI review is not finished"
                : autoAiStatus.state === "error"
                  ? "Background AI analysis needs attention"
                  : "Background analysis is ready";
  const backgroundMessage = folderImportActive
    ? `${Math.min(ingestProgress?.processedFiles || 0, ingestProgress?.totalFiles || project?.files.length || 0)} of ${ingestProgress?.totalFiles || project?.files.length || 0} files analyzed${ingestProgress?.status === "paused" ? " - progress saved" : ""}`
    : ["processing", "paused"].includes(fastIndexStatus)
      ? `${fastIndexCounts.processed} of ${fastIndexCounts.total || project?.files.length || 0} indexed${fastIndexStatus === "paused" ? " - progress saved" : ""}`
      : preprocessJob && ["processing", "paused"].includes(preprocessJob.status)
        ? `${folderVideosChecked} of ${folderVideosTotal} videos checked${preprocessJob.status === "paused" ? " - progress saved" : ""}`
        : visionReviewIncomplete
          ? `${semanticReviewedFiles} of ${folderVideoTotal} videos checked. ${pendingVisionCheckFiles} videos still need Vision AI review.`
          : autoAiStatus.message || (indexingComplete
          ? "Local indexing is complete. Vision and text results are stored with this folder."
          : "Start indexing to prepare reusable candidate moments for AI video generation.");
  const backgroundPaused = ingestProgress?.status === "paused" || fastIndexStatus === "paused" || preprocessJob?.status === "paused";
  const backgroundRunning = folderImportActive || fastIndexStatus === "processing" || preprocessJob?.status === "processing";
  const workflowStep = !project ? 1 : selectedVideoIds.length === 0 ? 2 : drafts.length ? 4 : 3;
  const currentVisionProfile = effectiveVisionProfile(visionReviewMode, aiResourceLimits, visionAiConfig.endpoint);
  const localOllamaWorkerCap = isLocalOllamaVisionEndpoint(visionAiConfig.endpoint);
  const visionResourceSummary = `${currentVisionProfile.concurrency} worker${currentVisionProfile.concurrency === 1 ? "" : "s"}, ${currentVisionProfile.framesPerClip} frames/video${aiResourceLimits.maxVideosPerRun > 0 ? `, ${aiResourceLimits.maxVideosPerRun} videos/run` : ", all pending videos"}`;
  const activeHighlightReviewItem = (highlightReview?.items[highlightReview.index] || null) as HighlightReviewItem;
  const activeHighlightTrim = (activeHighlightReviewItem
    ? highlightTrim || { start: activeHighlightReviewItem.start, end: activeHighlightReviewItem.end }
    : null) as { start: number; end: number };
  const activeHighlightDuration = activeHighlightReviewItem?.file.metadata?.duration || activeHighlightReviewItem?.end || 1;
  const activeTrimStartPercent = activeHighlightTrim ? Math.max(0, Math.min(100, (activeHighlightTrim.start / Math.max(1, activeHighlightDuration)) * 100)) : 0;
  const activeTrimEndPercent = activeHighlightTrim ? Math.max(activeTrimStartPercent, Math.min(100, (activeHighlightTrim.end / Math.max(1, activeHighlightDuration)) * 100)) : 0;
  const reviewGenerationReady = reviewingPlannedDraft
    ? Boolean(highlightReview?.confirmed)
    : Boolean(recommendedIdea && generationReady);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3300);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!pendingReviewDraftId || !highlightReview || reviewGeneratePrompt || reviewGeneratePromptDismissed || generating || renderActive) return;
    const reviewComplete = highlightReview.total > 0 && highlightReview.reviewed >= highlightReview.total;
    const queueExhausted = highlightReview.items.length === 0;
    if ((reviewComplete || queueExhausted) && highlightReview.confirmed > 0) {
      const draft = drafts.find((item) => item.id === pendingReviewDraftId) || project?.drafts.find((item) => item.id === pendingReviewDraftId);
      const segments = draft && project ? approvedSegmentsForReviewDraft(draft, highlightReview, project.files) : confirmedReviewItemsToSegments(highlightReview);
      const duration = totalSegmentDuration(segments);
      const musicDuration = effectiveMusicDuration(selectedAudioAsset, musicRepeats);
      if (selectedAudioAsset && musicDuration > 0 && duration + 0.5 < musicDuration) {
        setReviewMusicCoveragePrompt({
          clipDuration: duration,
          musicDuration,
          musicName: selectedAudioAsset.name,
          clipCount: new Set(segments.map((segment) => segment.fileId)).size
        });
        setReviewGeneratePrompt(false);
        setNotice("The reviewed highlight parts are shorter than the soundtrack. Add more parts before generating for a stronger edit.");
        return;
      }
      setReviewMusicCoveragePrompt(null);
      setReviewGeneratePrompt(true);
      setNotice("All planned parts are reviewed. Confirm generation to start rendering.");
    }
  }, [
    pendingReviewDraftId,
    highlightReview?.reviewed,
    highlightReview?.confirmed,
    highlightReview?.total,
    highlightReview?.items.length,
    reviewGeneratePrompt,
    reviewGeneratePromptDismissed,
    generating,
    renderActive,
    selectedAudioAssetId,
    selectedAudioAsset?.duration,
    selectedAudioAsset?.metadata?.duration,
    musicRepeats
  ]);

  function renderReviewMusicCoveragePrompt() {
    const prompt = reviewMusicCoveragePrompt;
    if (!prompt) return null;
    return (
      <section className="music-coverage-card review-music-coverage" role="alert" aria-label="Add more reviewed parts for selected music">
        <div><Music2 size={17} /><strong>Add more highlight parts</strong></div>
        <p>
          {prompt.clipCount} approved clip{prompt.clipCount === 1 ? "" : "s"} total {formatTime(prompt.clipDuration)}, but {prompt.musicName} needs {formatTime(prompt.musicDuration)}.
        </p>
        <div>
          <button onClick={() => {
            setReviewMusicCoveragePrompt(null);
            setReviewGeneratePrompt(false);
            setReviewGeneratePromptDismissed(false);
            navigateToDashboard();
            setNotice("Select more clips, then click Generate video again. Your reviewed highlights are still saved.");
          }}><Plus size={15} /> Choose more clips</button>
        </div>
      </section>
    );
  }

  function renderHighlightReviewPage() {
    const reviewedCount = highlightReview ? Math.min(highlightReview.total, highlightReview.reviewed) : 0;
    return (
      <main className="highlight-review-page">
        <header className="review-page-heading">
          <button className="back-button" onClick={navigateToDashboard}><ArrowLeft size={18} /></button>
          <div>
            <span className="panel-label">{reviewingPlannedDraft ? "Generation review" : "Review page"}</span>
            <h2>{activeHighlightReviewItem ? activeHighlightReviewItem.file.name.replace(/\.[^.]+$/, "") : reviewingPlannedDraft ? "Review planned video parts" : "Highlight review"}</h2>
            <p>{highlightReview
              ? `${reviewedCount} of ${highlightReview.total} reviewed - ${highlightReview.confirmed} agreed${activeHighlightReviewItem ? ` - Part ${highlightReview.index + 1} of ${highlightReview.items.length}` : ""}`
              : "Choose clips first, then start highlight review."}</p>
          </div>
        </header>

        <div className="highlight-review-workspace">
          <section className="highlight-review-stage">
            {activeHighlightReviewItem && activeHighlightTrim ? (
              <>
                <video
                  ref={highlightReviewVideo}
                  src={sourceVideoUrl(activeHighlightReviewItem.file)}
                  controls
                  preload="metadata"
                  onTimeUpdate={handleHighlightReviewTime}
                  onPause={() => {
                    clearHighlightPlaybackGuard();
                    setHighlightReviewPlaying(false);
                  }}
                  onEnded={() => {
                    clearHighlightPlaybackGuard();
                    setHighlightReviewPlaying(false);
                  }}
                />
                <div className="highlight-trim-box" aria-label="Video cut controls">
                  <div
                    className="highlight-trim-rail"
                    style={{
                      "--start": `${activeTrimStartPercent}%`,
                      "--end": `${activeTrimEndPercent}%`
                    } as React.CSSProperties}
                  >
                    <div className="trim-label trim-label-start"><span>Start</span><strong>{formatTime(activeHighlightTrim.start)}</strong></div>
                    <div className="trim-label trim-label-end"><span>End</span><strong>{formatTime(activeHighlightTrim.end)}</strong></div>
                    <div className="trim-track"><span /></div>
                    <input
                      className="trim-range trim-range-start"
                      aria-label="Trim start"
                      type="range"
                      min={0}
                      max={Math.max(0, activeHighlightDuration - 1)}
                      step="0.1"
                      value={activeHighlightTrim.start}
                      onChange={(event) => updateHighlightTrim("start", Number(event.target.value))}
                    />
                    <input
                      className="trim-range trim-range-end"
                      aria-label="Trim end"
                      type="range"
                      min={1}
                      max={activeHighlightDuration}
                      step="0.1"
                      value={activeHighlightTrim.end}
                      onChange={(event) => updateHighlightTrim("end", Number(event.target.value))}
                    />
                  </div>
                  <small>Drag the start and end markers above the timeline, then play the period before confirming.</small>
                </div>
                <footer className="highlight-review-controls">
                  <button disabled={!highlightReview || highlightReview.index === 0} onClick={() => moveHighlightReview(-1)}><ArrowLeft size={16} /> Previous</button>
                  <button onClick={highlightReviewPlaying ? stopHighlightReview : playHighlightReview}>
                    {highlightReviewPlaying ? <Square size={16} /> : <Play size={16} fill="currentColor" />}
                    {highlightReviewPlaying ? "Stop" : "Play period"}
                  </button>
                  <button disabled={!highlightReview || highlightReview.index >= highlightReview.items.length - 1} onClick={() => moveHighlightReview(1)}>Next <ArrowRight size={16} /></button>
                  <button onClick={() => void skipCurrentHighlightThisTime()}><X size={16} /> Skip this time</button>
                  <button className="reject-highlight-button" onClick={() => void rejectCurrentHighlightAsNotHighlight()}><Trash2 size={16} /> Not a highlight</button>
                  <button className="confirm-highlight-button" onClick={() => void confirmCurrentHighlight()}><Check size={16} /> {activeHighlightReviewItem.confirmed ? "Confirmed" : "Agree, use it"}</button>
                </footer>
              </>
            ) : (
              <div className="highlight-review-empty">
                <Check size={24} />
                <strong>{reviewConfirmedHighlightParts.length ? "Review complete" : "No active candidate"}</strong>
                <span>{reviewConfirmedHighlightParts.length ? "Use the picked parts list, add more candidates, or generate the video." : "Go back to clips and start review again."}</span>
              </div>
            )}
          </section>

          <aside className="picked-highlight-panel">
            <div>
              <span className="panel-label">{reviewingPlannedDraft ? "Planned parts" : "Review queue"}</span>
              <strong>{pendingReviewSidebarCount} to review - {savedReviewSidebarCount} saved</strong>
            </div>
            <div className="picked-highlight-list">
              {reviewSidebarParts.length ? reviewSidebarParts.map((part) => (
                <article key={part.id} className={part.status === "confirmed" ? "confirmed" : "pending"}>
                  <button className="picked-highlight-thumbnail" onClick={() => part.item ? viewHighlightReviewCandidate(part.item) : part.moment && viewConfirmedHighlightPart(part.file, part.moment)} aria-label={`Preview ${part.file.name.replace(/\.[^.]+$/, "")}`}>
                    <img src={thumbnailUrl(part.file)} alt="" loading="lazy" />
                    <span><Play size={14} fill="currentColor" /></span>
                    <small>{formatTime(part.start)}-{formatTime(part.end)}</small>
                  </button>
                  <button className="picked-highlight-view" onClick={() => part.item ? viewHighlightReviewCandidate(part.item) : part.moment && viewConfirmedHighlightPart(part.file, part.moment)}>
                    <strong>{part.file.name.replace(/\.[^.]+$/, "")}</strong>
                    <small>{formatTime(part.start)}-{formatTime(part.end)} - {part.status === "confirmed" ? "saved highlight" : "AI uncertain"} - {part.action || part.source || "manual review"}</small>
                  </button>
                  <div className="picked-highlight-row-actions">
                    {part.status === "confirmed" && part.moment ? (
                      <>
                        <button onClick={() => reconfirmHighlightPart(part.file, part.moment!)}><RotateCcw size={14} /> Reconfirm</button>
                        <button onClick={() => void removeConfirmedHighlightPart(part.file, part.moment!)}><Trash2 size={14} /> Remove</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => part.item && viewHighlightReviewCandidate(part.item)}><Play size={14} /> Review</button>
                        <button disabled>{confidenceLabel(part.confidence)}</button>
                      </>
                    )}
                  </div>
                </article>
              )) : <p>No AI uncertain highlight periods are available yet.</p>}
            </div>
            <div className="picked-highlight-actions">
              {renderReviewMusicCoveragePrompt()}
              <button onClick={addMoreHighlightCandidates}><Plus size={16} /> Add more</button>
              <button className="confirm-highlight-button" disabled={!reviewGenerationReady || Boolean(reviewMusicCoveragePrompt) || generating || renderActive} onClick={() => void generateFromHighlightReview()}><Sparkles size={16} /> Generate video</button>
            </div>
          </aside>
        </div>
      </main>
    );
  }

  function renderDashboard() {
    return (
      <main className="dashboard">
        <aside className="footage-sidebar">
          <div className="sidebar-heading">
            <span>Footage</span>
            <button aria-label="Add folder" onClick={() => void chooseLocalFolder()}><Plus size={18} /></button>
          </div>
          <button className="add-folder-button" onClick={() => void chooseLocalFolder()}><FolderSearch size={19} /> Add game folder</button>
          <button className="add-videos-button" onClick={() => recordingInput.current?.click()}><Upload size={17} /> Add video files</button>
          <div className="source-list">
            <span className="panel-label">Your folders</span>
            {addedPathProjects.length ? addedPathProjects.map((item) => (
              <button key={item.id} className={project?.id === item.id ? "active" : ""} onClick={() => void openSavedPath(item)}>
                <FolderSearch size={17} />
                <div><strong>{item.name}</strong><small>{item.files.length} videos</small></div>
              </button>
            )) : <p>Folders you add will stay here for quick access.</p>}
          </div>
          {recentNonPathProjects.length > 0 && (
            <div className="source-list">
              <span className="panel-label">Recent uploads</span>
              {recentNonPathProjects.slice(0, 4).map((item) => (
                <button key={item.id} className={project?.id === item.id ? "active" : ""} onClick={() => resumeProject(item)}>
                  <Video size={17} /><div><strong>{item.name}</strong><small>{item.files.length} videos</small></div>
                </button>
              ))}
            </div>
          )}
          <div className="sidebar-note"><ShieldCheck size={16} /><span>Your source videos remain untouched. Indexes and drafts are stored locally.</span></div>
        </aside>

        <section className="clip-workspace">
          <div className="workflow-steps" aria-label="Video creation workflow">
            {[
              ["1", "Add footage"],
              ["2", "Choose clips"],
              ["3", "Set direction"],
              ["4", "Review video"]
            ].map(([number, label], index) => {
              const step = index + 1;
              return (
                <div key={number} className={`${workflowStep === step ? "current" : ""} ${workflowStep > step ? "complete" : ""}`}>
                  <span>{workflowStep > step ? <Check size={14} /> : number}</span>
                  <strong>{label}</strong>
                </div>
              );
            })}
          </div>
          {!project ? (
            <div className="empty-workspace">
              <span className="empty-icon"><Sparkles size={30} /></span>
              <div className="eyebrow"><span /> Start here</div>
              <h1>Make a great highlight<br />without editing it yourself.</h1>
              <p>Add a gameplay folder. HighlightAI loads clips immediately, then local indexing, Vision AI, and your configured Text AI continue automatically in the background.</p>
              <button className="hero-add-button" onClick={() => void chooseLocalFolder()}><FolderSearch size={20} /> Add game folder</button>
              <button className="text-action" onClick={() => recordingInput.current?.click()}>or add individual video files</button>
              <div className="workflow-preview">
                <span><b>1</b> Add footage</span><ChevronRight size={16} /><span><b>2</b> Review moments</span><ChevronRight size={16} /><span><b>3</b> Generate</span>
              </div>
              {operationIssue && <div className="issue-card" role="alert"><AlertTriangle size={20} /><div><strong>{operationIssue.title}</strong><p>{operationIssue.message}</p>{operationIssue.action && <small>{operationIssue.action}</small>}</div></div>}
            </div>
          ) : (
            <>
              <header className="library-titlebar">
                <div>
                  <span className="panel-label">Current footage</span>
                  <h2>{project.name}</h2>
                  <p>{project.sourcePath || `${project.files.length} uploaded videos`}</p>
                </div>
                <div className="library-title-actions">
                  <div className="library-summary"><strong>{project.files.length}</strong><span>videos</span></div>
                  <button className="remove-project-button" onClick={() => void removeSavedProject(project)}><Trash2 size={15} /> Remove {project.sourcePath ? "folder" : "upload"}</button>
                </div>
              </header>

              {true && (
                <div className={`auto-ai-banner background-service ${backgroundPaused ? "paused" : backgroundRunning ? "running" : backgroundNeedsAttention ? "error" : autoAiStatus.state}`} aria-live="polite">
                  {backgroundPaused ? <Pause size={19} /> : backgroundRunning ? <LoaderCircle size={19} /> : backgroundNeedsAttention ? <AlertTriangle size={19} /> : <Check size={19} />}
                  <div>
                    <strong>{backgroundTitle}</strong>
                    <span>{backgroundMessage}</span>
                  </div>
                  <div className="auto-ai-actions">
                    {autoAiStatus.state === "error" ? (
                      <>
                        {/localhost|127\.0\.0\.1/i.test(visionAiConfig.endpoint) && (
                          <button className="check-ollama-button" disabled={modelTestState.vision.state === "testing"} onClick={() => void checkOllamaAndRetry()}>
                            {modelTestState.vision.state === "testing" ? <LoaderCircle size={13} /> : <RotateCcw size={13} />}
                            {modelTestState.vision.state === "testing" ? "Checking..." : "Check again"}
                          </button>
                        )}
                        <button onClick={() => setSettingsOpen(true)}><Settings2 size={13} /> AI settings</button>
                      </>
                    ) : folderImportActive ? (
                      <button className="pause-control-button" disabled={pausePending.ingest} onClick={() => void toggleImportPause()}>
                        {ingestProgress?.status === "paused" ? <Play size={13} /> : <Pause size={13} />}
                        {ingestProgress?.status === "paused" ? "Resume" : "Pause"}
                      </button>
                    ) : fastIndexJob && ["processing", "paused"].includes(fastIndexJob.status) ? (
                      <button className="pause-control-button" disabled={pausePending["fast-index"]} onClick={() => void toggleFastIndexPause()}>
                        {fastIndexJob.status === "paused" ? <Play size={13} /> : <Pause size={13} />}
                        {fastIndexJob.status === "paused" ? "Resume" : "Pause"}
                      </button>
                    ) : ["queued", "not_started", "failed", "cancelled"].includes(fastIndexStatus) ? (
                      <button onClick={() => void startFastIndex()}><Play size={13} /> Start indexing</button>
                    ) : preprocessJob && ["processing", "paused"].includes(preprocessJob.status) ? (
                      <button className="pause-control-button" disabled={pausePending.vision} onClick={() => void toggleSemanticPause()}>
                        {preprocessJob.status === "paused" ? <Play size={13} /> : <Pause size={13} />}
                        {preprocessJob.status === "paused" ? "Resume" : "Pause"}
                      </button>
                    ) : pendingVisionCheckFiles > 0 ? (
                      <button disabled={modelTestState.vision.state === "testing"} onClick={() => void runVisionCheckService()}>
                        <Play size={13} /> Run Vision AI check
                      </button>
                    ) : null}
                  </div>
                  {(backgroundRunning || backgroundPaused || backgroundProgress === 100) && <div className="simple-progress-bar"><span style={{ width: `${Math.max(3, backgroundProgress)}%` }} /></div>}
                </div>
              )}

              {operationIssue && <div className="issue-card compact" role="alert"><AlertTriangle size={18} /><div><strong>{operationIssue.title}</strong><p>{operationIssue.message}</p></div></div>}

              {generatedVideos.length > 0 && (
                <section className="generated-library">
                  <button className="generated-folder-card" onClick={() => setGeneratedLibraryOpen(true)}>
                    <span className="generated-folder-icon"><FolderSearch size={22} /></span>
                    <span>
                      <small className="panel-label">Generated videos</small>
                      <strong>Your finished videos</strong>
                      <em>{generatedVideos.length} saved video{generatedVideos.length === 1 ? "" : "s"} ready to watch</em>
                    </span>
                    <ChevronRight size={18} />
                  </button>
                </section>
              )}

              <div className="clip-toolbar">
                <div><h3>Your clips</h3><p>Select any number of ready clips. {semanticReadyFiles ? `Vision AI confirmed ${semanticReadyFiles} highlight-ready clip${semanticReadyFiles === 1 ? "" : "s"}` : "Local signal analysis"} ranked the strongest footage first.{semanticRejectedFiles ? ` ${semanticRejectedFiles} low-signal clip${semanticRejectedFiles === 1 ? " was" : "s were"} excluded.` : ""}{pendingVisionCheckFiles ? ` ${pendingVisionCheckFiles} clip${pendingVisionCheckFiles === 1 ? " is" : "s are"} waiting for Vision AI.` : semanticUncertainFiles ? ` ${semanticUncertainFiles} clip${semanticUncertainFiles === 1 ? " is" : "s are"} still low confidence.` : ""}</p></div>
                <div className="clip-toolbar-actions">
                  <span className="selected-count"><strong>{selectedVideoIds.length}</strong> selected</span>
                  <button disabled={!reviewHighlightMoments.length && !reviewConfirmedHighlightParts.length} onClick={startHighlightReview}><Play size={16} /> Review moments</button>
                </div>
              </div>
              {selectedRejectedVideos.length > 0 && (
 <div className="issue-card compact generation-visible-alert" role="status">
 <ShieldCheck size={18} />
 <div><strong>Selected despite the AI red flag</strong><p>{selectedRejectedVideos.length} flagged clip{selectedRejectedVideos.length === 1 ? " is" : "s are"} included because you selected it manually.</p></div>
 </div>
 )}
 <div className="library-controls">
                <label className="clip-search"><Search size={16} /><input value={clipSearch} onChange={(event) => setClipSearch(event.target.value)} placeholder="Search descriptions or tags..." /></label>
                <select aria-label="Sort clips" value={clipSort} onChange={(event) => setClipSort(event.target.value as "score" | "duration" | "name")}>
                  <option value="score">Best moments</option>
                  <option value="duration">Longest first</option>
                  <option value="name">Name</option>
                </select>
              </div>
              <div className="library-actions">
                <div className="view-switcher" aria-label="Library view">
                  <button className={libraryView === "grid" ? "active" : ""} aria-label="Grid view" title="Grid view" onClick={() => setLibraryView("grid")}><Grid2X2 size={16} /></button>
                  <button className={libraryView === "grid-4" ? "active" : ""} aria-label="Four-column grid view" title="Four-column grid view" onClick={() => setLibraryView("grid-4")}><span className="view-density-icon" aria-hidden="true"><i /><i /><i /><i /></span></button>
                  <button className={libraryView === "list" ? "active" : ""} aria-label="List view" title="List view" onClick={() => setLibraryView("list")}><List size={17} /></button>
                  <button className={libraryView === "detail" ? "active" : ""} aria-label="Detail view" title="Detail view" onClick={() => setLibraryView("detail")}><Layers3 size={17} /></button>
                </div>
                <div className="bulk-actions">
                  <button onClick={selectFirstTwentyClips}><Check size={15} /> Select top 20</button>
                  <button onClick={selectVisibleClips}><Check size={15} /> Select all</button>
                  <button onClick={selectDiversifiedClips}><Sparkles size={15} /> I'm feeling lucky</button>
                  <button disabled={!selectedVideoIds.length} onClick={clearSelection}><X size={15} /> Unselect all</button>
                </div>
              </div>
              {allTags.length > 0 && (
                <div className="tag-filters">
                  <button className={!activeTag ? "active" : ""} onClick={() => setActiveTag("")}>All</button>
                  {allTags.map((tag) => <button key={tag} className={activeTag === tag ? "active" : ""} onClick={() => setActiveTag(activeTag === tag ? "" : tag)}>{tag}</button>)}
                </div>
              )}

              <div className={`clip-grid view-${libraryView}`}>
                {visibleClipPage.map((file) => {
                  const selected = selectedVideoIds.includes(file.id);
                  const generated = looksLikeGeneratedExport(file.name);
                  const pending = !file.metadata?.duration || file.metadata.videoCodec === "pending";
                  const rating = scoreLabel(file);
                  const tags = generated ? ["generated export"] : usefulTags(file);
                  const ratingText = pending
                    ? "..."
                    : rating === "Local signal"
                      ? `Local ${highlightScore(file)}`
                      : rating === "Pending review"
                        ? `Pending review ${highlightScore(file)}`
                      : `${rating} ${highlightScore(file)}`;
                  const ratingTitle = pending
                    ? "Background analysis pending"
                    : rating === "AI verified"
                      ? "Vision AI verified a complete visible payoff"
                      : rating === "AI checked"
                        ? "Vision AI reviewed this clip but has not confirmed a complete payoff yet"
                      : rating === "AI uncertain"
                        ? "Vision AI checked this clip but could not confidently verify a complete highlight"
                        : rating === "Pending review"
                          ? "Local analysis found a candidate moment; Vision AI has not checked this clip yet"
                        : "Local signal highlight rating; Vision AI has not reviewed this clip yet";
                  const useCount = Math.max(0, Number(file.metadata?.generationUseCount || 0));
                  return (
                    <article key={file.id} className={`clip-card ${selected ? "selected" : ""} ${generated ? "generated" : ""}`}>
                      {!generated && (
                        <label className="clip-checkbox" title={selected ? "Remove clip from selection" : "Add clip to selection"}>
                          <input type="checkbox" checked={selected} disabled={pending} onChange={() => toggleVideoSelection(file.id)} aria-label={`${selected ? "Unselect" : "Select"} ${file.name}`} />
                          <span>{selected && <Check size={15} />}</span>
                        </label>
                      )}
                      <button className="clip-thumbnail" disabled={pending} onClick={() => setPreviewVideo({ title: file.name.replace(/\.[^.]+$/, ""), url: sourceVideoUrl(file) })} aria-label={`Preview ${file.name}`}>
                        <Video size={25} />
                        {!pending && (
                          <img
                            key={`${file.id}-${file.metadata?.videoCodec}-${file.metadata?.semanticTopFrame ?? file.metadata?.highlightStart ?? "default"}`}
                            src={thumbnailUrl(file)}
                            alt=""
                            loading="lazy"
                            onLoad={(event) => { event.currentTarget.style.display = "block"; }}
                            onError={(event) => { event.currentTarget.style.display = "none"; }}
                          />
                        )}
                        <span className="preview-hint"><Play size={16} fill="currentColor" /> Preview</span>
                        <span className={`clip-score ${pending ? "pending" : rating === "Local signal" ? "local" : rating === "AI uncertain" || rating === "AI checked" ? "assisted" : rating === "Pending review" ? "pending" : ""}`} title={ratingTitle}>
                          {ratingText}
                        </span>
                        {!pending && file.metadata?.reviewed === true && (
                          <span className="clip-user-verified" title="You already reviewed this clip. HighlightAI will not ask you to review it again.">user verified</span>
                        )}
                        {!pending && (file.metadata?.reviewed === true || useCount > 0) && (
                          <span className={"clip-use-count " + (file.metadata?.reviewed === true ? "" : "without-verified")} title="Times this source video has been used in a successfully generated export">used {useCount}x</span>
                        )}
                        <small>{file.metadata?.duration ? formatTime(file.metadata.duration) : "Analyzing"}</small>
                      </button>
                      <div className="clip-copy">
                        <strong>{file.name.replace(/\.[^.]+$/, "")}</strong>
                        <p>{generated ? "Generated export. It cannot be used as source footage." : clipDescription(file)}</p>
                        <div className={`tag-row ${tags.length ? "" : "pending-tags"}`}>
                          {(tags.length ? tags : [pending ? "Analyzing" : "Vision tags pending"]).slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
              {hasMoreVisibleClips && (
                <div ref={clipPageSentinel} className="clip-page-sentinel" aria-label="More clips available">
                  <span>Showing {visibleClipPage.length} of {visibleLibrary.length} clips</span>
                  <button type="button" onClick={() => setVisibleClipLimit((current) => Math.min(current + 40, visibleLibrary.length))}>Show more</button>
                </div>
              )}
              {!visibleLibrary.length && <div className="empty-filter">No clips match this search or tag.</div>}
            </>
          )}
        </section>

        <aside className="create-panel legacy-create-panel" hidden aria-hidden="true">
          <div className="create-panel-scroll">
            <div className="create-heading"><span className="panel-label">Step {drafts.length ? "4" : "3"} of 4</span><h2>{drafts.length ? "Review your video" : "Set the direction"}</h2><p>{drafts.length ? "Choose a version, preview it, then render the final MP4." : "Describe the result. AI chooses pacing and final length from your clips."}</p></div>

            {drafts.length > 0 && drafts[activeDraft] ? (
              <div className="draft-result">
              <div className="draft-result-head"><span>Draft ready</span><strong>{drafts[activeDraft].title}</strong><small>{formatTime(drafts[activeDraft].duration)} - {drafts[activeDraft].style}</small></div>
              <div className="draft-tabs">{drafts.map((draft, index) => <button key={draft.id} className={activeDraft === index ? "active" : ""} onClick={() => setActiveDraft(index)}>Version {index + 1}</button>)}</div>
              {(drafts[activeDraft].exportUrl || project?.files[0]) && <video src={drafts[activeDraft].exportUrl ? localMediaUrl(drafts[activeDraft].exportUrl) : sourceVideoUrl(project!.files[0])} controls preload="metadata" />}
              <div className={`draft-soundtrack ${selectedAudioAsset ? "ready" : "missing"}`}>
                <div><Music2 size={17} /><span><small>Soundtrack</small><strong>{selectedAudioAsset?.name || "No music selected"}</strong></span></div>
                <p>{selectedAudioAsset ? "This track will be mixed with game audio in the next render." : "Choose music before rendering so the exported video is not silent."}</p>
                <div>
                  <button onClick={openMusicBrowser}>{selectedAudioAsset ? "Change" : "Add music"}</button>
              <button className="apply-music-button" disabled={!selectedAudioAsset || ["processing", "queued", "paused"].includes(String(renderJob?.status || ""))} onClick={() => void renderSpecificDraft(drafts[activeDraft])}>
                    {renderJob && !["completed", "needs_review", "failed", "cancelled"].includes(renderJob.status) ? "Rendering..." : "Apply & render"}
                  </button>
                </div>
              </div>
              <div className="chat-input">
                <input value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => event.key === "Enter" && prompt.trim() && void refineDraft(prompt)} placeholder="Describe the change: shorter, more action, slower story..." />
                <button aria-label="Apply refinement" disabled={!prompt.trim()} onClick={() => void refineDraft(prompt)}><Send size={16} /></button>
              </div>
              <div className="draft-actions">
                <button disabled={!prompt.trim()} onClick={() => void refineDraft(prompt)}><WandSparkles size={16} /> Refine edit</button>
                <button className="primary" disabled={["processing", "queued", "paused"].includes(String(renderJob?.status || ""))} onClick={() => void exportDraft()}><Check size={16} /> {renderJob && !["completed", "needs_review", "failed", "cancelled"].includes(renderJob.status) ? (renderJob.status === "paused" ? "Render paused" : "Rendering...") : drafts[activeDraft].exportUrl ? "Open export" : "Render MP4"}</button>
              </div>
              {renderJob && !["completed", "needs_review", "failed", "cancelled"].includes(renderJob.status) && (
                <div className="background-task-card" aria-live="polite">
                  <LoaderCircle size={18} />
                  <div><strong>{renderJob.message}</strong><small>You can continue selecting clips, changing settings, or opening another folder.</small></div>
                  <span>{renderJob.progress}%</span>
                </div>
              )}
              </div>
            ) : (
              <>
                <label className="creation-prompt">
                  <span>What should it feel like?</span>
                  <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Cinematic, exciting, complete action stories, no menus or waiting..." />
                </label>
                <div className="prompt-chips">
                  {suggestions.map((item) => <button key={item} onClick={() => setPrompt(item)}>{item}</button>)}
                </div>
                {project && recommendedIdea && (
                  <div className="ai-direction">
                    <div className="ai-direction-title"><Sparkles size={18} /><span><small>{semanticReadyFiles ? "AI recommendation" : "Suggested direction"}</small><strong>{recommendedIdea.title}</strong></span><b>{recommendedIdea.score}%</b></div>
                    <p>{analysis?.notes?.[2] || recommendedIdea.description}</p>
                    <div className="direction-meta"><span>{recommendedIdea.style}</span><span>{recommendedIdea.format}</span><span>Auto length</span></div>
                  </div>
                )}
                <div className="create-options">
                  <button className={`soundtrack-option ${selectedAudioAsset ? "ready" : "missing"}`} onClick={openMusicBrowser}>
                    <Music2 size={17} />
                    <span><strong>{selectedAudioAsset ? "Soundtrack selected" : "Add a soundtrack"}</strong><small>{selectedAudioAsset?.name || "Required before generation"}</small></span>
                    <ChevronRight size={16} />
                  </button>
                  <button onClick={() => setSettingsOpen(true)}><WandSparkles size={17} /><span><strong>AI models</strong><small>Vision: {visionAiConfig.model || "Not configured"} - {visionResourceSummary}</small></span><ChevronRight size={16} /></button>
                </div>
              </>
            )}

            {operationIssue && project && <div className="issue-card compact" role="alert"><AlertTriangle size={18} /><div><strong>{operationIssue.title}</strong><p>{operationIssue.message}</p>{operationIssue.action && <small>{operationIssue.action}</small>}</div></div>}
          </div>

          <div className="create-panel-footer">
            {generating ? (
              <div className="generation-progress" aria-live="polite"><LoaderCircle size={18} /><span><strong>Creating your video</strong><small>Building two edit options from the strongest confirmed moments...</small></span></div>
            ) : drafts.length > 0 ? (
              <button className="new-draft-button" onClick={() => { setDrafts([]); setStage("advice"); }}><RotateCcw size={17} /> Create another version</button>
            ) : (
              <div className={`selection-status ${generationReady ? "ready" : ""}`}>
                {generationReady ? <Check size={17} /> : <AlertTriangle size={17} />}
                <span>{!selectionReady
                  ? folderImportActive ? "Footage is still being analyzed" : selectedVideoIds.length ? "Selected clips are still being analyzed" : "No confirmed clips are ready yet"
                  : selectedAudioAsset ? `${generationSourceLabel} and music ready` : `${generationSourceLabel} ready; game audio only`}</span>
              </div>
            )}
            {!drafts.length && (
              <>
                {!selectedAudioAsset && project && <button className="footer-music-button" onClick={openMusicBrowser}><Music2 size={17} /> Choose soundtrack</button>}
                <button className="generate-button" disabled={!project || !recommendedIdea || !generationReady || generating} onClick={() => recommendedIdea && void createDraft(recommendedIdea)}>
                  {generating ? <><LoaderCircle size={19} /> Creating Video...</> : <><Sparkles size={19} /> Generate Video</>}
                </button>
              </>
            )}
            <small className="duration-note"><Clock3 size={14} /> AI chooses the best duration, up to 5 minutes.</small>
          </div>
        </aside>

        <aside className="create-panel simple-create-sidebar">
          <div className="simple-create-panel">
            <header className="simple-create-heading">
              <span className="panel-label">Create video</span>
              <h2>{currentDraft?.exportUrl && !renderActive && !generating ? "Your video is ready" : "Generate your highlight"}</h2>
              <p>{selectedVideoIds.length ? `${selectedVideoIds.length} clips selected.` : "No manual selection needed."} AI chooses the strongest confirmed moments and final duration.</p>
            </header>

            {operationIssue && project && (
              <div className="issue-card compact generation-visible-alert" role="alert">
                <AlertTriangle size={18} />
                <div><strong>{operationIssue.title}</strong><p>{operationIssue.message}</p>{operationIssue.action && <small>{operationIssue.action}</small>}</div>
              </div>
            )}


            {selectedRejectedVideos.length > 0 && (
              <div className="issue-card compact generation-visible-alert" role="status">
                <ShieldCheck size={18} />
                <div><strong>Manual AI-flag override active</strong><p>{selectedRejectedVideos.length} flagged clip{selectedRejectedVideos.length === 1 ? " is" : "s are"} included because you selected it manually.</p></div>
              </div>
            )}

            <section className={`generation-advice-card ${selectedVerifiedMoments < 3 ? "needs-more" : "ready"}`} aria-label="Advice for a better video">
              <div><Sparkles size={17} /><strong>How to make this video better</strong></div>
              {generationSourceVideos.length ? (
                <p>
                  {generationAdvice || (!selectedVideoIds.length
                    ? `The editor will use ${generationSourceVideos.length} confirmed clip${generationSourceVideos.length === 1 ? "" : "s"}, reject low-signal footage, balance repeated actions, and build a paced arc automatically.`
                    : selectedVerifiedMoments < 3
                    ? `AI sees ${selectedVerifiedMoments} verified highlight moment${selectedVerifiedMoments === 1 ? "" : "s"} and ${selectedWeakOrStale} selected clip${selectedWeakOrStale === 1 ? " has" : "s have"} lower confidence. Generate will still auto-rank the strongest uncertain and indexed moments.`
                    : `This selection has ${selectedVerifiedMoments} AI-verified highlight moment${selectedVerifiedMoments === 1 ? "" : "s"}, ${selectedConfirmedMoments} saved period${selectedConfirmedMoments === 1 ? "" : "s"}, and ${selectedIndexedCandidates} indexed candidate moment${selectedIndexedCandidates === 1 ? "" : "s"}. Confirmed periods are used first.`)}
                </p>
              ) : (
                <p>No confirmed highlight-ready clips are available yet. Let Vision AI finish indexing this folder, then generation can build from the strongest moments automatically.</p>
              )}
            </section>

            <section className="simple-music-picker">
              <label htmlFor="soundtrack-select">Choose music (optional)</label>
              <select id="soundtrack-select" value={selectedAudioAssetId} onChange={(event) => setSelectedAudioAssetId(event.target.value)}>
                <option value="">No background music</option>
                {audioAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
              </select>
              <button onClick={() => assetInput.current?.click()}><Plus size={16} /> Add music file</button>
              <label htmlFor="music-repeat-select">Video length</label>
              <select id="music-repeat-select" value={musicRepeats} onChange={(event) => setMusicRepeats(Number(event.target.value) === 2 ? 2 : 1)}>
                <option value={1}>Use music once</option>
                <option value={2}>Play music twice, up to 5 min</option>
              </select>
              <small>Music already added to this project appears in the list.</small>
            </section>

            {(generating || renderActive) && (
              <section className="simple-generation-progress" aria-live="polite">
                <div>{preprocessJob?.status === "paused" || renderJob?.status === "paused" ? <Pause size={18} /> : <LoaderCircle size={18} />}<span><strong>{generating ? (preprocessJob?.status === "paused" ? "Vision AI paused" : preprocessJob?.status === "processing" ? "Vision AI is finding complete highlight moments" : "Planning the edit") : renderJob?.message || "Generating video"}</strong><small>{preprocessJob?.status === "paused" || renderJob?.status === "paused" ? "Resume when you are ready." : "You can continue using HighlightAI while this runs."}</small></span><b>{generating ? `${Math.max(5, preprocessPercent || 5)}%` : `${renderJob?.progress || 0}%`}</b></div>
                <div className="simple-progress-bar"><span style={{ width: `${generating ? Math.max(5, preprocessPercent || 5) : Math.max(5, renderJob?.progress || 0)}%` }} /></div>
                {renderJob?.workflow && (
                  <div className="agent-workflow-summary">
                    <span>Director</span>
                    <span>Review {renderJob.workflow.visualReview?.score ?? renderJob.workflow.critique?.score ?? "..."} / 100</span>
                    <span>{renderJob.workflow.selectedMoments ?? 0} moments</span>
                    <span>{renderJob.workflow.critique?.payoffMoments ?? 0} payoffs</span>
                  </div>
                )}
                <div className="generation-progress-actions">
                  {renderJob && ["queued", "processing", "paused"].includes(renderJob.status) && (
                    <button className="pause-generation-button" disabled={pausePending.render} onClick={() => void toggleRenderPause()}>
                      {renderJob.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
                      {renderJob.status === "paused" ? "Resume" : "Pause"}
                    </button>
                  )}
                  {generating && preprocessJob && ["processing", "paused"].includes(preprocessJob.status) && (
                    <button className="pause-generation-button" disabled={pausePending.vision} onClick={() => void toggleSemanticPause()}>
                      {preprocessJob.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
                      {preprocessJob.status === "paused" ? "Resume" : "Pause"}
                    </button>
                  )}
                  <button className="cancel-generation-button" onClick={stopGeneration}>Cancel</button>
                </div>
              </section>
            )}

            {currentDraft?.exportUrl && !generating && !renderActive && (
              <section className="simple-video-result">
                <div><Check size={17} /><span><small>Completed video</small><strong>{currentDraft.title}</strong></span></div>
                <video src={localMediaUrl(currentDraft.exportUrl)} controls preload="metadata" />
                {currentDraft.workflow && (
                  <div className="completed-workflow-summary">
                    <span><strong>{currentDraft.workflow.critique.score}/100</strong> director review</span>
                    <span><strong>{currentDraft.workflow.selectedMoments}</strong> moments</span>
                    <span><strong>{currentDraft.workflow.critique.payoffMoments}</strong> complete payoffs</span>
                  </div>
                )}
                {currentDraft.encoding && (
                  <p className="encoding-summary">
                    {currentDraft.encoding.width}x{currentDraft.encoding.height} - {currentDraft.encoding.encoder} - {currentDraft.encoding.qualityMode} - {formatBytes(currentDraft.encoding.size)}
                  </p>
                )}
                {currentDraft.musicPlan && <p className="music-ending-summary">Music ending: {currentDraft.musicPlan.ending}</p>}
                <p>{formatTime(currentDraft.duration)} - {currentDraft.style}{selectedAudioAsset ? ` - ${selectedAudioAsset.name}` : " - Game audio only"}</p>
                {currentDraft.exportPath && (
                  <div className="export-location">
                    <span title={currentDraft.exportPath}>{currentDraft.exportPath}</span>
                    {window.highlightAI?.showItemInFolder && <button onClick={() => void window.highlightAI?.showItemInFolder(currentDraft.exportPath!)}><FolderSearch size={14} /> Show in Explorer</button>}
                  </div>
                )}
              </section>
            )}

          </div>

          <div className="simple-create-footer">
            <div className={`selection-status ${generationReady ? "ready" : ""}`}>
              {generationReady ? <Check size={17} /> : <AlertTriangle size={17} />}
              <span>{selectionReady
                ? `${generationSourceLabel} ready`
                : folderImportActive ? "Footage is still being analyzed" : selectedVideoIds.length ? "Selected clips are still being analyzed" : "No confirmed clips are ready yet"}</span>
            </div>
            <button className="generate-button" disabled={!project || !recommendedIdea || !generationReady || generating || renderActive} onClick={() => recommendedIdea && void createDraft(recommendedIdea)}>
              {generating || renderActive
                ? <><LoaderCircle size={19} /> Generating...</>
                : <><Sparkles size={19} /> Generate video</>}
            </button>
            <small className="duration-note"><Clock3 size={14} /> AI chooses the best duration, up to 5 minutes.</small>
          </div>
        </aside>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <input ref={recordingInput} hidden multiple type="file" accept="video/*" onChange={(e) => importFiles(e.target.files)} />
      <input
        ref={folderInput}
        hidden
        multiple
        type="file"
        accept="video/*"
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => importFiles(e.target.files)}
      />
      <input ref={assetInput} hidden multiple type="file" accept="audio/*,image/*,.cube" onChange={(e) => void importAssets(e.target.files)} />

      <header className="topbar">
        <button className="brand" onClick={reset}>
          <span className="brand-mark"><Sparkles size={18} /></span>
          <span>Highlight<span>AI</span></span>
        </button>
        <nav>
          <button className="ghost-button" onClick={openMusicBrowser}><Music2 size={16} /> Music <span>{audioAssets.length || ""}</span></button>
          <button className="icon-button" aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`} title={`Use ${theme === "dark" ? "light" : "dark"} theme`} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
          <button className="icon-button" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button>
        </nav>
      </header>

      {appRoute === "review" ? renderHighlightReviewPage() : renderDashboard()}

      <main className="legacy-ui" hidden aria-hidden="true">
        {stage === "start" && (
          <section className="start-screen">
            <div className="eyebrow"><span /> Your footage, finished</div>
            <h1>Turn game recordings<br />into <em>great highlights.</em></h1>
            <p className="hero-copy">Choose your footage. AI finds what matters, recommends the best direction, and creates the edit for you.</p>
            <div className="intake-grid">
              <button className="intake-card primary-intake" onClick={() => recordingInput.current?.click()}>
                <span className="intake-icon"><Upload size={24} /></span>
                <strong>Upload videos</strong>
                <small>Select one or more recordings</small>
                <ChevronRight size={20} />
              </button>
              <button className="intake-card" onClick={() => void chooseLocalFolder()}>
                <span className="intake-icon"><FolderSearch size={24} /></span>
                <strong>Check a folder</strong>
                <small>Analyze in place without copying large folders</small>
                <ChevronRight size={20} />
              </button>
            </div>
            {operationIssue && (
              <div className="issue-card" role="alert"><AlertTriangle size={20} /><div><strong>{operationIssue.title}</strong><p>{operationIssue.message}</p>{operationIssue.action && <small>{operationIssue.action}</small>}</div></div>
            )}
            <div className="path-panel">
              <div className="path-panel-header">
                <div><span>Added paths</span><strong>{addedPathProjects.length ? "Click a folder to view its contents" : "No folders added yet"}</strong></div>
                <button onClick={() => void chooseLocalFolder()}><Plus size={14} /> Add path</button>
              </div>
              {addedPathProjects.length ? (
                <div className="path-list">
                  {addedPathProjects.slice(0, 6).map((item) => (
                    <button key={item.id} onClick={() => void openSavedPath(item)}>
                      <FolderSearch size={16} />
                      <div><strong>{item.name}</strong><small>{item.sourcePath} - {item.files.length} video{item.files.length === 1 ? "" : "s"}</small></div>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </div>
              ) : <p>Add a gameplay folder once. HighlightAI records the path and lets you reopen its indexed contents from here.</p>}
            </div>
            <div className="prompt-box">
              <WandSparkles size={20} />
              <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Or tell AI what you want to create..." />
              <button onClick={() => recordingInput.current?.click()}><ArrowRight size={18} /></button>
            </div>
            <div className="suggestion-row">
              {suggestions.map((item) => <button key={item} onClick={() => setPrompt(item)}>{item}</button>)}
            </div>
            <div className="promise-row">
              <span><Check size={15} /> Local-first analysis</span>
              <span><Check size={15} /> No editing skills needed</span>
              <span><Check size={15} /> Sources stay untouched</span>
            </div>
            {recentNonPathProjects.length > 0 && (
              <div className="recent-projects">
                <span>Continue a local project</span>
                {recentNonPathProjects.slice(0, 3).map((item) => (
                  <button key={item.id} onClick={() => resumeProject(item)}>
                    <Video size={15} /><div><strong>{item.name}</strong><small>{item.files.length} recordings - {item.drafts.length} drafts</small></div><ChevronRight size={16} />
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {stage === "preflight" && (
          <section className="preflight-screen workspace">
            <button className="back-button" onClick={reset}><ArrowLeft size={18} /></button>
            <div className="eyebrow"><span /> Review before processing</div>
            <h2>{pendingFiles.length} video{pendingFiles.length === 1 ? "" : "s"} ready to check.</h2>
            <p>HighlightAI copies each video into its local workspace, verifies it, and preserves completed work if another file fails.</p>
            <div className="preflight-grid">
              <article><Video size={20} /><strong>{pendingFiles.length}</strong><span>videos selected</span></article>
              <article><HardDrive size={20} /><strong>{formatBytes(selectedBytes)}</strong><span>local footage to copy</span></article>
              <article><ShieldCheck size={20} /><strong>Local</strong><span>no cloud upload during built-in analysis</span></article>
            </div>
            {diagnostics?.freeBytes !== null && diagnostics && selectedBytes > diagnostics.freeBytes * 0.8 && (
              <div className="issue-card warning"><AlertTriangle size={20} /><div><strong>Disk space may be too low</strong><p>This import needs {formatBytes(selectedBytes)} and the local workspace reports {formatBytes(diagnostics.freeBytes)} free.</p></div></div>
            )}
            {selectedBytes >= 10 * 1024 ** 3 && (
              <div className="large-batch-note"><HardDrive size={18} /><div><strong>Large folder mode</strong><span>Progress is saved after every file. Verification may take a while, but one damaged video will not discard the rest.</span></div></div>
            )}
            {operationIssue && (
              <div className="issue-card" role="alert"><AlertTriangle size={20} /><div><strong>{operationIssue.title}</strong><p>{operationIssue.message}</p>{operationIssue.action && <small>{operationIssue.action}</small>}</div></div>
            )}
            <div className="preflight-actions">
              <button className="secondary-action" onClick={() => folderInput.current?.click()}>Choose another folder</button>
              <button className="primary-action" onClick={() => void startImport()}><Sparkles size={17} /> Start processing</button>
            </div>
            <div className="capability-note"><WandSparkles size={17} /><span><strong>What AI sees:</strong> built-in analysis reads video/audio technical signals. It does not semantically watch frames. Connect Ollama in Settings for optional open-source AI advice.</span></div>
          </section>
        )}

        {stage === "analyzing" && (
          <section className="analyzing-screen" aria-live="polite">
            <div className="scanner">
              <div className="scanner-core"><Video size={42} /></div>
              <span className="orbit orbit-one" />
              <span className="orbit orbit-two" />
            </div>
            <div className="eyebrow"><span /> {ingestProgress?.phase === "probing" ? "Verifying videos" : "Copying locally"}</div>
            <h2>{ingestProgress?.phase === "probing" ? "Checking every recording." : "Preparing your footage."}</h2>
            <p>{ingestProgress?.currentFile || "Starting the durable import job..."}</p>
            <div className="progress determinate"><span style={{ width: `${Math.max(2, ingestPercent)}%` }} /></div>
            <strong className="progress-number">{Math.min(100, ingestPercent)}%</strong>
            <div className="progress-stats">
              <span><strong>{ingestProgress?.uploadedFiles || 0}/{ingestProgress?.totalFiles || pendingFiles.length}</strong> available</span>
              <span><strong>{ingestProgress?.processedFiles || 0}/{ingestProgress?.totalFiles || pendingFiles.length}</strong> analyzed</span>
              <span><strong>{formatBytes(uploadBytes)}</strong> / {formatBytes(selectedBytes)}</span>
              <span><strong>{ingestEta || "Estimating"}</strong> remaining</span>
            </div>
            {ingestProgress?.processingConcurrency && <small>Using {ingestProgress.processingConcurrency} background worker{ingestProgress.processingConcurrency === 1 ? "" : "s"}; progress is saved after every file.</small>}
            {ingestProgress?.activeFiles?.length ? <small>Active: {ingestProgress.activeFiles.join(", ")}</small> : null}
            <small>Copied only to your local HighlightAI workspace. Source recordings stay untouched.</small>
            <div className="long-task-actions">
              <button className="secondary-action" disabled={pausePending.ingest} onClick={() => void toggleImportPause()}>
                {ingestProgress?.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
                {ingestProgress?.status === "paused" ? "Resume" : "Pause"}
              </button>
              <button className="cancel-action" onClick={stopImport}>Cancel safely</button>
            </div>
          </section>
        )}

        {stage === "advice" && analysis && (
          <section className="workspace advice-screen">
            <div className="workspace-path-panel">
              <div>
                <span>Current path</span>
                <strong>{project?.sourcePath || project?.name || "Selected footage"}</strong>
                <small>{project?.files.length || 0} videos loaded in this workspace</small>
              </div>
              <div className="workspace-path-actions">
                <button onClick={() => void chooseLocalFolder()}><Plus size={14} /> Add path</button>
                <button onClick={reset}>All paths</button>
              </div>
            </div>
            <div className="section-heading">
              <button className="back-button" onClick={reset}><ArrowLeft size={18} /></button>
              <div><div className="eyebrow"><span /> AI assessment ready</div><h2>You have the ingredients<br />for a strong highlight.</h2></div>
              <div className="quality-score"><strong>{analysis.qualityScore}</strong><span>Footage<br />quality</span></div>
            </div>
            {folderImportActive && (
              <div className="inline-progress-card">
                <div>
                  <strong>Folder contents loaded. Analyzing videos in the background.</strong>
                  <span>{ingestProgress?.processedFiles || 0}/{ingestProgress?.totalFiles || project?.files.length || 0} analyzed - {ingestProgress?.currentFile || "Preparing next file"} - {ingestEta || "Estimating"} remaining</span>
                </div>
                <div className="progress determinate"><span style={{ width: `${Math.max(2, ingestPercent)}%` }} /></div>
              </div>
            )}
            <div className="insight-grid">
              <div className="insight-card"><Gauge size={19} /><strong>{analysis.actionMoments}</strong><span>high-value moments found</span></div>
              <div className="insight-card"><Layers3 size={19} /><strong>{recordings.length}</strong><span>recordings ready to use</span></div>
              <div className="insight-card"><ShieldCheck size={19} /><strong>Local</strong><span>analysis protected your files</span></div>
            </div>
            <div className="advice-note">
              <Sparkles size={18} />
              <div><strong>My advice</strong><p>{analysis.notes[2]} Start with one of these directions; each is designed to stay comfortably under the 5-minute limit.</p></div>
            </div>
            <div className="advanced-advice">
              <div><WandSparkles size={18} /><span><strong>Optional open-source or cloud AI</strong><small>Connect Ollama or another OpenAI-compatible server. This version sends metadata and your prompt, not video frames.</small></span></div>
              <button onClick={() => void askAdvancedAi()}>{textAiConfig.endpoint && textAiConfig.model ? "Ask for advice" : "Configure"}</button>
              {advancedAdvice && <p>{advancedAdvice}</p>}
            </div>
            <div className="advanced-advice">
              <div><Video size={18} /><span><strong>Review sampled frames with AI</strong><small>Explicit opt-in. Sends candidate JPEG frames to your configured multimodal model and rejects menus, death states, and unreadable shots.</small></span></div>
              <button onClick={() => void runVisionReview()}>Run vision review</button>
            </div>
            <div className="preprocess-card">
              <div className="preprocess-header">
                <div><FolderSearch size={18} /><span><strong>Build reusable fast index</strong><small>Runs in the background after folder import. Scans low-resolution proxy signals, stores candidate story windows, and lets new drafts use the database instantly.</small></span></div>
                <div className="preprocess-actions">
                  {fastIndexJob && ["processing", "paused"].includes(fastIndexJob.status)
                    ? <>
                        <button className="secondary-action" disabled={pausePending["fast-index"]} onClick={() => void toggleFastIndexPause()}>
                          {fastIndexJob.status === "paused" ? <Play size={13} /> : <Pause size={13} />}
                          {fastIndexJob.status === "paused" ? "Resume" : "Pause"}
                        </button>
                        <button className="secondary-action" onClick={stopFastIndex}>Cancel</button>
                      </>
                    : <button onClick={() => void startFastIndex()}>Run fast index</button>}
                </div>
              </div>
              <div className="preprocess-metrics">
                <span><strong>{fastIndexEstimate ? `${fastIndexEstimate.files}/${fastIndexEstimate.totalProjectFiles}` : project?.fastIndex ? `${fastIndexCounts.processed}/${fastIndexCounts.total}` : "..."}</strong> files</span>
                <span><strong>{fastIndexEstimate?.concurrency ?? fastIndexJob?.concurrency ?? 3}</strong> workers</span>
                <span><strong>{fastIndexEta || "..."}</strong> estimate</span>
                <span><strong>{fastIndexEstimate ? formatBytes(fastIndexEstimate.storageBytes) : "small"}</strong> index storage</span>
                <span><strong>{fastIndexJob?.candidateWindows ?? project?.fastIndex?.candidateWindows ?? 0}</strong> candidate windows</span>
                <span><strong>{project?.fastIndex?.status || fastIndexJob?.status || "not started"}</strong> status</span>
              </div>
              {(fastIndexJob || project?.fastIndex?.status === "processing") && (
                <>
                  <div className="progress determinate preprocess-progress"><span style={{ width: `${Math.max(2, fastIndexPercent)}%` }} /></div>
                  <div className="preprocess-live">
                    <span>{fastIndexCounts.processed}/{fastIndexCounts.total} files scanned</span>
                    <span>{fastIndexJob?.candidateWindows ?? project?.fastIndex?.candidateWindows ?? 0} candidate windows</span>
                    <span>{fastIndexJob?.currentFile || project?.fastIndex?.phase || "background index"}</span>
                    <span>{fastIndexEta || "Estimating"} remaining</span>
                  </div>
                </>
              )}
              <p>This is the under-10-minute path: it does not call a slow vision model for every frame. It creates a reusable local database first, then the VLM only reviews the best candidates when needed.</p>
            </div>
            <div className="preprocess-card">
              <div className="preprocess-header">
                <div><Video size={18} /><span><strong>Rate the best candidates with a vision model</strong><small>Background job. The app shortlists likely candidates, then your vision model rates sampled frames and stores semantic action events for future drafts.</small></span></div>
                <div className="preprocess-actions">
                  <button onClick={() => void checkConfiguredModel("vision")}>{visionModelStatus ? "Vision model reachable" : "Check vision model"}</button>
                  {preprocessJob && ["processing", "paused"].includes(preprocessJob.status)
                    ? <>
                        <button className="secondary-action" disabled={pausePending.vision} onClick={() => void toggleSemanticPause()}>
                          {preprocessJob.status === "paused" ? <Play size={13} /> : <Pause size={13} />}
                          {preprocessJob.status === "paused" ? "Resume" : "Pause"}
                        </button>
                        <button className="secondary-action" onClick={stopSemanticPreprocess}>Cancel</button>
                      </>
                    : <button onClick={() => void startSemanticPreprocess()}>Start AI preprocess</button>}
                </div>
              </div>
              <div className="preprocess-metrics">
                <span><strong>{preprocessEstimate?.files ?? "..."}</strong> videos to check</span>
                <span><strong>{preprocessEstimate ? formatBytes(preprocessEstimate.storageBytes) : "..."}</strong> temporary cache</span>
                <span><strong>{preprocessEstimate?.concurrency ?? 2}</strong> workers</span>
                <span><strong>{preprocessEta || "..."}</strong> estimate</span>
                <span><strong>{preprocessEstimate ? `${preprocessEstimate.files}/${preprocessEstimate.totalProjectFiles}` : "..."}</strong> videos still need AI</span>
                <span><strong>{semanticReadyFiles}</strong> verified videos</span>
              </div>
              {preprocessJob && (
                <>
                  <div className="progress determinate preprocess-progress"><span style={{ width: `${Math.max(2, preprocessPercent)}%` }} /></div>
                  <div className="preprocess-live">
                    <span>{folderVideosChecked}/{folderVideosTotal} videos checked</span>
                    <span>{preprocessJob.approvedFrames} approved samples</span>
                    <span>{preprocessJob.eventsFound} events found</span>
                    <span>{preprocessJob.currentFile || preprocessJob.phase}</span>
                  </div>
                </>
              )}
              <p>For Ollama, use a vision-capable model. If no model is installed, this step fails fast and Settings shows the local setup command.</p>
            </div>
            <div className="video-library">
              <div className="library-header">
                <div><span>Path contents</span><h3>Choose source videos</h3><small>Showing all {rankedLibrary.length} videos from this path. {selectedVideoIds.length} selected for the next edit.</small></div>
                <button onClick={selectDiversifiedClips}><Sparkles size={15} /> I'm feeling lucky</button>
              </div>
              {selectedVideoIds.length < 1
                ? <div className="selection-warning"><AlertTriangle size={15} /> Select at least one video before creating a trailer.</div>
                : <div className="selection-warning ok"><Check size={15} /> Ready: {selectedVideos.length} videos selected for the next draft.</div>}
              {selectedRejectedVideos.length > 0 && (
                <div className="issue-card compact generation-visible-alert" role="status">
                  <ShieldCheck size={18} />
                  <div><strong>Manual AI-flag override active</strong><p>{selectedRejectedVideos.length} flagged clip{selectedRejectedVideos.length === 1 ? " is" : "s are"} included because you selected it manually.</p></div>
                </div>
              )}
              <div className="library-grid">
                {rankedLibrary.map((file) => {
                  const selected = selectedVideoIds.includes(file.id);
                  const generated = looksLikeGeneratedExport(file.name);
                  const tags = generated ? ["generated export", ...(file.metadata?.indexTags || [])] : file.metadata?.indexTags?.length ? file.metadata.indexTags : ["pending", "video"];
                  return (
                    <button key={file.id} className={`library-card ${selected ? "selected" : ""}`} onClick={() => toggleVideoSelection(file.id)}>
                      <div className="library-card-top"><strong>{file.name.replace(/\.[^.]+$/, "")}</strong><span title={`${scoreLabel(file)} highlight score`}>{scoreLabel(file) === "Local signal" ? "Local" : scoreLabel(file) === "Pending review" ? "Pending review" : "AI"} {highlightScore(file)}</span></div>
                      <p>{file.metadata?.indexDescription || (file.metadata?.duration ? `Indexed gameplay clip. Best signal around ${formatTime(file.metadata?.highlightStart || 0)}.` : "Waiting for background analysis.")}</p>
                      <div className="tag-row">{tags.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}</div>
                      <small>{file.metadata?.candidateWindows?.length || 0} candidate windows - {file.metadata?.duration ? formatTime(file.metadata.duration) : "pending analysis"}</small>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="ideas-header"><div><span>Recommended directions</span><h3>What should we make?</h3></div><small>Pick one. I'll handle the edit.</small></div>
            <div className="ideas-grid">
              {analysis.ideas.map((idea, index) => (
                <button className="idea-card" key={idea.id} onClick={() => createDraft(idea)}>
                  <div className="idea-visual" style={{ "--accent": idea.accent } as React.CSSProperties}>
                    <span className="idea-number">0{index + 1}</span>
                    <span className="idea-format">{idea.format}</span>
                    <Play size={25} fill="currentColor" />
                  </div>
                  <div className="idea-copy">
                    <div><span>{idea.style}</span><span>{idea.score}% match</span></div>
                    <h4>{idea.title}</h4>
                    <p>{idea.description}</p>
                    <footer><span><Clock3 size={14} /> {formatTime(idea.duration)}</span><span>{idea.moments} moments</span><ChevronRight size={18} /></footer>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {stage === "drafts" && drafts.length > 0 && (
          <section className="draft-screen">
            <aside className="draft-sidebar">
              <button className="back-button" onClick={() => setStage("advice")}><ArrowLeft size={18} /></button>
              <div className="eyebrow"><span /> Drafts ready</div>
              <h2>Pick your favorite.</h2>
              <p>Each version uses the same best moments with a different creative direction.</p>
              <div className="draft-list">
                {drafts.map((draft, index) => (
                  <button key={draft.id} className={activeDraft === index ? "active" : ""} onClick={() => setActiveDraft(index)}>
                    <span>0{index + 1}</span><div><strong>{draft.title}</strong><small>{formatTime(draft.duration)} - {draft.style}</small></div><ChevronRight size={17} />
                  </button>
                ))}
              </div>
              <button className="asset-button" onClick={() => assetInput.current?.click()}><Plus size={17} /> Add local music or assets</button>
              <button className="asset-button public-asset-button" onClick={() => void searchPublicAssets()}><Search size={17} /> Find public music</button>
              <div className="license-note"><ShieldCheck size={16} /><span>Public assets require a license check before export.</span></div>
            </aside>
            <div className="preview-column">
              <div className={`video-preview ${drafts[activeDraft].format === "Vertical" ? "vertical" : ""}`} style={{ "--accent": drafts[activeDraft].accent } as React.CSSProperties}>
                {(drafts[activeDraft].exportUrl || project?.files[0]) && (
                  <video
                    className="real-preview"
                    src={drafts[activeDraft].exportUrl
                      ? localMediaUrl(drafts[activeDraft].exportUrl)
                      : sourceVideoUrl(project!.files[0])}
                    controls
                    preload="metadata"
                  />
                )}
                <div className="preview-top"><span>AI DRAFT - V{drafts[activeDraft].version}</span><span>{drafts[activeDraft].format}</span></div>
                <div className="preview-title"><small>{drafts[activeDraft].style} highlight</small><strong>{drafts[activeDraft].title}</strong><span>{drafts[activeDraft].moments} best moments - {formatTime(drafts[activeDraft].duration)}</span></div>
                <div className="preview-progress"><span /></div>
              </div>
              <div className="preview-actions">
                <button onClick={() => void createDraft(drafts[activeDraft])}><RotateCcw size={17} /> Regenerate</button>
                <button onClick={() => void cycleStyle()}><ImagePlus size={17} /> Change style</button>
                <button onClick={() => void reviewActiveDraft()}><Gauge size={17} /> AI review team</button>
                <button className="export-button" onClick={() => void exportDraft()}><Check size={17} /> {drafts[activeDraft].exportUrl ? "Open export" : "Render MP4"}</button>
              </div>
            </div>
            <aside className="refine-panel">
              <div className="refine-title"><MessageCircle size={19} /><div><strong>Refine with AI</strong><small>Just describe the change</small></div></div>
              <div className="change-list">
                {drafts[activeDraft].changes.slice(-4).map((change, index) => <div key={`${change}-${index}`}><Check size={14} /><span>{change}</span></div>)}
              </div>
              <div className="quick-edits">
                <span>Quick changes</span>
                {["Shorter", "More action", "More cinematic", "Different music"].map((item) => <button key={item} onClick={() => void refineDraft(item)}>{item}<Plus size={14} /></button>)}
              </div>
              {drafts[activeDraft].review && (
                <div className="review-card">
                  <div><Gauge size={17} /><span>Review team</span><strong>{drafts[activeDraft].review.averageScore}/100</strong></div>
                  <small>{drafts[activeDraft].review.approved ? "Approved for export" : drafts[activeDraft].review.revisionPlan || "Needs another edit pass before final export."}</small>
                </div>
              )}
              <div className="mix-card"><div><Music2 size={17} /><span>Audio mix</span><strong>{drafts[activeDraft].music}</strong></div><div className="mix-bar"><span style={{ width: `${drafts[activeDraft].intensity}%` }} /></div><small>AI balanced game audio, music, and impacts.</small></div>
              <div className="chat-input"><input value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void refineDraft(prompt)} placeholder="Make the opening more intense..." /><button onClick={() => void refineDraft(prompt)}><Send size={17} /></button></div>
            </aside>
          </section>
        )}
      </main>

      {false && highlightReview && activeHighlightReviewItem && activeHighlightTrim && (
        <div className="modal-backdrop media-viewer-backdrop" onClick={() => setHighlightReview(null)}>
          <section className="highlight-review-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span className="panel-label">Highlight confirmation</span>
                <h3>{activeHighlightReviewItem ? activeHighlightReviewItem.file.name.replace(/\.[^.]+$/, "") : "Picked highlight parts"}</h3>
                <p>{activeHighlightReviewItem && activeHighlightTrim
                  ? `${highlightReview!.index + 1} of ${highlightReview!.items.length} - ${activeHighlightReviewItem.label} - ${formatTime(activeHighlightTrim.start)}-${formatTime(activeHighlightTrim.end)}`
                  : `${selectedConfirmedHighlightParts.length} confirmed part${selectedConfirmedHighlightParts.length === 1 ? "" : "s"} ready`}</p>
              </div>
              <button aria-label="Close highlight review" onClick={() => setHighlightReview(null)}><X size={20} /></button>
            </header>
            <div className="highlight-review-workspace">
              <div className="highlight-review-stage">
                {activeHighlightReviewItem && activeHighlightTrim ? (
                  <>
                    <video
                      ref={highlightReviewVideo}
                      src={sourceVideoUrl(activeHighlightReviewItem.file)}
                      controls
                      preload="metadata"
                      onTimeUpdate={handleHighlightReviewTime}
                      onPause={() => {
                        clearHighlightPlaybackGuard();
                        setHighlightReviewPlaying(false);
                      }}
                      onEnded={() => {
                        clearHighlightPlaybackGuard();
                        setHighlightReviewPlaying(false);
                      }}
                    />
                    <div className="highlight-trim-box" aria-label="Video cut controls">
                      <div className="highlight-trim-line">
                        <label>
                          <span>Start</span>
                          <strong>{formatTime(activeHighlightTrim.start)}</strong>
                        </label>
                        <input
                          aria-label="Trim start"
                          type="range"
                          min={0}
                          max={Math.max(0, (activeHighlightReviewItem.file.metadata?.duration || activeHighlightReviewItem.end) - 1)}
                          step="0.1"
                          value={activeHighlightTrim.start}
                          onChange={(event) => updateHighlightTrim("start", Number(event.target.value))}
                        />
                        <ArrowRight className="trim-arrow" size={16} />
                        <label>
                          <span>End</span>
                          <strong>{formatTime(activeHighlightTrim.end)}</strong>
                        </label>
                        <input
                          aria-label="Trim end"
                          type="range"
                          min={1}
                          max={activeHighlightReviewItem.file.metadata?.duration || activeHighlightReviewItem.end}
                          step="0.1"
                          value={activeHighlightTrim.end}
                          onChange={(event) => updateHighlightTrim("end", Number(event.target.value))}
                        />
                      </div>
                      <small>Do you agree this is a highlight period? Cut bad lead-in or tail before confirming. Generation will use this trimmed period first.</small>
                    </div>
                    <footer className="highlight-review-controls">
                      <button disabled={highlightReview!.index === 0} onClick={() => moveHighlightReview(-1)}><ArrowLeft size={16} /> Previous</button>
                      <button onClick={highlightReviewPlaying ? stopHighlightReview : playHighlightReview}>
                        {highlightReviewPlaying ? <Square size={16} /> : <Play size={16} fill="currentColor" />}
                        {highlightReviewPlaying ? "Stop" : "Play period"}
                      </button>
                      <button disabled={highlightReview!.index >= highlightReview!.items.length - 1} onClick={() => moveHighlightReview(1)}>Next <ArrowRight size={16} /></button>
                      <button onClick={() => void skipCurrentHighlightThisTime()}><X size={16} /> Skip this time</button>
                      <button className="reject-highlight-button" onClick={() => void rejectCurrentHighlightAsNotHighlight()}><Trash2 size={16} /> Not a highlight</button>
                      <button className="confirm-highlight-button" onClick={() => void confirmCurrentHighlight()}><Check size={16} /> {activeHighlightReviewItem.confirmed ? "Confirmed" : "Agree, use it"}</button>
                    </footer>
                  </>
                ) : (
                  <div className="highlight-review-empty">
                    <Check size={24} />
                    <strong>{selectedConfirmedHighlightParts.length ? "Review complete" : "No picked parts yet"}</strong>
                    <span>{selectedConfirmedHighlightParts.length ? "Check the picked parts list, add more if needed, then generate." : "Add more candidates or close this window."}</span>
                  </div>
                )}
              </div>
              <aside className="picked-highlight-panel">
                <div>
                  <span className="panel-label">Picked parts</span>
                  <strong>{selectedConfirmedHighlightParts.length} confirmed</strong>
                </div>
                <div className="picked-highlight-list">
                  {selectedConfirmedHighlightParts.length ? selectedConfirmedHighlightParts.map(({ file, moment, id }) => (
                    <article key={id}>
                      <strong>{file.name.replace(/\.[^.]+$/, "")}</strong>
                      <small>{formatTime(moment.start)}-{formatTime(moment.end)} - {moment.action || moment.source || "highlight"}</small>
                      <button onClick={() => reconfirmHighlightPart(file, moment)}><RotateCcw size={14} /> Reconfirm</button>
                    </article>
                  )) : <p>No confirmed highlight parts yet.</p>}
                </div>
                <div className="picked-highlight-actions">
                  {renderReviewMusicCoveragePrompt()}
                  <button onClick={addMoreHighlightCandidates}><Plus size={16} /> Add more</button>
                  <button className="confirm-highlight-button" disabled={!recommendedIdea || !generationReady || generating || renderActive} onClick={() => void generateFromHighlightReview()}><Sparkles size={16} /> Generate video</button>
                </div>
              </aside>
            </div>
          </section>
        </div>
      )}

      {reviewGeneratePrompt && highlightReview && pendingReviewDraftId && (
        <div className="modal-backdrop" onClick={() => { setReviewGeneratePrompt(false); setReviewGeneratePromptDismissed(true); }}>
          <section className="asset-modal review-generate-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <div className="eyebrow"><span /> Ready to generate</div>
                <h3>Generate this reviewed video?</h3>
              </div>
              <button aria-label="Keep reviewing" onClick={() => { setReviewGeneratePrompt(false); setReviewGeneratePromptDismissed(true); }}><X size={18} /></button>
            </header>
            <div className="review-generate-summary">
              <Check size={22} />
              <div>
                <strong>{highlightReview.confirmed} approved part{highlightReview.confirmed === 1 ? "" : "s"} will be used</strong>
                <p>All planned parts are reviewed. HighlightAI will save your trimmed timeline and start rendering after you confirm.</p>
              </div>
            </div>
            <div className="review-generate-actions">
              <button onClick={() => { setReviewGeneratePrompt(false); setReviewGeneratePromptDismissed(true); }}>Keep reviewing</button>
              <button className="confirm-highlight-button" disabled={Boolean(reviewMusicCoveragePrompt) || generating || renderActive} onClick={() => void generateFromHighlightReview()}><Sparkles size={16} /> Generate now</button>
            </div>
          </section>
        </div>
      )}

      {previewVideo && (
        <div className="modal-backdrop media-viewer-backdrop" onClick={() => setPreviewVideo(null)}>
          <section className="media-viewer" onClick={(event) => event.stopPropagation()}>
            <header>
              <div><span className="panel-label">{previewVideo.generated ? "Generated video" : "Source clip"}</span><h3>{previewVideo.title}</h3></div>
              <button aria-label="Close preview" onClick={() => setPreviewVideo(null)}><X size={20} /></button>
            </header>
            <video src={previewVideo.url} controls autoPlay preload="metadata" />
            <footer>
              <span>{previewVideo.generated ? previewVideo.localPath || "This MP4 is saved in HighlightAI's local exports folder." : "Previewing the original source without modifying it."}</span>
              <div>
                {previewVideo.generated && previewVideo.localPath && window.highlightAI?.showItemInFolder && <button onClick={() => void window.highlightAI?.showItemInFolder(previewVideo.localPath!)}><FolderSearch size={16} /> Show in folder</button>}
                {previewVideo.generated && <a href={previewVideo.url} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open video</a>}
              </div>
            </footer>
          </section>
        </div>
      )}

      {generatedLibraryOpen && (
        <div className="modal-backdrop media-viewer-backdrop" onClick={() => setGeneratedLibraryOpen(false)}>
          <section className="generated-video-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <div><span className="panel-label">Generated videos</span><h3>Your finished videos</h3><p>{generatedVideos.length} saved video{generatedVideos.length === 1 ? "" : "s"} in this project.</p></div>
              <button aria-label="Close generated videos" onClick={() => setGeneratedLibraryOpen(false)}><X size={20} /></button>
            </header>
            <div className="generated-video-list">
              {generatedVideos.map((draft) => (
                <article key={draft.id}>
                  <button className="generated-video-play" aria-label={`Preview ${draft.title}`} onClick={() => { setGeneratedLibraryOpen(false); setPreviewVideo({ title: draft.title, url: localMediaUrl(draft.exportUrl!), generated: true, localPath: draft.exportPath }); }}>
                    <Play size={18} fill="currentColor" />
                  </button>
                  <div>
                    <strong>{draft.title}</strong>
                    <small>{formatTime(draft.duration)} - {draft.style} - MP4 ready</small>
                    {draft.exportPath && <span title={draft.exportPath}>{draft.exportPath}</span>}
                  </div>
                  <div className="generated-video-actions">
                    {draft.exportPath && window.highlightAI?.showItemInFolder && <button onClick={() => void window.highlightAI?.showItemInFolder(draft.exportPath!)}><FolderSearch size={15} /> Folder</button>}
                    <a href={localMediaUrl(draft.exportUrl!)} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open</a>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {assetBrowser && (
        <div className="modal-backdrop" onClick={() => setAssetBrowser(false)}>
          <section className="asset-modal" onClick={(event) => event.stopPropagation()}>
            <header><div><div className="eyebrow"><span /> Soundtrack</div><h3>Choose music for your video</h3></div><button aria-label="Close assets" onClick={() => setAssetBrowser(false)}><X size={18} /></button></header>
            <button className="local-music-button" onClick={() => assetInput.current?.click()}><Upload size={17} /><span><strong>Add music from this computer</strong><small>MP3, WAV, M4A, AAC, FLAC, or OGG</small></span><ChevronRight size={17} /></button>
            {audioAssets.length > 0 && (
              <div className="local-soundtracks">
                <span>Your music</span>
                {audioAssets.map((asset) => (
                  <button key={asset.id} className={selectedAudioAsset?.id === asset.id ? "selected" : ""} onClick={() => { setSelectedAudioAssetId(asset.id); setAssetBrowser(false); setNotice(`${asset.name} is selected as the soundtrack.`); }}>
                    <Music2 size={16} /><span><strong>{asset.name}</strong><small>{selectedAudioAsset?.id === asset.id ? "Selected for the next video" : "Use this soundtrack"}</small></span>{selectedAudioAsset?.id === asset.id ? <Check size={17} /> : <ChevronRight size={17} />}
                  </button>
                ))}
              </div>
            )}
            <div className="asset-divider"><span>or find public music</span></div>
            <div className="asset-search"><Search size={17} /><input value={assetQuery} onChange={(event) => setAssetQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void searchPublicAssets()} /><button onClick={() => void searchPublicAssets()}>Search</button></div>
            <p className="asset-disclaimer">Results come from Internet Archive items marked with Creative Commons metadata. Review the source and license before publishing.</p>
            <div className="public-results">
              {publicAudio.map((audio) => (
                <article key={audio.id}>
                  <Music2 size={18} /><div><strong>{audio.title}</strong><span>{audio.creator}</span><small>{audio.licenseUrl ? "License metadata available" : "License unclear - warning required"}</small></div>
                  <a href={audio.sourceUrl} target="_blank" rel="noreferrer" aria-label="Open source"><ExternalLink size={15} /></a>
                  <button onClick={() => void addPublicAsset(audio)}><Download size={15} /> Add</button>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <section className="asset-modal settings-modal" onClick={(event) => event.stopPropagation()}>
            <header><div><div className="eyebrow"><span /> AI settings</div><h3>AI settings</h3></div><button aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={18} /></button></header>
            <p className="settings-intro">Model keys stay on this computer. Vision AI limits apply to background checks and generation-time review.</p>

            <section className="settings-group">
              <div className="settings-group-title"><Video size={16} /><span>Vision AI</span><b className={visionModelStatus ? "connected" : ""}>{visionModelStatus ? "Connected" : "Current"}</b></div>
              <div className="settings-list">
                <label className="settings-row">
                  <span><strong>Endpoint</strong><small>{visionAiConfig.endpoint || "OpenAI-compatible URL"}</small></span>
                  <input value={visionAiConfig.endpoint} onChange={(event) => setVisionAiConfig({ ...visionAiConfig, endpoint: event.target.value })} />
                </label>
                <label className="settings-row">
                  <span><strong>Model</strong><small>{visionAiConfig.model || "Vision-capable model"}</small></span>
                  <input value={visionAiConfig.model} onChange={(event) => setVisionAiConfig({ ...visionAiConfig, model: event.target.value })} />
                </label>
                <label className="settings-row">
                  <span><strong>Review workload</strong><small>How hard Vision AI checks each clip</small></span>
                  <select value={visionReviewMode} onChange={(event) => setVisionReviewMode(event.target.value as VisionReviewMode)}>
                    <option value="light">Light</option>
                    <option value="balanced">Balanced</option>
                    <option value="thorough">Thorough</option>
                  </select>
                </label>
                <label className="settings-row">
                  <span><strong>AI workers</strong><small>Parallel model requests</small></span>
                  <select aria-label="AI workers" value={aiResourceLimits.maxVisionWorkers} onChange={(event) => setAiResourceLimits((current) => normalizeAiResourceLimits({ ...current, maxVisionWorkers: Number(event.target.value) }))}>
                    {[1, 2, 3, 4, 5, 6].map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                <label className="settings-row">
                  <span><strong>Frames per video</strong><small>More frames can improve decisions</small></span>
                  <select aria-label="Frames per video" value={aiResourceLimits.maxFramesPerVideo} onChange={(event) => setAiResourceLimits((current) => normalizeAiResourceLimits({ ...current, maxFramesPerVideo: Number(event.target.value) }))}>
                    {[3, 4, 6, 8, 10, 12, 16, 18].map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                <label className="settings-row">
                  <span><strong>Videos per run</strong><small>Limit each background batch</small></span>
                  <select aria-label="Videos per run" value={aiResourceLimits.maxVideosPerRun} onChange={(event) => setAiResourceLimits((current) => normalizeAiResourceLimits({ ...current, maxVideosPerRun: Number(event.target.value) }))}>
                    <option value={0}>All pending</option>
                    <option value={4}>4 videos</option>
                    <option value={8}>8 videos</option>
                    <option value={12}>12 videos</option>
                    <option value={24}>24 videos</option>
                    <option value={50}>50 videos</option>
                  </select>
                </label>
                <label className="settings-row">
                  <span><strong>API key</strong><small>Leave blank for Ollama</small></span>
                  <input type="password" value={visionAiConfig.apiKey} onChange={(event) => setVisionAiConfig({ ...visionAiConfig, apiKey: event.target.value })} />
                </label>
                <div className="settings-row readonly">
                  <span><strong>Effective cap</strong><small>{localOllamaWorkerCap ? "Local Ollama uses one active model request." : "Cloud or LAN endpoint can use multiple workers."}</small></span>
                  <em>{visionResourceSummary}</em>
                </div>
                <button className="settings-row action" disabled={modelTestState.vision.state === "testing"} onClick={() => void checkConfiguredModel("vision")}>
                  <span><strong>{visionModelStatus ? "Test again" : "Test vision model"}</strong><small>{modelTestState.vision.message || "Check the configured endpoint"}</small></span>
                  {modelTestState.vision.state === "testing" ? <LoaderCircle size={15} /> : <ChevronRight size={16} />}
                </button>
                <button className="settings-row action" disabled={modelTestState.vision.state === "testing"} onClick={() => void checkOllamaAndRetry()}>
                  <span><strong>Check Ollama again</strong><small>Use after starting Ollama yourself</small></span>
                  {modelTestState.vision.state === "testing" ? <LoaderCircle size={15} /> : <RotateCcw size={15} />}
                </button>
              </div>
            </section>

            <section className="settings-group">
              <div className="settings-group-title"><MessageCircle size={16} /><span>Text AI</span><b className={textModelStatus ? "connected" : ""}>{textModelStatus ? "Connected" : "Optional"}</b></div>
              <div className="settings-list">
                <label className="settings-row">
                  <span><strong>Endpoint</strong><small>{textAiConfig.endpoint || "OpenAI-compatible URL"}</small></span>
                  <input value={textAiConfig.endpoint} onChange={(event) => setTextAiConfig({ ...textAiConfig, endpoint: event.target.value })} />
                </label>
                <label className="settings-row">
                  <span><strong>Model</strong><small>{textAiConfig.model || "Creative advice model"}</small></span>
                  <input value={textAiConfig.model} onChange={(event) => setTextAiConfig({ ...textAiConfig, model: event.target.value })} />
                </label>
                <label className="settings-row">
                  <span><strong>API key</strong><small>Required by most cloud providers</small></span>
                  <input type="password" value={textAiConfig.apiKey} onChange={(event) => setTextAiConfig({ ...textAiConfig, apiKey: event.target.value })} />
                </label>
                <button className="settings-row action" disabled={modelTestState.text.state === "testing"} onClick={() => void checkConfiguredModel("text")}>
                  <span><strong>{textModelStatus ? "Test again" : "Test text model"}</strong><small>{modelTestState.text.message || "Optional creative advice model"}</small></span>
                  {modelTestState.text.state === "testing" ? <LoaderCircle size={15} /> : <ChevronRight size={16} />}
                </button>
              </div>
            </section>
            <button className="save-settings" onClick={saveSettings}>Save locally</button>
          </section>
        </div>
      )}
      {busy && <div className="activity-indicator" aria-live="polite"><LoaderCircle size={19} /><div><strong>{busy}</strong><span>You can keep using HighlightAI.</span></div></div>}
      {notice && <div className="toast" key={notice}><Sparkles size={16} /><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice("")}><X size={15} /></button></div>}
    </div>
  );
}

export default App;
