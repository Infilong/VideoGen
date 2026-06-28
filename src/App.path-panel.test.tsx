import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreprocessJob, Project } from "./types";
import App, { chooseDiversifiedClips } from "./App";
import * as api from "./services/api";

const savedFolderProject = vi.hoisted(() => ({
  id: "saved-folder",
  name: "Saved Folder",
  sourcePath: "D:\\Games\\Clips",
  sourceType: "local-folder",
  createdAt: "2026-06-18T00:00:00.000Z",
  updatedAt: "2026-06-18T00:00:00.000Z",
  files: [
    {
      id: "clip-1",
      name: "first-highlight.mp4",
      size: 1024,
      type: "video",
      source: "recording",
      metadata: {
        duration: 12,
        size: 1024,
        bitrate: 8000,
        width: 1920,
        height: 1080,
        fps: 60,
        videoCodec: "h264",
        audioCodec: "aac",
        hasAudio: true,
        qualityScore: 80,
        actionScore: 70,
        indexDescription: "Test clip: infantry, loud impact.",
        indexTags: ["infantry", "loud impact"],
        indexScore: 75
      }
    },
    {
      id: "clip-2",
      name: "second-highlight.mp4",
      size: 2048,
      type: "video",
      source: "recording",
      metadata: {
        duration: 18,
        size: 2048,
        bitrate: 9000,
        width: 1920,
        height: 1080,
        fps: 60,
        videoCodec: "h264",
        audioCodec: "aac",
        hasAudio: true,
        qualityScore: 82,
        actionScore: 72,
        indexDescription: "Second clip: vehicle, explosion.",
        indexTags: ["vehicle", "explosion"],
        indexScore: 78
      }
    }
  ],
  assets: [],
  drafts: [],
  analysis: {
    qualityScore: 81,
    actionMoments: 3,
    totalSize: 3072,
    totalDuration: 30,
    notes: ["Two clips indexed.", "All recordings have usable audio.", "Choose a focused set of clips."],
    ideas: []
  },
  maxDuration: 300
}) as Project);

const generationProject = {
  ...savedFolderProject,
  id: "generation-project",
  name: "Generation Project",
  files: Array.from({ length: 5 }, (_, index) => ({
    ...savedFolderProject.files[index % savedFolderProject.files.length],
    id: `generation-clip-${index + 1}`,
    name: `generation-clip-${index + 1}.mp4`,
    metadata: {
      ...savedFolderProject.files[index % savedFolderProject.files.length].metadata,
      duration: Number(savedFolderProject.files[index % savedFolderProject.files.length].metadata?.duration || 12),
      semanticScore: 88 - index,
      semanticFramesReviewed: 8,
      semanticEvents: [{ start: 4, end: 10, score: 88 - index, state: "impact", action: "test impact", storyRole: "payoff", cutRisk: "high", payoffVerified: true }]
    }
  })),
  assets: [],
  drafts: []
} as Project;

vi.mock("./services/api", () => ({
  addAssets: vi.fn(),
  cancelRenderJob: vi.fn(),
  checkAiModel: vi.fn(),
  deleteProject: vi.fn(),
  estimateFastIndex: vi.fn().mockResolvedValue({
    files: 2,
    totalProjectFiles: 2,
    totalDuration: 30,
    concurrency: 3,
    windowDuration: 14,
    maxWindowsPerFile: 4,
    estimatedSeconds: 8,
    storageBytes: 16000,
    note: "test"
  }),
  estimatePreprocess: vi.fn().mockResolvedValue({
    files: 2,
    totalProjectFiles: 2,
    totalDuration: 30,
    frames: 4,
    sampleInterval: 10,
    concurrency: 1,
    storageBytes: 380000,
    estimatedSeconds: 12,
    note: "test"
  }),
  findPublicAudio: vi.fn().mockResolvedValue([]),
  generateDraft: vi.fn(),
  getFastIndexJob: vi.fn(),
  getDiagnostics: vi.fn().mockResolvedValue({
    ok: true,
    dataRoot: "data",
    freeBytes: 1000000,
    maxFileBytes: 1000000,
    maxHighlightSeconds: 300,
    capabilities: { localSignals: true, semanticVideoVision: "optional", bundledVisionModel: false }
  }),
  getProject: vi.fn().mockResolvedValue(savedFolderProject),
  getPreprocessJob: vi.fn(),
  importPublicAudio: vi.fn(),
  ingestFiles: vi.fn(),
  ingestLocalFolder: vi.fn(),
  issueFromError: vi.fn((error: unknown) => ({
    title: "Processing stopped",
    message: error instanceof Error ? error.message : "Unexpected error",
    recoverable: true
  })),
  listProjects: vi.fn().mockResolvedValue([savedFolderProject]),
  localMediaUrl: vi.fn((url: string) => url),
  reconcileProject: vi.fn().mockResolvedValue(savedFolderProject),
  cancelPreprocessJob: vi.fn(),
  pauseFastIndexJob: vi.fn(),
  pausePreprocessJob: vi.fn(),
  resumeFastIndexJob: vi.fn(),
  resumePreprocessJob: vi.fn(),
  renderDraft: vi.fn(),
  requestAdvancedAdvice: vi.fn(),
  requestVisionReview: vi.fn(),
  reviewDraft: vi.fn(),
  runFastIndex: vi.fn(),
  runPreprocess: vi.fn(),
  updateDraft: vi.fn()
}));

