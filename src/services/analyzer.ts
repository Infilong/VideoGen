import type { Analysis, MediaAsset, VideoIdea } from "../types";

const MAX_DURATION = 300;

const ideas: VideoIdea[] = [
  {
    id: "cinematic",
    title: "Last Stand",
    description: "A tense cinematic comeback with restrained cuts, dramatic build-up, and a powerful final push.",
    duration: 148,
    format: "Landscape",
    style: "Cinematic",
    accent: "#ff6b35",
    score: 96,
    moments: 14
  },
  {
    id: "velocity",
    title: "Pure Velocity",
    description: "Your fastest eliminations cut tightly to an energetic beat with punchy impact sounds.",
    duration: 54,
    format: "Vertical",
    style: "High energy",
    accent: "#b9ff66",
    score: 93,
    moments: 11
  },
  {
    id: "squad",
    title: "Squad Chaos",
    description: "Funny comms, close calls, and unexpected moments shaped into a compact story.",
    duration: 92,
    format: "Landscape",
    style: "Comedy",
    accent: "#c990ff",
    score: 89,
    moments: 9
  }
];

export function classifyFile(file: File): MediaAsset["type"] {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("image/")) return "image";
  return "other";
}

export function toAsset(file: File, source: MediaAsset["source"]): MediaAsset {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    size: file.size,
    type: classifyFile(file),
    source
  };
}

export async function analyzeMedia(files: MediaAsset[]): Promise<Analysis> {
  await new Promise((resolve) => window.setTimeout(resolve, 1700));
  const videos = files.filter((file) => file.type === "video");
  const totalSize = videos.reduce((total, file) => total + file.size, 0);
  const estimatedMoments = Math.max(8, Math.min(34, videos.length * 7 + 5));

  return {
    qualityScore: videos.length > 2 ? 91 : 84,
    actionMoments: estimatedMoments,
    totalSize,
    notes: [
      `${estimatedMoments} strong action moments are usable across ${videos.length} recording${videos.length === 1 ? "" : "s"}.`,
      "Audio is clear enough for impact-driven cuts and automatic music ducking.",
      "The strongest result is a focused highlight under 5 minutes, not a full match recap."
    ],
    ideas: ideas.map((idea) => ({ ...idea, duration: Math.min(idea.duration, MAX_DURATION) }))
  };
}

export const curatedIdeas: VideoIdea[] = ideas;

export function clampDuration(seconds: number) {
  return Math.min(MAX_DURATION, Math.max(15, seconds));
}

export function formatBytes(bytes: number) {
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

export function formatTime(seconds: number) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
