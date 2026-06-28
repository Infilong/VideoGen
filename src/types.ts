export type Stage = "start" | "preflight" | "analyzing" | "advice" | "drafts";

export interface IngestFailure {
  clientId: string;
  name: string;
  message: string;
  phase: "upload" | "probe";
}

export interface IngestJob {
  id: string;
  status: "uploading" | "processing" | "paused" | "completed" | "completed_with_warnings" | "cancelled" | "failed";
  phase: "uploading" | "probing" | "paused" | "completed" | "cancelled" | "failed";
  totalFiles: number;
  totalBytes: number;
  uploadedFiles: number;
  uploadedBytes: number;
  processedFiles: number;
  currentFile: string | null;
  failures: IngestFailure[];
  projectId: string | null;
  result?: { project: Project; analysis: Analysis };
  createdAt: string;
  updatedAt: string;
  estimatedSeconds?: number;
  etaSeconds?: number;
  processingConcurrency?: number;
  activeFiles?: string[];
  previewFiles?: Array<{ id: string; clientId: string; name: string; size: number; state: string }>;
}

export interface IngestProgress extends IngestJob {
  activeFileBytes: number;
  activeFileSize: number;
}

export interface RenderJob {
  id: string;
  kind: "render";
  projectId: string;
  draftId: string;
  status: "queued" | "processing" | "paused" | "completed" | "cancelled" | "failed";
  phase: "queued" | "directing" | "evaluating" | "aligning" | "rendering" | "compressing" | "paused" | "cancelled" | "completed" | "failed";
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  result?: { url: string; localPath?: string; draft: Draft; assetManifest?: Record<string, unknown> };
  workflow?: EditWorkflow;
  error?: OperationIssue;
}

export interface Diagnostics {
  ok: boolean;
  dataRoot: string;
  freeBytes: number | null;
  maxFileBytes: number;
  maxHighlightSeconds: number;
  capabilities: {
    localSignals: boolean;
    semanticVideoVision: "optional";
    bundledVisionModel: false;
  };
}

export interface AiModelStatus {
  ok: boolean;
  latencyMs: number;
  model: string;
}

export interface PreprocessEstimate {
  files: number;
  totalProjectFiles: number;
  totalDuration: number;
  frames: number;
  modelRequests?: number;
  sampleInterval: number;
  concurrency: number;
  storageBytes: number;
  estimatedSeconds: number;
  note: string;
}

export interface FastIndexEstimate {
  files: number;
  totalProjectFiles: number;
  totalDuration: number;
  concurrency: number;
  windowDuration: number;
  maxWindowsPerFile: number;
  estimatedSeconds: number;
  storageBytes: number;
  note: string;
}

export interface FastIndexJob {
  id: string;
  kind: "fast-candidate-index";
  projectId: string;
  status: "processing" | "paused" | "completed" | "completed_with_warnings" | "cancelled" | "failed";
  phase: "scanning" | "paused" | "completed" | "cancelled" | "failed";
  totalFiles: number;
  totalProjectFiles: number;
  processedFiles: number;
  candidateWindows: number;
  currentFile: string | null;
  failures: Array<{ fileId?: string; name: string; phase: "scan"; message: string }>;
  estimatedSeconds: number;
  etaSeconds: number;
  storageBytes: number;
  concurrency: number;
  windowDuration: number;
  maxWindowsPerFile: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: { project: Project; candidateWindows: number } | null;
  activeFiles?: string[];
}

export interface PreprocessFailure {
  fileId?: string;
  name: string;
  time?: number;
  phase: "vision" | "extract";
  message: string;
}

export interface PreprocessJob {
  id: string;
  kind: "semantic-preprocess";
  projectId: string;
  status: "processing" | "paused" | "completed" | "completed_with_warnings" | "cancelled" | "failed";
  phase: "extracting_frames" | "reviewing_frames" | "paused" | "completed" | "cancelled" | "failed";
  totalFiles: number;
  totalProjectFiles?: number;
  processedFiles: number;
  totalFrames: number;
  processedFrames: number;
  totalRequests?: number;
  processedRequests?: number;
  approvedFrames: number;
  rejectedFrames: number;
  eventsFound: number;
  currentFile: string | null;
  currentFrameTime: number | null;
  failures: PreprocessFailure[];
  sampleInterval: number;
  maxFiles?: number;
  maxFrames?: number;
  refineReviewed?: boolean;
  fileIds?: string[] | null;
  estimatedSeconds: number;
  etaSeconds: number;
  storageBytes: number;
  concurrency: number;
  model: string;
  referenceStyle: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: { project?: Project; projectId?: string; eventsFound: number; approvedFrames: number; rejectedFrames: number } | null;
  activeFiles?: string[];
}

export interface OperationIssue {
  title: string;
  message: string;
  action?: string;
  details?: string;
  recoverable: boolean;
}

export interface MediaAsset {
  id: string;
  name: string;
  size: number;
  type: "video" | "audio" | "image" | "other";
  source: "recording" | "local-asset" | "public";
  url?: string;
  metadata?: MediaMetadata;
  sourceUrl?: string;
  creator?: string;
  licenseUrl?: string | null;
  licenseWarning?: boolean;
  contentHash?: string;
}

