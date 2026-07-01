import { MAX_HIGHLIGHT_DURATION } from "../config/policy";
import { formatTime } from "./analyzer";
import { maxSemanticReviewAttempts, semanticReviewVersion } from "./aiSettings";
import type { Draft, MediaAsset, Segment } from "../types";

export type HighlightReviewItem = {
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

export type HighlightReviewSession = {
  items: HighlightReviewItem[];
  index: number;
  total: number;
  reviewed: number;
  confirmed: number;
};

export type ConfirmedHighlightMoment = {
  start: number;
  end: number;
  duration?: number;
  score?: number;
  state?: string;
  action?: string;
  storyRole?: string;
  source?: string;
};

export type HighlightDiscard = { fileId: string; start: number; end: number; duration: number; source: string; reason: "skip-this-time" };

export function usefulTags(file: MediaAsset) {
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

export function metadataIntervalEnd(item: { start?: number; end?: number; duration?: number }) {
  const start = Number(item?.start) || 0;
  return Number(item?.end) || start + (Number(item?.duration) || 0);
}

export function overlapsRejectedMoment(metadata: MediaAsset["metadata"], start = 0, end = start) {
  return (metadata?.rejectedHighlightMoments || []).some((item) =>
    item.reason === "not-highlight" &&
    Math.max(Number(item.start) || 0, start) < Math.min(metadataIntervalEnd(item), end) - 0.75
  );
}

export function hasStrongSemanticSummary(metadata: MediaAsset["metadata"]) {
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

export function hasFinalSemanticReview(file: MediaAsset) {
  const metadata = file.metadata;
  if (!metadata || metadata.semanticReviewLastError) return false;
  const attemptVersion = Number(metadata.semanticReviewAttemptVersion || 0);
  const attempts = attemptVersion === semanticReviewVersion ? Number(metadata.semanticReviewAttempts || 0) : 0;
  return metadata.semanticFineReviewed === true || attempts >= maxSemanticReviewAttempts;
}

export function hasBoringSemanticEvidence(file: MediaAsset) {
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

export function hasRecoverableGameplaySignal(file: MediaAsset) {
  const metadata = file.metadata;
  if (!metadata?.duration || metadata.videoCodec === "pending") return false;
  if (hasBoringSemanticEvidence(file)) return false;
  return Number(metadata.indexScore || 0) >= 30 || Number(metadata.actionScore || 0) >= 20;
}

export function hasAutoUsableHighlightCandidate(file: MediaAsset) {
  const metadata = file.metadata;
  if (!metadata) return false;
  if (metadata.aiDecision === "rejected" || hasBoringSemanticEvidence(file)) return false;
  if (metadata.aiDecision === "confirmed") return true;
  if ((metadata.confirmedHighlightMoments || []).length > 0) return true;
  if ((metadata.semanticCandidateHistory || []).some((event) => Number(event.score || 0) >= 64 && !overlapsRejectedMoment(metadata, Number(event.start) || 0, metadataIntervalEnd(event)))) return true;
  if ((metadata.candidateWindows || []).some((window) => Number(window.score || 0) >= 72 && !overlapsRejectedMoment(metadata, Number(window.start) || 0, metadataIntervalEnd(window)))) return true;
  return hasStrongSemanticSummary(metadata) || hasRecoverableGameplaySignal(file);
}

export function semanticState(file: MediaAsset) {
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

export function potentialMomentRanges(file: MediaAsset) {
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

export function potentialMomentSummary(file: MediaAsset) {
  const ranges = potentialMomentRanges(file);
  if (ranges.length) return `Potential moments: ${ranges.join(", ")}.`;
  const bestTime = reliableFocusTime(file);
  if (Number.isFinite(bestTime)) return `Potential highlight near ${formatTime(bestTime || 0)}.`;
  return "";
}

export function reliableFocusTime(file: MediaAsset) {
  const metadata = (file.metadata || {}) as NonNullable<MediaAsset["metadata"]>;
  const semanticEvents = [...(metadata.semanticEvents || []), ...(metadata.semanticCandidateHistory || [])];
  const weakVisionMiss = Number(metadata.semanticFramesReviewed || 0) > 0 &&
    !semanticEvents.length &&
    (metadata.ratingConfidence === "low" || metadata.semanticQuality === "missed" || Number(metadata.semanticScore || 0) < 25);
  if (weakVisionMiss && Number.isFinite(Number(metadata.highlightStart))) return Number(metadata.highlightStart);
  return Number(metadata.semanticTopFrame ?? metadata.highlightStart ?? metadata.duration / 2);
}

export function localSignalReviewWindow(file: MediaAsset, fallbackCenter: number, fallbackDuration: number) {
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

export function intervalsOverlapMeaningfully(a: { start: number; end: number }, b: { start: number; end: number }) {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  if (overlap <= 0) return false;
  const shorter = Math.max(1, Math.min(a.end - a.start, b.end - b.start));
  return overlap >= 5 || overlap / shorter >= 0.35;
}

export function confidenceFromScore(score: number, fallback: "high" | "medium" | "low" = "medium") {
  if (!Number.isFinite(score)) return fallback;
  if (score >= 82) return "high";
  if (score >= 64) return "medium";
  return "low";
}

export function confidenceLabel(confidence?: "high" | "medium" | "low") {
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

export function semanticReviewAttempts(file: MediaAsset) {
  const metadata = file.metadata;
  const attemptVersion = Number(metadata?.semanticReviewAttemptVersion || 0);
  return attemptVersion === semanticReviewVersion ? Number(metadata?.semanticReviewAttempts || 0) : 0;
}

export function needsVisionTimelineRecheck(file: MediaAsset) {
  const metadata = file.metadata;
  if (!metadata?.duration || metadata.videoCodec === "pending") return false;
  if (semanticState(file) !== "reviewed") return false;
  if (metadata.semanticFineReviewed === true) return false;
  if (semanticReviewAttempts(file) >= maxSemanticReviewAttempts && !metadata.semanticReviewLastError) return false;
  return potentialMomentRanges(file).length > 0;
}

export function needsVisionRecheck(file: MediaAsset) {
  return semanticState(file) === "needs_check" || needsVisionTimelineRecheck(file);
}

export function isVisionReviewableSource(file: MediaAsset) {
  return !looksLikeGeneratedExport(file.name) &&
    Boolean(file.metadata?.duration) &&
    file.metadata?.videoCodec !== "pending";
}

export function initialVisionCandidates(files: MediaAsset[]) {
  return files.filter((file) => isVisionReviewableSource(file) && semanticState(file) === "needs_check");
}

export function timelineVisionCandidates(files: MediaAsset[]) {
  return files.filter((file) => isVisionReviewableSource(file) && needsVisionTimelineRecheck(file));
}

export function visionReviewCandidates(files: MediaAsset[]) {
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

export function looksLikeGeneratedExport(name: string) {
  return /vision reviewed|created with highlightai|highlightai export|trailer - vision|assets\.json|^warsaw\b.*trailer/i.test(name);
}

export function isSelectableSourceClip(file: MediaAsset) {
  return !looksLikeGeneratedExport(file.name) &&
    Boolean(file.metadata?.duration) &&
    file.metadata?.videoCodec !== "pending";
}

export function normalizeAssets(assets: MediaAsset[]) {
  return assets.map((file) => ({
    ...file,
    type: file.name.match(/\.(mp3|wav|m4a|aac|flac|ogg)$/i) ? "audio" as const : "image" as const,
    source: file.source || "local-asset"
  }));
}

export function assetDuration(asset: MediaAsset | null) {
  return Number(asset?.duration || asset?.metadata?.duration || 0);
}

export function effectiveMusicDuration(asset: MediaAsset | null, repeats: number) {
  const duration = assetDuration(asset);
  if (!duration) return 0;
  return Math.min(MAX_HIGHLIGHT_DURATION, duration * Math.max(1, repeats || 1));
}

export function totalSourceClipDuration(files: MediaAsset[]) {
  return Math.round(files.reduce((sum, file) => sum + Math.max(0, Number(file.metadata?.duration) || 0), 0) * 10) / 10;
}

export function totalSegmentDuration(segments: Segment[]) {
  return Math.round(segments.reduce((sum, segment) => sum + Math.max(0, Number(segment.duration) || 0), 0) * 10) / 10;
}


export function makeHighlightReviewSession(items: HighlightReviewItem[], overrides: Partial<HighlightReviewSession> = {}): HighlightReviewSession {
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

export function isLockedReviewedItem(item: HighlightReviewItem) {
  return item.reviewed === true && item.confirmed === true;
}

export function nextReviewableIndex(items: HighlightReviewItem[], startIndex = 0) {
  if (!items.length) return 0;
  const start = Math.max(0, Math.min(items.length - 1, startIndex));
  const forward = items.findIndex((item, index) => index >= start && !isLockedReviewedItem(item));
  if (forward >= 0) return forward;
  const first = items.findIndex((item) => !isLockedReviewedItem(item));
  return first >= 0 ? first : 0;
}


export function draftSegmentsToReviewItems(draft: Draft, files: MediaAsset[], source = "draft-plan") {
  const fileById = new Map(files.map((file) => [file.id, file]));
  return (draft.segments || [])
    .map((segment, index) => {
      const file = fileById.get(segment.fileId);
      if (!file?.metadata?.duration) return null;
      const duration = Number(file.metadata.duration) || 0;
      const start = Math.max(0, Math.min(Math.max(0, duration - 1), Number(segment.start) || 0));
      const rawEnd = start + Math.max(1, Number(segment.duration) || 1);
      const end = Math.max(start + 1, Math.min(duration || rawEnd, rawEnd));
      const alreadyConfirmed = (file.metadata.confirmedHighlightMoments || []).some((moment) => {
        const confirmedStart = Number(moment.start) || 0;
        const confirmedEnd = Number(moment.end) || confirmedStart + (Number(moment.duration) || 0);
        return intervalsOverlapMeaningfully({ start: confirmedStart, end: confirmedEnd }, { start, end });
      });
      const alreadyReviewed = file.metadata?.reviewed === true || alreadyConfirmed;
      const score = Math.round(Number(segment.score) || Number(file.metadata.semanticScore) || Number(file.metadata.indexScore) || 65);
      return {
        id: `${file.id}:${source}:${draft.id}:${index}:${Math.round(start * 10)}:${Math.round(end * 10)}`,
        file,
        start,
        end,
        duration: end - start,
        score,
        state: "planned",
        action: segment.storyRole || "planned highlight",
        storyRole: segment.storyRole || "candidate",
        source: segment.source || source,
        label: source === "final-review" ? "Final review" : "Planned cut",
        confidence: segment.confidence || confidenceFromScore(score, "medium"),
        confirmed: alreadyConfirmed,
        reviewed: alreadyReviewed
      } as HighlightReviewItem;
    })
    .filter(Boolean) as HighlightReviewItem[];
}

export function confirmedReviewItemsToSegments(session: HighlightReviewSession): Segment[] {
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

export function confirmedMomentToReviewItem(file: MediaAsset, moment: ConfirmedHighlightMoment): HighlightReviewItem {
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

export function isDuplicateReviewItem(item: HighlightReviewItem, existing: HighlightReviewItem[]) {
  return existing.some((candidate) =>
    candidate.id === item.id ||
    candidate.file.id === item.file.id
  );
}
