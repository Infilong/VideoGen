export type AiConfig = { endpoint: string; apiKey: string; model: string };
export type VisionReviewMode = "light" | "balanced" | "thorough";
export type AiResourceLimits = { maxVisionWorkers: number; maxFramesPerVideo: number; maxVideosPerRun: number };

export const semanticReviewVersion = 2;
export const maxSemanticReviewAttempts = 2;
export const defaultTextAi: AiConfig = { endpoint: "https://api.openai.com/v1/chat/completions", apiKey: "", model: "gpt-4.1-mini" };
export const defaultVisionAi: AiConfig = { endpoint: "http://127.0.0.1:11434/v1/chat/completions", apiKey: "", model: "qwen2.5vl:7b" };
export const defaultAiResourceLimits: AiResourceLimits = { maxVisionWorkers: 2, maxFramesPerVideo: 10, maxVideosPerRun: 0 };

export function isLocalAiEndpoint(endpoint = "") {
  return /(?:localhost|127\.0\.0\.1)/i.test(endpoint);
}

export function defaultVisionReviewMode(config: AiConfig): VisionReviewMode {
  return isLocalAiEndpoint(config.endpoint) ? "light" : "balanced";
}

export function visionReviewProfile(mode: VisionReviewMode) {
  if (mode === "thorough") return { batchSize: 20, framesPerClip: 10, sampleInterval: 5, concurrency: 2 };
  if (mode === "balanced") return { batchSize: 12, framesPerClip: 8, sampleInterval: 6, concurrency: 2 };
  return { batchSize: 12, framesPerClip: 10, sampleInterval: 8, concurrency: 1 };
}

export function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

export function normalizeAiResourceLimits(value: Partial<AiResourceLimits> = {}): AiResourceLimits {
  return {
    maxVisionWorkers: clampInteger(value.maxVisionWorkers, 1, 6, defaultAiResourceLimits.maxVisionWorkers),
    maxFramesPerVideo: clampInteger(value.maxFramesPerVideo, 3, 18, defaultAiResourceLimits.maxFramesPerVideo),
    maxVideosPerRun: clampInteger(value.maxVideosPerRun, 0, 200, defaultAiResourceLimits.maxVideosPerRun)
  };
}

export function loadAiResourceLimits() {
  try {
    return normalizeAiResourceLimits(JSON.parse(localStorage.getItem("highlight-ai-resource-limits") || "{}"));
  } catch {
    return defaultAiResourceLimits;
  }
}

export function resourceLimitedVisionProfile(mode: VisionReviewMode, limits: AiResourceLimits) {
  const profile = visionReviewProfile(mode);
  return {
    ...profile,
    concurrency: Math.min(profile.concurrency, limits.maxVisionWorkers),
    framesPerClip: Math.min(profile.framesPerClip, limits.maxFramesPerVideo)
  };
}

export function isLocalOllamaVisionEndpoint(endpoint = "") {
  try {
    const url = new URL(endpoint);
    return ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "11434";
  } catch {
    return false;
  }
}

export function effectiveVisionProfile(mode: VisionReviewMode, limits: AiResourceLimits, endpoint: string) {
  const profile = resourceLimitedVisionProfile(mode, limits);
  return {
    ...profile,
    concurrency: isLocalOllamaVisionEndpoint(endpoint) ? 1 : profile.concurrency
  };
}

export function limitVisionQueue<T>(files: T[], limits: AiResourceLimits): T[] {
  return limits.maxVideosPerRun > 0 ? files.slice(0, limits.maxVideosPerRun) : files;
}