export interface MediaMetadata {
  duration: number;
  size: number;
  bitrate: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  hasAudio: boolean;
  qualityScore: number;
  actionScore?: number;
  sceneCuts?: number;
  meanVolume?: number;
  maxVolume?: number;
  highlightStart?: number;
  semanticFramesReviewed?: number;
  semanticReviewVersion?: number;
  semanticReviewAttemptVersion?: number;
  semanticReviewAttempts?: number;
  semanticReviewedAt?: string;
  semanticQuality?: "verified" | "weak" | "missed";
  semanticVerifiedEventCount?: number;
  semanticWeakCandidateCount?: number;
  semanticScore?: number;
  semanticRating?: {
    trailerUsefulness: number;
    excitement: number;
    visualQuality: number;
    novelty: number;
    boredom: number;
    payoffStage: string;
    excludeReason: string;
  } | null;
  semanticTopFrame?: number | null;
  semanticRejectReason?: string | null;
  semanticTraits?: {
    subject: string;
    shotScale: string;
    environment: string;
    action: string;
    intensity: number;
    spectacle: number;
    clarity: number;
    obstruction: number;
    payoffExpected: boolean;
  } | null;
  semanticTags?: string[];
  semanticEvents?: Array<{ start: number; end: number; score: number; state: string; action: string; payoffStage?: string; storyRole?: string; cutRisk?: string; payoffVerified?: boolean; impactTime?: number }>;
  semanticCandidateHistory?: Array<{ start: number; end: number; score: number; state: string; action: string; payoffStage?: string; storyRole?: string; cutRisk?: string; payoffVerified?: boolean; impactTime?: number }>;
  semanticFineReviewed?: boolean;
  semanticIndexJobId?: string;
  semanticReviewLastError?: string | null;
  visionApproved?: boolean;
  visionScore?: number;
  candidateWindows?: Array<{ start: number; end: number; duration: number; score: number; reason: string; sceneChanges: number; audioPeak: number; storyRole: string; cutRisk: string }>;
  indexDescription?: string;
  indexTags?: string[];
  indexScore?: number;
  ratingSource?: "vision-ai" | "vision-ai-assisted" | "local-signals";
  ratingConfidence?: "low" | "medium" | "high" | "unknown";
  recommendedForDraft?: boolean;
  fastIndexJobId?: string;
  fastIndexUpdatedAt?: string;
}

export interface Segment {
  fileId: string;
  start: number;
  duration: number;
  minDuration?: number;
  score: number;
  storyRole?: string;
  source?: string;
}

export interface VideoIdea {
  id: string;
  title: string;
  description: string;
  duration: number;
  format: "Landscape" | "Vertical";
  style: string;
  accent: string;
  score: number;
  moments: number;
  fileIds?: string[];
  durationMode?: "auto" | "fixed";
}

export interface Draft extends VideoIdea {
  version: number;
  music: string;
  captionStyle: string;
  intensity: number;
  changes: string[];
  segments?: Segment[];
  status?: "ready" | "rendering" | "exported";
  exportUrl?: string;
  exportPath?: string;
  review?: DraftReview;
  workflow?: EditWorkflow;
  musicPlan?: {
    sourceDuration: number;
    timelineDuration: number;
    repeats: number;
    ending: string;
    syncPoints: number;
  };
  encoding?: {
    codec: string;
    encoder: string;
    width: number;
    height: number;
    bitrate: number;
    size: number;
    qualityMode: string;
  };
}

export interface EditWorkflow {
  version: number;
  status: string;
  stage?: string;
  iteration?: number;
  maxIterations?: number;
  requestedDuration: number;
  selectedMoments: number;
  rejectedMoments: number;
  sourceVideosUsed: number;
  specialists: {
    action: string;
    boringFrames: string;
    story: string;
    diversity: string;
  };
  critique: {
    approved: boolean;
    score: number;
    coverage: number;
    duplicateIntervals: number;
    payoffMoments: number;
    lowConfidenceMoments: number;
    action: string;
    boringFrames: string;
    story: string;
    diversity: string;
  };
  visualReview?: {
    score: number;
    approved: boolean;
    rejectSegmentIndexes: number[];
    problems: string[];
  };
  music?: Draft["musicPlan"] | null;
}

export interface DraftReview {
  averageScore: number;
  approved: boolean;
  director: { score: number; opinion: string };
  audience: Array<{ persona: string; score: number; opinion: string }>;
  problems: string[];
  revisionPlan: string;
}

export interface Analysis {
  qualityScore: number;
  actionMoments: number;
  totalSize: number;
  notes: string[];
  ideas: VideoIdea[];
  totalDuration?: number;
  files?: MediaAsset[];
}

export interface Project {
  id: string;
  name: string;
  sourcePath?: string;
  sourceType?: "local-folder" | "uploaded-files";
  createdAt: string;
  updatedAt: string;
  files: MediaAsset[];
  assets: MediaAsset[];
  drafts: Draft[];
  analysis?: Analysis;
  fastIndex?: {
    jobId: string | null;
    status: string;
    phase: string;
    processedFiles?: number;
    totalFiles?: number;
    candidateWindows: number;
    estimatedSeconds?: number;
    etaSeconds?: number;
    updatedAt: string;
  };
  gameProfile?: { label: string; genre: string; tags: string[] };
  maxDuration: number;
}

export interface PublicAudio {
  id: string;
  title: string;
  creator: string;
  licenseUrl: string | null;
  sourceUrl: string;
  provider: string;
}