describe("path management", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("changes diversified AI picks on consecutive clicks when alternatives exist", () => {
    const files = Array.from({ length: 20 }, (_, index) => ({
      ...savedFolderProject.files[index % savedFolderProject.files.length],
      id: `lucky-${index}`,
      name: `lucky-${index}.mp4`,
      metadata: {
        ...savedFolderProject.files[index % savedFolderProject.files.length].metadata,
        semanticScore: 95 - index,
        semanticTags: [index % 3 === 0 ? "tank" : index % 3 === 1 ? "attack helicopter" : "infantry firefight"]
      }
    })) as Project["files"];

    const first = chooseDiversifiedClips(files, [], () => 0.5);
    const second = chooseDiversifiedClips(files, [first], () => 0.5);

    expect(first).toHaveLength(12);
    expect(second).toHaveLength(12);
    expect(second).not.toEqual(first);
    expect(second.some((id) => !first.includes(id))).toBe(true);
  });

  it("shows saved paths and loads a path's contents when clicked", async () => {
    const { container } = render(<App />);

    expect(screen.getByLabelText("Video creation workflow")).toHaveTextContent("Add footage");
    expect(screen.getByLabelText("Video creation workflow")).toHaveTextContent("Choose clips");
    expect(screen.getByLabelText("Video creation workflow")).toHaveTextContent("Set direction");
    expect(screen.getByLabelText("Video creation workflow")).toHaveTextContent("Review video");
    expect(await screen.findByText("Your folders")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Saved Folder/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Saved Folder/i }));

    await waitFor(() => expect(screen.getByText("Current footage")).toBeInTheDocument());
    expect(screen.getAllByText("D:\\Games\\Clips")[0]).toBeInTheDocument();
    expect(screen.getByText("Your clips")).toBeInTheDocument();
    expect(screen.getAllByText("2", { selector: ".library-summary strong" }).length).toBeGreaterThan(0);
    expect(screen.getByText("first-highlight", { selector: ".clip-copy > strong" })).toBeInTheDocument();
    expect(screen.getByText("second-highlight", { selector: ".clip-copy > strong" })).toBeInTheDocument();
    expect(screen.getAllByText("00:12").length).toBeGreaterThan(0);
    const previewButton = screen.getByRole("button", { name: /Preview first-highlight/i });
    expect(previewButton).toBeInTheDocument();
    const thumbnail = previewButton.querySelector("img");
    expect(thumbnail).toHaveAttribute("src", "/api/projects/saved-folder/files/clip-1/thumbnail");
    fireEvent.error(thumbnail!);
    expect(thumbnail).toHaveStyle({ display: "none" });
    expect(previewButton.querySelector("svg")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search descriptions or tags..."), { target: { value: "vehicle" } });
    expect(screen.queryByText("first-highlight", { selector: ".clip-copy > strong" })).not.toBeInTheDocument();
    expect(screen.getByText("second-highlight", { selector: ".clip-copy > strong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate Video/i })).toBeEnabled();
  });

  it("does not label completed local or AI-assisted ratings as pending", async () => {
    const ratedProject = {
      ...savedFolderProject,
      files: savedFolderProject.files.map((file, index) => ({
        ...file,
        metadata: {
          ...file.metadata,
          ...(index === 0
            ? {
                semanticScore: 62,
                semanticFramesReviewed: 4,
                semanticReviewVersion: 2,
                semanticReviewAttemptVersion: 2,
                semanticReviewAttempts: 1,
                semanticTags: ["infantry push"],
                candidateWindows: [{ start: 4, end: 12, duration: 8, score: 74, reason: "indexed action", sceneChanges: 2, audioPeak: -12, storyRole: "payoff", cutRisk: "medium" }],
                ratingSource: "vision-ai-assisted" as const
              }
            : { ratingSource: "local-signals" as const })
        }
      }))
    } as Project;
    vi.mocked(api.getProject).mockResolvedValueOnce(ratedProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(ratedProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Saved Folder/i }));

    expect((await screen.findAllByText("Pending review 78")).length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("Vision AI reviewed this clip but has not confirmed a complete payoff yet").some((item) => item.textContent?.includes("AI checked 75"))).toBe(true);
    expect(screen.getByText(/AI checked this clip but did not fully verify the payoff/)).toHaveTextContent("Potential moments: 00:04-00:12.");
    expect(screen.getAllByText("infantry push").length).toBeGreaterThan(0);
    expect(screen.queryByText("AI pending")).not.toBeInTheDocument();
  });

  it("labels strong AI-reviewed clips as AI verified even without event details", async () => {
    const strongProject = {
      ...savedFolderProject,
      files: savedFolderProject.files.map((file, index) => ({
        ...file,
        metadata: {
          ...file.metadata,
          ...(index === 0
            ? {
                semanticScore: 77,
                semanticFramesReviewed: 5,
                semanticReviewVersion: 2,
                semanticReviewAttemptVersion: 2,
                semanticReviewAttempts: 1,
                semanticTags: ["vehicle destruction"],
                semanticTopFrame: 8,
                ratingSource: "vision-ai" as const,
                ratingConfidence: "high" as const
              }
            : { ratingSource: "local-signals" as const })
        }
      }))
    } as Project;
    vi.mocked(api.getProject).mockResolvedValueOnce(strongProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(strongProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Saved Folder/i }));

    expect(await screen.findByText("AI verified 77")).toBeInTheDocument();
    expect(screen.queryByText("Verified AI 77")).not.toBeInTheDocument();
    expect(screen.getAllByTitle("Vision AI verified a complete visible payoff").length).toBeGreaterThan(0);
  });

  it("shows one truthful background service card for a paused index job", async () => {
    const pausedProject = {
      ...savedFolderProject,
      fastIndex: {
        jobId: "paused-index",
        status: "paused",
        phase: "paused",
        processedFiles: 140,
        totalFiles: 138,
        candidateWindows: 220,
        etaSeconds: 291,
        updatedAt: "2026-06-25T00:00:00.000Z"
      }
    } as Project;
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(pausedProject);
    vi.mocked(api.getFastIndexJob).mockResolvedValueOnce({
      id: "paused-index",
      kind: "fast-candidate-index",
      projectId: pausedProject.id,
      status: "paused",
      phase: "paused",
      totalFiles: 138,
      totalProjectFiles: 139,
      processedFiles: 140,
      candidateWindows: 220,
      currentFile: null,
      failures: [],
      estimatedSeconds: 393,
      etaSeconds: 291,
      storageBytes: 1000,
      concurrency: 3,
      windowDuration: 14,
      maxWindowsPerFile: 4,
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:00.000Z"
    });

    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Saved Folder/i }));

    expect(await screen.findByText("Background indexing is paused")).toBeInTheDocument();
    expect(screen.getByText(/138 of 138 indexed/)).toBeInTheDocument();
    expect(container.querySelector(".background-service")?.textContent).not.toMatch(/04:51|estimating time remaining|remaining/i);
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.queryByText("Automatic AI analysis is queued")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".background-service")).toHaveLength(1);
  });

  it("normalizes stale completed fast-index counts instead of showing unfinished work", async () => {
    const staleCompletedProject = {
      ...savedFolderProject,
      fastIndex: {
        jobId: "stale-completed-index",
        status: "completed",
        phase: "completed",
        processedFiles: 130,
        totalFiles: 139,
        candidateWindows: 535,
        etaSeconds: 0,
        updatedAt: "2026-06-28T00:00:00.000Z"
      }
    } as Project;
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(staleCompletedProject);
    vi.mocked(api.getFastIndexJob).mockResolvedValueOnce({
      id: "stale-completed-index",
      kind: "fast-candidate-index",
      projectId: staleCompletedProject.id,
      status: "completed",
      phase: "completed",
      totalFiles: 139,
      totalProjectFiles: 140,
      processedFiles: 130,
      candidateWindows: 535,
      currentFile: null,
      failures: [],
      estimatedSeconds: 393,
      etaSeconds: 0,
      storageBytes: 1000,
      concurrency: 3,
      windowDuration: 14,
      maxWindowsPerFile: 4,
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:05:00.000Z"
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Saved Folder/i }));

    expect(await screen.findByText("139/139 files scanned")).toBeInTheDocument();
    expect(screen.queryByText("130/139 files scanned")).not.toBeInTheDocument();
    expect(screen.getByText("completed", { selector: ".preprocess-metrics strong" })).toBeInTheDocument();
  });

  it("shows active Vision AI batch progress instead of clamped whole-folder progress", async () => {
    const livePreprocessJob: PreprocessJob = {
      id: "live-preprocess",
      kind: "semantic-preprocess" as const,
      projectId: "large-folder",
      status: "processing" as const,
      phase: "reviewing_frames" as const,
      totalFiles: 80,
      totalProjectFiles: 140,
      processedFiles: 68,
      totalFrames: 240,
      processedFrames: 204,
      totalRequests: 20,
      processedRequests: 17,
      approvedFrames: 1,
      rejectedFrames: 67,
      eventsFound: 1,
      currentFile: "last-batch.mp4",
      currentFrameTime: 52,
      failures: [],
      sampleInterval: 10,
      maxFiles: 80,
      maxFrames: 240,
      estimatedSeconds: 1200,
      etaSeconds: 360,
      storageBytes: 1000,
      concurrency: 1,
      model: "qwen2.5vl:7b",
      referenceStyle: "test",
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:10:00.000Z"
    };
    const largeFolderProject = {
      ...savedFolderProject,
      id: "large-folder",
      name: "Large Folder",
      fastIndex: {
        status: "completed",
        phase: "completed",
        processedFiles: 140,
        totalFiles: 140,
        candidateWindows: 320,
        etaSeconds: 0,
        updatedAt: "2026-06-27T00:00:00.000Z"
      },
      files: Array.from({ length: 140 }, (_, index) => ({
        ...savedFolderProject.files[index % savedFolderProject.files.length],
        id: `large-clip-${index + 1}`,
        name: `large-clip-${index + 1}.mp4`,
        metadata: {
          ...savedFolderProject.files[index % savedFolderProject.files.length].metadata,
          semanticFramesReviewed: index < 72 ? 3 : 0,
          semanticReviewVersion: index < 72 ? 2 : 0,
          semanticReviewAttemptVersion: index < 72 ? 2 : 0,
          semanticReviewAttempts: index < 72 ? 1 : 0,
          ratingSource: index < 72 ? "vision-ai-assisted" as const : "local-signals" as const
        }
      }))
    } as Project;

    vi.mocked(api.listProjects).mockResolvedValueOnce([largeFolderProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(largeFolderProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(largeFolderProject);
    vi.mocked(api.checkAiModel).mockResolvedValueOnce({ ok: true, model: "qwen2.5vl:7b", latencyMs: 50 });
    let finishPreprocess: (job: PreprocessJob) => void = () => undefined;
    vi.mocked(api.runPreprocess).mockImplementationOnce(async (_projectId, _config, _options, onProgress) => {
      onProgress(livePreprocessJob);
      return new Promise((resolve) => { finishPreprocess = resolve; });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Large Folder/i }));

    expect(await screen.findByText("Vision AI is checking videos")).toBeInTheDocument();
    expect(screen.getAllByText(/68 of 80 videos checked|68\/80 videos checked/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/140\/140 videos checked|140 of 140 videos checked/)).not.toBeInTheDocument();
    finishPreprocess({ ...livePreprocessJob, status: "completed", phase: "completed", processedFiles: 80 });
  });

  it("runs one focused timeline recheck after a weak first Vision AI pass", async () => {
    const makeJob = (resultProject: Project, overrides: Partial<PreprocessJob> = {}): PreprocessJob => ({
      id: overrides.id || "timeline-job",
      kind: "semantic-preprocess" as const,
      projectId: resultProject.id,
      status: "completed" as const,
      phase: "completed" as const,
      totalFiles: 1,
      totalProjectFiles: 1,
      processedFiles: 1,
      totalFrames: 6,
      processedFrames: 6,
      totalRequests: 1,
      processedRequests: 1,
      approvedFrames: 1,
      rejectedFrames: 5,
      eventsFound: 0,
      currentFile: null,
      currentFrameTime: null,
      failures: [],
      sampleInterval: 8,
      maxFiles: 1,
      maxFrames: 6,
      estimatedSeconds: 10,
      etaSeconds: 0,
      storageBytes: 1000,
      concurrency: 1,
      model: "qwen2.5vl:7b",
      referenceStyle: "test",
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:10:00.000Z",
      result: { project: resultProject, eventsFound: overrides.eventsFound || 0, approvedFrames: 1, rejectedFrames: 5 },
      ...overrides
    });
    const indexedProject = {
      ...savedFolderProject,
      fastIndex: {
        jobId: null,
        status: "completed",
        phase: "completed",
        processedFiles: 1,
        totalFiles: 1,
        candidateWindows: 1,
        etaSeconds: 0,
        updatedAt: "2026-06-27T00:00:00.000Z"
      },
      files: [{
        ...savedFolderProject.files[0],
        id: "timeline-clip",
        metadata: {
          ...savedFolderProject.files[0].metadata,
          candidateWindows: [{ start: 4, end: 12, duration: 8, score: 78, reason: "indexed action", sceneChanges: 2, audioPeak: -10, storyRole: "payoff", cutRisk: "medium" }]
        }
      }]
    } as Project;
    const weakProject = {
      ...indexedProject,
      files: indexedProject.files.map((file) => ({
        ...file,
        metadata: {
          ...file.metadata,
          semanticScore: 42,
          semanticQuality: "weak",
          semanticFramesReviewed: 6,
          semanticReviewVersion: 2,
          semanticReviewAttemptVersion: 2,
          semanticReviewAttempts: 1,
          semanticCandidateHistory: [{ start: 4, end: 12, score: 62, state: "aim", action: "vehicle push", payoffVerified: false }],
          semanticTags: ["vehicle push"],
          ratingSource: "vision-ai-assisted" as const
        }
      }))
    } as Project;
    const refinedProject = {
      ...weakProject,
      files: weakProject.files.map((file) => ({
        ...file,
        metadata: {
          ...file.metadata,
          semanticFramesReviewed: 10,
          semanticReviewAttempts: 2,
          semanticFineReviewed: true
        }
      }))
    } as Project;

    vi.mocked(api.listProjects).mockResolvedValueOnce([indexedProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(indexedProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(indexedProject);
    vi.mocked(api.checkAiModel).mockResolvedValue({ ok: true, model: "qwen2.5vl:7b", latencyMs: 50 });
    vi.mocked(api.runPreprocess)
      .mockImplementationOnce(async (_projectId, _config, options) => {
        expect(options.refineReviewed).toBe(false);
        expect(options.fileIds).toEqual(["timeline-clip"]);
        return makeJob(weakProject, { id: "first-pass" });
      })
      .mockImplementationOnce(async (_projectId, _config, options) => {
        expect(options.refineReviewed).toBe(true);
        expect(options.fileIds).toEqual(["timeline-clip"]);
        return makeJob(refinedProject, { id: "timeline-pass", totalFrames: 10, maxFrames: 10 });
      });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Saved Folder/i }));

    await waitFor(() => expect(api.runPreprocess).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/still need Vision AI review/i)).not.toBeInTheDocument();
    expect(await screen.findByText("AI uncertain 75")).toBeInTheDocument();
  });

  it("saves AI resource limits and applies them to background Vision AI jobs", async () => {
    localStorage.setItem("highlight-ai-vision-review-mode", "thorough");
    const limitedProject = {
      ...savedFolderProject,
      id: "limited-folder",
      name: "Limited Folder",
      fastIndex: {
        status: "completed",
        phase: "completed",
        processedFiles: 10,
        totalFiles: 10,
        candidateWindows: 40,
        etaSeconds: 0,
        updatedAt: "2026-06-27T00:00:00.000Z"
      },
      files: [
        {
          ...savedFolderProject.files[0],
          id: "limited-export",
          name: "WARSAW - Battlefield 6 Trailer - Fast Indexed Story Cut.mp4",
          metadata: {
            ...savedFolderProject.files[0].metadata,
            semanticFramesReviewed: 0,
            semanticReviewVersion: 0
          }
        },
        ...Array.from({ length: 10 }, (_, index) => ({
          ...savedFolderProject.files[index % savedFolderProject.files.length],
          id: `limited-clip-${index + 1}`,
          name: `limited-clip-${index + 1}.mp4`,
          metadata: {
            ...savedFolderProject.files[index % savedFolderProject.files.length].metadata,
            semanticFramesReviewed: 0,
            semanticReviewVersion: 0
          }
        }))
      ]
    } as Project;
    const reviewedProject = {
      ...limitedProject,
      files: limitedProject.files.map((file, index) => ({
        ...file,
        metadata: {
          ...file.metadata,
          semanticScore: 86 - index,
          semanticQuality: "verified" as const,
          semanticFramesReviewed: 6,
          semanticReviewVersion: 2,
          semanticReviewAttemptVersion: 2,
          semanticReviewAttempts: 1,
          ratingSource: "vision-ai" as const,
          ratingConfidence: "high" as const,
          semanticEvents: [{ start: 3, end: 9, score: 86 - index, state: "impact", action: "verified event", payoffVerified: true }]
        }
      }))
    } as Project;
    const makeJob = (resultProject: Project): PreprocessJob => ({
      id: "limited-job",
      kind: "semantic-preprocess" as const,
      projectId: resultProject.id,
      status: "completed" as const,
      phase: "completed" as const,
      totalFiles: 4,
      totalProjectFiles: 10,
      processedFiles: 4,
      totalFrames: 24,
      processedFrames: 24,
      totalRequests: 4,
      processedRequests: 4,
      approvedFrames: 4,
      rejectedFrames: 0,
      eventsFound: 4,
      currentFile: null,
      currentFrameTime: null,
      failures: [],
      sampleInterval: 5,
      maxFiles: 4,
      maxFrames: 24,
      estimatedSeconds: 10,
      etaSeconds: 0,
      storageBytes: 1000,
      concurrency: 1,
      model: "qwen2.5vl:7b",
      referenceStyle: "test",
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:10:00.000Z",
      result: { project: resultProject, eventsFound: 4, approvedFrames: 4, rejectedFrames: 0 }
    });

    vi.mocked(api.listProjects).mockResolvedValueOnce([limitedProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(limitedProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(limitedProject);
    vi.mocked(api.checkAiModel).mockResolvedValue({ ok: true, model: "qwen2.5vl:7b", latencyMs: 50 });
    vi.mocked(api.runPreprocess).mockImplementationOnce(async (_projectId, _config, options) => {
      expect(options.concurrency).toBe(1);
      expect(options.maxFiles).toBe(4);
      expect(options.maxFrames).toBe(24);
      expect(options.fileIds).toEqual(["limited-clip-1", "limited-clip-2", "limited-clip-3", "limited-clip-4"]);
      return makeJob(reviewedProject);
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("AI workers"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Frames per video"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("Videos per run"), { target: { value: "4" } });
    expect(screen.getByText("Effective cap")).toBeInTheDocument();
    expect(screen.getByText("1 worker, 6 frames/video, 4 videos/run")).toBeInTheDocument();
    expect(screen.getByText(/Local Ollama uses one active model request/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save locally" }));
    expect(JSON.parse(localStorage.getItem("highlight-ai-resource-limits") || "{}")).toEqual({
      maxVisionWorkers: 4,
      maxFramesPerVideo: 6,
      maxVideosPerRun: 4
    });

    fireEvent.click(await screen.findByRole("button", { name: /Limited Folder/i }));
    await waitFor(() => expect(api.runPreprocess).toHaveBeenCalledTimes(1));
  });

  it("retries a transient failed timeline review instead of treating it as final uncertainty", async () => {
    const staleFailureProject = {
      ...savedFolderProject,
      id: "stale-failure-folder",
      name: "Stale Failure Folder",
      fastIndex: {
        jobId: null,
        status: "completed",
        phase: "completed",
        processedFiles: 1,
        totalFiles: 1,
        candidateWindows: 4,
        etaSeconds: 0,
        updatedAt: "2026-06-27T00:00:00.000Z"
      },
      files: [{
        ...savedFolderProject.files[0],
        id: "stale-failure-clip",
        metadata: {
          ...savedFolderProject.files[0].metadata,
          semanticScore: 42,
          semanticQuality: "missed" as const,
          semanticFramesReviewed: 3,
          semanticReviewVersion: 2,
          semanticReviewAttemptVersion: 2,
          semanticReviewAttempts: 2,
          semanticReviewLastError: "fetch failed",
          semanticFineReviewed: false,
          semanticEvents: [],
          semanticCandidateHistory: [],
          candidateWindows: [{ start: 8, end: 18, duration: 10, score: 84, reason: "audio_peak", sceneChanges: 3, audioPeak: -9, storyRole: "payoff", cutRisk: "high" }]
        }
      }]
    } as Project;
    const retriedProject = {
      ...staleFailureProject,
      files: staleFailureProject.files.map((file) => ({
        ...file,
        metadata: {
          ...file.metadata,
          semanticQuality: "weak" as const,
          semanticReviewLastError: null,
          semanticFineReviewed: true,
          semanticFramesReviewed: 10
        }
      }))
    } as Project;
    vi.mocked(api.listProjects).mockResolvedValueOnce([staleFailureProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(staleFailureProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(staleFailureProject);
    vi.mocked(api.checkAiModel).mockResolvedValue({ ok: true, model: "qwen2.5vl:7b", latencyMs: 50 });
    vi.mocked(api.runPreprocess).mockResolvedValueOnce({
      id: "stale-retry-job",
      kind: "semantic-preprocess" as const,
      projectId: staleFailureProject.id,
      status: "completed" as const,
      phase: "completed" as const,
      totalFiles: 1,
      totalProjectFiles: 1,
      processedFiles: 1,
      totalFrames: 10,
      processedFrames: 10,
      totalRequests: 1,
      processedRequests: 1,
      approvedFrames: 0,
      rejectedFrames: 1,
      eventsFound: 0,
      currentFile: null,
      currentFrameTime: null,
      failures: [],
      sampleInterval: 6,
      maxFiles: 1,
      maxFrames: 10,
      refineReviewed: true,
      estimatedSeconds: 10,
      etaSeconds: 0,
      storageBytes: 1000,
      concurrency: 1,
      model: "qwen2.5vl:7b",
      referenceStyle: "test",
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:10:00.000Z",
      result: { project: retriedProject, eventsFound: 0, approvedFrames: 0, rejectedFrames: 1 }
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Stale Failure Folder/i }));

    await waitFor(() => expect(api.runPreprocess).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.runPreprocess).mock.calls[0][2]).toMatchObject({
      refineReviewed: true,
      fileIds: ["stale-failure-clip"]
    });
  });

  it("does not count generated exports as videos waiting for Vision AI review", async () => {
    const reviewedFolderProject = {
      ...savedFolderProject,
      fastIndex: {
        status: "completed",
        phase: "completed",
        processedFiles: 2,
        totalFiles: 2,
        candidateWindows: 8,
        etaSeconds: 0,
        updatedAt: "2026-06-27T00:00:00.000Z"
      },
      files: [
        ...savedFolderProject.files.map((file) => ({
          ...file,
          metadata: {
            ...file.metadata,
            semanticFramesReviewed: 3,
            semanticReviewVersion: 2,
            semanticReviewAttemptVersion: 2,
            semanticReviewAttempts: 1,
            ratingSource: "vision-ai-assisted" as const
          }
        })),
        {
          ...savedFolderProject.files[0],
          id: "generated-export",
          name: "WARSAW - Battlefield 6 Trailer - Fast Indexed Story Cut.mp4",
          metadata: {
            ...savedFolderProject.files[0].metadata,
            ratingSource: "local-signals" as const,
            semanticFramesReviewed: 0,
            semanticReviewVersion: 0
          }
        }
      ]
    } as Project;

    vi.mocked(api.listProjects).mockResolvedValueOnce([reviewedFolderProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(reviewedFolderProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(reviewedFolderProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Saved Folder/i }));

    expect(await screen.findByText("Background analysis is ready")).toBeInTheDocument();
    expect(screen.queryByText(/still need Vision AI review/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Run Vision AI check/i })).not.toBeInTheDocument();
  });

  it("supports library views, bulk selection, theme switching, and an obvious soundtrack step", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Saved Folder/i }));
    await screen.findByText("Current footage");

    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(document.querySelector(".clip-grid")).toHaveClass("view-list");
    expect(localStorage.getItem("highlight-ai-library-view")).toBe("list");
    fireEvent.click(screen.getByRole("button", { name: "Detail view" }));
    expect(document.querySelector(".clip-grid")).toHaveClass("view-detail");
    fireEvent.click(screen.getByRole("button", { name: "List view" }));

    const visibleCardCount = document.querySelectorAll(".clip-card").length;
    fireEvent.click(screen.getByRole("button", { name: "Select top 20" }));
    await waitFor(() => expect(document.querySelectorAll(".clip-card.selected").length).toBe(visibleCardCount));
    fireEvent.click(screen.getByRole("button", { name: "Unselect all" }));
    await waitFor(() => expect(document.querySelectorAll(".clip-card.selected").length).toBe(0));

    fireEvent.click(screen.getByRole("button", { name: "Use light theme" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("highlight-ai-theme")).toBe("light");

    expect(screen.getByRole("heading", { name: "Generate your highlight" })).toBeInTheDocument();
    expect(screen.getByLabelText("Choose music (optional)")).toHaveValue("");
    expect(screen.getByRole("option", { name: "No background music" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add music file" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create another version" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Version 1" })).not.toBeInTheDocument();
  });

  it("allows more than 20 clips and treats low AI moment count as advice, not a blocker", async () => {
    const manyClipProject = {
      ...generationProject,
      id: "many-clip-project",
      name: "Many Clip Project",
      files: Array.from({ length: 25 }, (_, index) => ({
        ...generationProject.files[index % generationProject.files.length],
        id: `many-clip-${index + 1}`,
        name: `many-clip-${index + 1}.mp4`,
        metadata: {
          ...generationProject.files[index % generationProject.files.length].metadata,
          semanticFramesReviewed: 8,
          semanticEvents: index === 0
            ? [{ start: 4, end: 10, score: 88, state: "impact", action: "test impact", storyRole: "payoff", cutRisk: "high", payoffVerified: true }]
            : [],
          candidateWindows: [{ start: 4, end: 14, duration: 10, score: 82, reason: "indexed action", sceneChanges: 2, audioPeak: -12, storyRole: "payoff", cutRisk: "high" }]
        }
      })),
      drafts: []
    } as Project;
    const draft = {
      id: "many-draft",
      title: "Many Clip Highlight",
      description: "Generated from many clips",
      duration: 45,
      format: "Landscape" as const,
      style: "Cinematic",
      accent: "#b9ff66",
      score: 80,
      moments: 5,
      version: 1,
      music: "Game audio only",
      captionStyle: "Clean",
      intensity: 80,
      changes: [],
      segments: []
    };
    vi.mocked(api.listProjects).mockResolvedValueOnce([manyClipProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(manyClipProject);
    vi.mocked(api.reconcileProject).mockResolvedValue(manyClipProject);
    vi.mocked(api.generateDraft).mockResolvedValueOnce(draft);
    vi.mocked(api.renderDraft).mockResolvedValueOnce({
      draft: { ...draft, exportUrl: "/media/exports/many.mp4", exportPath: "D:\\exports\\many.mp4", status: "exported" },
      url: "/media/exports/many.mp4",
      localPath: "D:\\exports\\many.mp4"
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Many Clip Project/i }));
    await waitFor(() => expect(screen.getAllByText("Many Clip Project").length).toBeGreaterThan(1));

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    await waitFor(() => expect(screen.getByText("25 clips ready")).toBeInTheDocument());
    expect(screen.getByLabelText("Advice for a better video")).toHaveTextContent("AI sees 1 verified highlight moment");

    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => expect(api.generateDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.renderDraft).toHaveBeenCalledTimes(1));
    const idea = vi.mocked(api.generateDraft).mock.calls[0][1];
    expect(idea.fileIds).toHaveLength(25);
  });

  it("generates one video without requiring background music and shows the completed preview", async () => {
    const draft = {
      id: "generated-draft",
      title: "Generated Highlight",
      description: "Test generated highlight",
      duration: 30,
      format: "Landscape" as const,
      style: "Cinematic",
      accent: "#b9ff66",
      score: 90,
      moments: 5,
      version: 1,
      music: "Game audio only",
      captionStyle: "Clean",
      intensity: 80,
      changes: [],
      segments: []
    };
    vi.mocked(api.getProject).mockResolvedValueOnce(generationProject);
    vi.mocked(api.reconcileProject).mockResolvedValue(generationProject);
    vi.mocked(api.generateDraft).mockResolvedValueOnce(draft);
    vi.mocked(api.renderDraft).mockResolvedValueOnce({
      draft: { ...draft, exportUrl: "/media/exports/generated.mp4", exportPath: "D:\\exports\\generated.mp4", status: "exported" },
      url: "/media/exports/generated.mp4",
      localPath: "D:\\exports\\generated.mp4"
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Saved Folder/i }));
    await screen.findByText("Generation Project");

    expect(screen.getByLabelText("Choose music (optional)")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => expect(api.generateDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.renderDraft).toHaveBeenCalled());
    expect(vi.mocked(api.renderDraft).mock.calls[0][2]).toBeUndefined();
    expect(await screen.findByText("Your video is ready")).toBeInTheDocument();
    expect(document.querySelector(".simple-video-result video")).toHaveAttribute("src", "/media/exports/generated.mp4");
    expect(screen.getByRole("button", { name: /Your finished videos/i })).toHaveTextContent("1 saved video ready to watch");
    fireEvent.click(screen.getByRole("button", { name: /Your finished videos/i }));
    expect(await screen.findByRole("heading", { name: "Your finished videos" })).toBeInTheDocument();
    expect(screen.getByText("Generated Highlight", { selector: ".generated-video-list strong" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview Generated Highlight" }));
    expect(await screen.findByText("Generated video")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Version/i })).not.toBeInTheDocument();
  });
});
