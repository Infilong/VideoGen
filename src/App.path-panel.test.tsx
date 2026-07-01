import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreprocessJob, Project } from "./types";
import App, { chooseDiversifiedClips, highlightReviewCandidates } from "./App";
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
  maxDuration: 180
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
  confirmHighlightMoment: vi.fn(),
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
    maxHighlightSeconds: 180,
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
  markHighlightReviewed: vi.fn(),
  reconcileProject: vi.fn().mockResolvedValue(savedFolderProject),
  cancelPreprocessJob: vi.fn(),
  pauseFastIndexJob: vi.fn(),
  pausePreprocessJob: vi.fn(),
  resumeFastIndexJob: vi.fn(),
  resumePreprocessJob: vi.fn(),
  renderDraft: vi.fn(),
  requestAdvancedAdvice: vi.fn(),
  requestVisionReview: vi.fn(),
  rejectHighlightMoment: vi.fn(),
  removeHighlightConfirmation: vi.fn(),
  reviewDraft: vi.fn(),
  runFastIndex: vi.fn(),
  runPreprocess: vi.fn(),
  updateDraft: vi.fn()
}));

describe("path management", () => {
  beforeEach(() => {
    window.history.pushState(null, "", "/");
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("chooses 20 diversified lucky videos and changes consecutive picks", () => {
    const files = Array.from({ length: 24 }, (_, index) => ({
      ...savedFolderProject.files[index % savedFolderProject.files.length],
      id: "lucky-" + index,
      name: "lucky-" + index + ".mp4",
      metadata: {
        ...savedFolderProject.files[index % savedFolderProject.files.length].metadata,
        duration: index % 4 === 0 ? 24 : index % 4 === 1 ? 18 : index % 4 === 2 ? 15 : 12,
        semanticScore: 95 - index,
        semanticQuality: "weak" as const,
        aiDecision: "low_confidence" as const,
        visionApproved: false,
        visionScore: 0,
        ratingSource: "local-signals" as const,
        ratingConfidence: "low" as const,
        semanticTraits: { subject: "other", shotScale: "wide", environment: "gameplay", action: "local signal", intensity: 10, spectacle: 10, clarity: 50, obstruction: 0, payoffExpected: false },
        semanticRating: { trailerUsefulness: 0, excitement: 0, visualQuality: 0, novelty: 0, boredom: 0, payoffStage: "none", excludeReason: "none" },
        semanticEvents: [],
        semanticCandidateHistory: [],
        candidateWindows: [],
        confirmedHighlightMoments: [],
        semanticTags: [index % 3 === 0 ? "tank" : index % 3 === 1 ? "attack helicopter" : "infantry firefight"]
      }
    })) as Project["files"];

    const first = chooseDiversifiedClips(files, [], () => 0.5);
    const second = chooseDiversifiedClips(files, [first], () => 0.5);
    const durationOf = (ids: string[]) => ids.reduce((sum, id) => sum + Number(files.find((file) => file.id === id)?.metadata?.duration || 0), 0);
    const tagsOf = (ids: string[]) => new Set(ids.flatMap((id) => files.find((file) => file.id === id)?.metadata?.semanticTags || []));

    expect(first).toHaveLength(20);
    expect(new Set(first).size).toBe(20);
    expect(tagsOf(first).size).toBeGreaterThanOrEqual(3);
    expect(second).toHaveLength(20);
    expect(new Set(second).size).toBe(20);
    expect(second).not.toEqual(first);
    expect(second.some((id) => !first.includes(id))).toBe(true);
  });

  it("uses verified highlight windows, not whole long recordings, for lucky selection duration", () => {
    const files = Array.from({ length: 10 }, (_, index) => ({
      ...savedFolderProject.files[index % savedFolderProject.files.length],
      id: "long-lucky-" + index,
      name: "long-lucky-" + index + ".mp4",
      metadata: {
        ...savedFolderProject.files[index % savedFolderProject.files.length].metadata,
        duration: 180,
        semanticQuality: "verified" as const,
        semanticScore: 95 - index,
        semanticEvents: [{ start: 80, end: 88, score: 94 - index, state: "impact", action: "vehicle destruction", storyRole: "payoff", payoffVerified: true }],
        semanticTags: [index % 2 === 0 ? "tank" : "infantry firefight"]
      }
    })) as Project["files"];

    const picked = chooseDiversifiedClips(files, [], () => 0.5);

    expect(picked).toHaveLength(10);
  });

  it("shows source video generation usage count under the verified label", async () => {
    const countedProject = {
      ...savedFolderProject,
      files: [{
        ...savedFolderProject.files[0],
        metadata: {
          ...savedFolderProject.files[0].metadata,
          reviewed: true,
          generationUseCount: 2,
          generationLastUsedAt: "2026-06-30T00:00:00.000Z"
        }
      }, savedFolderProject.files[1]]
    } as Project;
    vi.mocked(api.listProjects).mockResolvedValueOnce([countedProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(countedProject);
    vi.mocked(api.reconcileProject).mockResolvedValue(countedProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Saved Folder/i }));

    expect(await screen.findByText("user verified")).toBeInTheDocument();
    expect(screen.getByText("used 2x")).toBeInTheDocument();
  });

  it("does not requeue clips with confirmed highlight moments for manual review", () => {
    const file = {
      ...savedFolderProject.files[0],
      metadata: {
        ...savedFolderProject.files[0].metadata,
        duration: 40,
        semanticEvents: [
          { start: 4, end: 10, score: 88, state: "impact", action: "old pick", storyRole: "payoff", payoffVerified: true },
          { start: 18, end: 27, score: 82, state: "impact", action: "new pick", storyRole: "payoff", payoffVerified: true }
        ],
        confirmedHighlightMoments: [{ start: 3.8, end: 10.2, duration: 6.4, score: 88, action: "old pick", storyRole: "payoff", source: "vision-verified", confirmedAt: "2026-06-28T00:00:00.000Z" }]
      }
    } as Project["files"][number];

    const candidates = highlightReviewCandidates(file);

    expect(candidates).toHaveLength(0);
  });

  it("does not create manual review candidates for clips already marked reviewed", () => {
    const file = {
      ...savedFolderProject.files[0],
      metadata: {
        ...savedFolderProject.files[0].metadata,
        duration: 40,
        reviewed: true,
        semanticEvents: [],
        semanticCandidateHistory: [
          { start: 8, end: 16, score: 88, state: "impact", action: "already reviewed moment", storyRole: "payoff", payoffVerified: false }
        ],
        candidateWindows: [{ start: 18, end: 28, duration: 10, score: 92, reason: "audio_peak", sceneChanges: 5, audioPeak: -8, storyRole: "payoff", cutRisk: "high" }]
      }
    } as Project["files"][number];

    expect(highlightReviewCandidates(file)).toHaveLength(0);
  });

  it("creates a manual review fallback for AI uncertain clips without candidate windows", () => {
    const file = {
      ...savedFolderProject.files[0],
      metadata: {
        ...savedFolderProject.files[0].metadata,
        duration: 60,
        semanticScore: 42,
        semanticFramesReviewed: 8,
        semanticReviewVersion: 2,
        semanticFineReviewed: true,
        semanticEvents: [],
        semanticCandidateHistory: [],
        candidateWindows: []
      }
    } as Project["files"][number];

    const candidates = highlightReviewCandidates(file);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: "ai-uncertain",
      label: "AI uncertain",
      action: "manual review needed"
    });
  });

  it("uses local highlight timing when weak Vision timing points at the wrong frame", () => {
    const file = {
      ...savedFolderProject.files[0],
      id: "short-payoff",
      name: "Battlefield 6 2026.06.10 - 23.09.50.27.DVR.mp4",
      metadata: {
        ...savedFolderProject.files[0].metadata,
        duration: 90.6,
        highlightStart: 60.4,
        semanticTopFrame: 33.2,
        semanticFramesReviewed: 16,
        semanticReviewVersion: 2,
        semanticFineReviewed: true,
        semanticQuality: "missed",
        semanticScore: 4,
        ratingConfidence: "low",
        indexScore: 30,
        actionScore: 6.8,
        aiDecision: "confirmed",
        semanticEvents: [],
        semanticCandidateHistory: [],
        candidateWindows: []
      }
    } as Project["files"][number];

    const candidates = highlightReviewCandidates(file);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: "local-signal",
      label: "Local signal",
      action: "local highlight signal"
    });
    expect(candidates[0].start).toBeGreaterThanOrEqual(55);
    expect(candidates[0].start).toBeLessThan(58);
    expect(candidates[0].end).toBeGreaterThan(60);
  });

  it("shows sustained local signals as polished review envelopes", () => {
    const file = {
      ...savedFolderProject.files[0],
      id: "sustained-payoff",
      name: "Battlefield 6 2026.06.14 - 00.20.26.13.DVR.mp4",
      metadata: {
        ...savedFolderProject.files[0].metadata,
        duration: 90.006521,
        highlightStart: 57.806125,
        semanticTopFrame: 16.2,
        semanticFramesReviewed: 16,
        semanticReviewVersion: 2,
        semanticFineReviewed: true,
        semanticQuality: "missed",
        semanticScore: 0,
        ratingConfidence: "low",
        indexScore: 32,
        actionScore: 22.4,
        aiDecision: "confirmed",
        semanticEvents: [],
        semanticCandidateHistory: [],
        candidateWindows: []
      }
    } as Project["files"][number];

    const candidates = highlightReviewCandidates(file);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: "local-signal",
      label: "Local signal"
    });
    expect(candidates[0].start).toBe(60);
    expect(candidates[0].end).toBeCloseTo(84, 1);
  });

  it("shows saved paths and loads a path's contents when clicked", async () => {
    const { container } = render(<App />);

    expect(screen.getByLabelText("Video creation workflow")).toHaveTextContent("Add footage");
    expect(screen.getByLabelText("Video creation workflow")).toHaveTextContent("Choose clips");
    expect(screen.getByLabelText("Video creation workflow")).toHaveTextContent("Set direction");
    expect(screen.getByLabelText("Video creation workflow")).toHaveTextContent("Review and complete");
    expect(await screen.findByText("Your folders")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Saved Folder/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Saved Folder/i }));

    await waitFor(() => expect(screen.getByText("Current footage")).toBeInTheDocument());
    expect(screen.getAllByText("D:\\Games\\Clips")[0]).toBeInTheDocument();
    expect(screen.getByText("Your clips")).toBeInTheDocument();
    expect(screen.getByText(/Next: Generate video creates a plan/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Generation readiness evidence")).toBeInTheDocument();
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

  it("lets users trim and confirm selected highlight periods before generation", async () => {
    const reviewProject = {
      ...savedFolderProject,
      id: "review-folder",
      name: "Review Folder",
      files: [{
        ...savedFolderProject.files[0],
        id: "review-clip",
        metadata: {
          ...savedFolderProject.files[0].metadata,
          duration: 40,
          semanticEvents: [],
          semanticCandidateHistory: [{ start: 8, end: 18, score: 90, state: "aim", action: "tank duel", storyRole: "payoff", payoffVerified: false }],
          candidateWindows: [{ start: 20, end: 30, duration: 10, score: 80, reason: "audio_peak", sceneChanges: 4, audioPeak: -8, storyRole: "payoff", cutRisk: "high" }]
        }
      }]
    } as Project;
    const confirmedProject = {
      ...reviewProject,
      files: reviewProject.files.map((file) => ({
        ...file,
        metadata: {
          ...file.metadata,
          confirmedHighlightMoments: [{ start: 9, end: 16, duration: 7, score: 72, action: "tank duel", storyRole: "payoff", source: "vision-candidate", confirmedAt: "2026-06-28T00:00:00.000Z" }]
        }
      }))
    } as Project;
    vi.mocked(api.listProjects).mockResolvedValueOnce([reviewProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(reviewProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(reviewProject);
    vi.mocked(api.confirmHighlightMoment).mockResolvedValueOnce(confirmedProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Review Folder/i }));
    const checkbox = await screen.findByRole("checkbox", { name: /Select first-highlight/i });
    fireEvent.change(checkbox, { target: { checked: true } });
    await waitFor(() => expect(checkbox).toBeChecked());
    const reviewButton = await waitFor(() => {
      const enabled = screen.getAllByRole("button", { name: /Review moments/i }).find((button) => !button.hasAttribute("disabled"));
      if (!enabled) throw new Error("Review moments button is still disabled");
      return enabled;
    });
    expect(reviewButton).toBeEnabled();

    fireEvent.click(reviewButton);
    expect(await screen.findByText("Review page")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/review");
    fireEvent.change(screen.getByLabelText("Trim start"), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText("Trim end"), { target: { value: "16" } });
    fireEvent.click(screen.getByRole("button", { name: /Agree, use it/i }));

    await waitFor(() => expect(api.confirmHighlightMoment).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.confirmHighlightMoment).mock.calls[0][2]).toMatchObject({
      start: 9,
      end: 16,
      source: "vision-candidate"
    });
    expect(await screen.findByText(/1 of 2 reviewed .* 1 agreed/)).toBeInTheDocument();
    expect(await screen.findByText(/1 saved/)).toBeInTheDocument();
    expect(screen.getAllByText(/00:09-00:16/).length).toBeGreaterThan(0);
  });

  it("reviews all AI uncertain candidates even when they are not selected", async () => {
    const selectedFiles = Array.from({ length: 12 }, (_, index) => ({
      ...savedFolderProject.files[index % savedFolderProject.files.length],
      id: `selected-${index}`,
      name: `selected-${index}.mp4`,
      metadata: {
        ...savedFolderProject.files[index % savedFolderProject.files.length].metadata,
        duration: 30,
        indexScore: 100 - index,
        semanticScore: 0,
        semanticEvents: [],
        semanticCandidateHistory: []
      }
    }));
    const uncertainFile = {
      ...savedFolderProject.files[0],
      id: "uncertain-manual-review",
      name: "uncertain-manual-review.mp4",
      metadata: {
        ...savedFolderProject.files[0].metadata,
        duration: 45,
        indexScore: 1,
        semanticScore: 48,
        semanticFramesReviewed: 10,
        semanticReviewVersion: 2,
        semanticFineReviewed: true,
        semanticEvents: [],
        semanticCandidateHistory: [{ start: 11, end: 24, score: 58, state: "impact", action: "uncertain tank hit", storyRole: "payoff", payoffVerified: false }]
      }
    };
    const uncertainProject = {
      ...savedFolderProject,
      id: "uncertain-folder",
      name: "Uncertain Folder",
      files: [...selectedFiles, uncertainFile]
    } as Project;
    vi.mocked(api.listProjects).mockResolvedValueOnce([uncertainProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(uncertainProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(uncertainProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Uncertain Folder/i }));

    expect(await screen.findByText("0", { selector: ".selected-count strong" })).toBeInTheDocument();
    const uncertainCheckbox = await screen.findByRole("checkbox", { name: /Select uncertain-manual-review\.mp4/i });
    expect(uncertainCheckbox).not.toBeChecked();
    const reviewButton = await waitFor(() => {
      const enabled = screen.getAllByRole("button", { name: /Review moments/i }).find((button) => !button.hasAttribute("disabled"));
      if (!enabled) throw new Error("Review moments button is still disabled");
      return enabled;
    });

    fireEvent.click(reviewButton);

    expect(await screen.findByText("Review page")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "uncertain-manual-review" })).toBeInTheDocument();
    expect(screen.getByText(/0 of 1 reviewed .* Part 1 of 1/)).toBeInTheDocument();
  });

  it("pauses play period at the selected end time", async () => {
    const playMock = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pauseMock = vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const reviewProject = {
      ...savedFolderProject,
      id: "play-period-folder",
      name: "Play Period Folder",
      files: [{
        ...savedFolderProject.files[0],
        id: "play-period-clip",
        metadata: {
          ...savedFolderProject.files[0].metadata,
          duration: 40,
          semanticEvents: [{ start: 6, end: 14, score: 83, state: "impact", action: "vehicle hit", storyRole: "payoff", payoffVerified: true }]
        }
      }]
    } as Project;
    vi.mocked(api.listProjects).mockResolvedValueOnce([reviewProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(reviewProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(reviewProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Play Period Folder/i }));
    const checkbox = await screen.findByRole("checkbox", { name: /Select first-highlight/i });
    fireEvent.change(checkbox, { target: { checked: true } });
    await waitFor(() => expect(checkbox).toBeChecked());
    const reviewButton = await waitFor(() => {
      const enabled = screen.getAllByRole("button", { name: /Review moments/i }).find((button) => !button.hasAttribute("disabled"));
      if (!enabled) throw new Error("Review moments button is still disabled");
      return enabled;
    });

    fireEvent.click(reviewButton);
    const video = await waitFor(() => {
      const element = document.querySelector("video");
      if (!element) throw new Error("Video preview did not render");
      return element as HTMLVideoElement;
    });
    fireEvent.change(screen.getByLabelText("Trim end"), { target: { value: "18" } });
    expect(video.currentTime).toBe(18);
    fireEvent.change(screen.getByLabelText("Trim start"), { target: { value: "7" } });
    expect(video.currentTime).toBe(7);
    fireEvent.click(screen.getByRole("button", { name: /^Play period$/i }));
    await waitFor(() => expect(playMock).toHaveBeenCalled());
    video.currentTime = 18;
    fireEvent.timeUpdate(video);

    expect(pauseMock).toHaveBeenCalled();
    expect(video.currentTime).toBe(18);
    playMock.mockRestore();
    pauseMock.mockRestore();
  });

  it("lets users reconfirm a wrongly confirmed highlight period", async () => {
    const confirmedProject = {
      ...savedFolderProject,
      id: "reconfirm-folder",
      name: "Reconfirm Folder",
      files: [{
        ...savedFolderProject.files[0],
        id: "reconfirm-clip",
        metadata: {
          ...savedFolderProject.files[0].metadata,
          duration: 40,
          semanticEvents: [{ start: 4, end: 10, score: 82, state: "impact", action: "old pick", storyRole: "payoff", payoffVerified: true }],
          confirmedHighlightMoments: [{ start: 4, end: 10, duration: 6, score: 82, action: "old pick", storyRole: "payoff", source: "vision-verified", confirmedAt: "2026-06-28T00:00:00.000Z" }]
        }
      }]
    } as Project;
    const updatedProject = {
      ...confirmedProject,
      files: confirmedProject.files.map((file) => ({
        ...file,
        metadata: {
          ...file.metadata,
          confirmedHighlightMoments: [{ start: 18, end: 27, duration: 9, score: 82, action: "old pick", storyRole: "payoff", source: "vision-verified", confirmedAt: "2026-06-28T00:10:00.000Z" }]
        }
      }))
    } as Project;
    vi.mocked(api.listProjects).mockResolvedValueOnce([confirmedProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(confirmedProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(confirmedProject);
    vi.mocked(api.confirmHighlightMoment).mockResolvedValueOnce(updatedProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reconfirm Folder/i }));
    const checkbox = await screen.findByRole("checkbox", { name: /Select first-highlight/i });
    fireEvent.change(checkbox, { target: { checked: true } });
    await waitFor(() => expect(checkbox).toBeChecked());
    const reviewButton = await waitFor(() => {
      const enabled = screen.getAllByRole("button", { name: /Review moments/i }).find((button) => !button.hasAttribute("disabled"));
      if (!enabled) throw new Error("Review moments button is still disabled");
      return enabled;
    });

    fireEvent.click(reviewButton);
    expect(await screen.findByText(/1 saved/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Reconfirm$/i }));
    fireEvent.change(screen.getByLabelText("Trim start"), { target: { value: "18" } });
    fireEvent.change(screen.getByLabelText("Trim end"), { target: { value: "27" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirmed/i }));

    await waitFor(() => expect(api.confirmHighlightMoment).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.confirmHighlightMoment).mock.calls[0][2]).toMatchObject({
      start: 18,
      end: 27
    });
    expect((await screen.findAllByText(/00:18-00:27/)).length).toBeGreaterThan(0);
  });

  it("reviews planned cuts before rendering selected AI periods", async () => {
    const reviewProject = {
      ...savedFolderProject,
      id: "needs-confirmation-folder",
      name: "Needs Confirmation",
      files: [{
        ...savedFolderProject.files[0],
        id: "needs-confirmation-clip",
        metadata: {
          ...savedFolderProject.files[0].metadata,
          duration: 40,
          semanticEvents: [{ start: 5, end: 14, score: 81, state: "impact", action: "rocket hit", storyRole: "payoff", payoffVerified: true }]
        }
      }]
    } as Project;
    vi.mocked(api.listProjects).mockResolvedValueOnce([reviewProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(reviewProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(reviewProject);
    vi.mocked(api.confirmHighlightMoment).mockResolvedValue(reviewProject);
    const draft = {
      id: "auto-uncertain-draft",
      title: "Auto Uncertain Highlight",
      description: "Generated from reviewed moments",
      duration: 30,
      format: "Landscape" as const,
      style: "Trailer",
      accent: "#b9ff66",
      score: 88,
      moments: 3,
      version: 1,
      music: "Game audio only",
      captionStyle: "Clean",
      intensity: 80,
      changes: [],
      segments: [{ fileId: "needs-confirmation-clip", start: 3, duration: 12, score: 81, source: "vision", confidence: "high" as const }]
    };
    vi.mocked(api.generateDraft).mockResolvedValueOnce(draft);
    vi.mocked(api.updateDraft).mockImplementation(async (_projectId, _draftId, changes) => ({ ...draft, ...changes, version: 2 }));
    vi.mocked(api.renderDraft).mockResolvedValueOnce({
      draft: { ...draft, exportUrl: "/media/exports/auto.mp4", exportPath: "D:\\exports\\auto.mp4", status: "exported" },
      url: "/media/exports/auto.mp4",
      localPath: "D:\\exports\\auto.mp4"
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Needs Confirmation/i }));
    const checkbox = await screen.findByRole("checkbox", { name: /Select first-highlight/i });
    fireEvent.change(checkbox, { target: { checked: true } });
    await waitFor(() => expect(checkbox).toBeChecked());
    const generateAction = await waitFor(() => {
      const enabled = screen.getAllByRole("button", { name: /^Generate video$/i }).find((button) => !button.hasAttribute("disabled"));
      if (!enabled) throw new Error("Generate video button is still disabled");
      return enabled;
    });
    fireEvent.click(generateAction);

    await waitFor(() => expect(api.generateDraft).toHaveBeenCalledTimes(1));
    expect(window.location.pathname).toBe("/review");
    expect(api.renderDraft).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByLabelText("Trim start"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Trim end"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: /Agree, use it/i }));
    await waitFor(() => expect(api.confirmHighlightMoment).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.confirmHighlightMoment).mock.calls[0][2]).toMatchObject({
      start: 8,
      end: 11,
      replaceStart: 3,
      replaceEnd: 15
    });
    expect(await screen.findByRole("heading", { name: "Generate this reviewed video?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Generate now$/i }));
    await waitFor(() => expect(api.updateDraft).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateDraft).mock.calls[0][2]).toMatchObject({
      segments: [expect.objectContaining({ fileId: "needs-confirmation-clip", start: 8, duration: 3 })]
    });
    await waitFor(() => expect(api.renderDraft).toHaveBeenCalled());
  });

  it("does not ask users to re-approve planned cuts from clips already marked reviewed", async () => {
    const reviewedProject = {
      ...savedFolderProject,
      id: "already-reviewed-folder",
      name: "Already Reviewed",
      files: [{
        ...savedFolderProject.files[0],
        id: "already-reviewed-clip",
        metadata: {
          ...savedFolderProject.files[0].metadata,
          duration: 40,
          reviewed: true,
          reviewedAt: "2026-06-29T00:00:00.000Z",
          semanticEvents: [{ start: 5, end: 14, score: 81, state: "impact", action: "rocket hit", storyRole: "payoff", payoffVerified: true }],
          confirmedHighlightMoments: [{ start: 5, end: 14, duration: 9, score: 81, state: "impact", action: "rocket hit", storyRole: "payoff", source: "human-reviewed", confirmedAt: "2026-06-29T00:00:00.000Z" }]
        }
      }]
    } as Project;
    const draft = {
      id: "already-reviewed-draft",
      title: "Already Reviewed Highlight",
      description: "Generated from reviewed moments",
      duration: 30,
      format: "Landscape" as const,
      style: "Trailer",
      accent: "#b9ff66",
      score: 88,
      moments: 1,
      version: 1,
      music: "Game audio only",
      captionStyle: "Clean",
      intensity: 80,
      changes: [],
      fileIds: ["already-reviewed-clip"],
      segments: [{ fileId: "already-reviewed-clip", start: 5, duration: 9, score: 81, source: "vision", confidence: "high" as const }]
    };
    vi.mocked(api.listProjects).mockResolvedValueOnce([reviewedProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(reviewedProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(reviewedProject);
    vi.mocked(api.generateDraft).mockResolvedValueOnce(draft);
    vi.mocked(api.updateDraft).mockImplementation(async (_projectId, _draftId, changes) => ({ ...draft, ...changes, version: 2 }));
    vi.mocked(api.renderDraft).mockResolvedValueOnce({
      draft: { ...draft, exportUrl: "/media/exports/reviewed.mp4", exportPath: "D:\\exports\\neviewed.mp4", status: "exported" },
      url: "/media/exports/reviewed.mp4",
      localPath: "D:\\exports\\neviewed.mp4"
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Already Reviewed/i }));
    const checkbox = await screen.findByRole("checkbox", { name: /Select first-highlight/i });
    fireEvent.change(checkbox, { target: { checked: true } });
    await waitFor(() => expect(checkbox).toBeChecked());
    const generateAction = await waitFor(() => {
      const enabled = screen.getAllByRole("button", { name: /^Generate video$/i }).find((button) => !button.hasAttribute("disabled"));
      if (!enabled) throw new Error("Generate video button is still disabled");
      return enabled;
    });
    fireEvent.click(generateAction);

    await waitFor(() => expect(api.generateDraft).toHaveBeenCalledTimes(1));
    expect(window.location.pathname).toBe("/review");
    expect(api.renderDraft).not.toHaveBeenCalled();
    expect(api.confirmHighlightMoment).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Generate this reviewed video?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Generate now$/i }));
    await waitFor(() => expect(api.updateDraft).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateDraft).mock.calls[0][2]).toMatchObject({
      reviewedFileIds: ["already-reviewed-clip"],
      segments: [expect.objectContaining({ fileId: "already-reviewed-clip", start: 5, duration: 9 })]
    });
    await waitFor(() => expect(api.renderDraft).toHaveBeenCalledTimes(1));
  });

  it("skips already user-reviewed planned cuts and reviews only unverified planned cuts", async () => {
    const mixedProject = {
      ...savedFolderProject,
      id: "mixed-reviewed-folder",
      name: "Mixed Reviewed",
      files: [
        {
          ...savedFolderProject.files[0],
          id: "mixed-reviewed-clip",
          metadata: {
            ...savedFolderProject.files[0].metadata,
            duration: 40,
            reviewed: true,
            reviewedAt: "2026-06-29T00:00:00.000Z",
            semanticEvents: [{ start: 5, end: 14, score: 86, state: "impact", action: "saved rocket hit", storyRole: "payoff", payoffVerified: true }],
            confirmedHighlightMoments: [{ start: 5, end: 14, duration: 9, score: 86, state: "impact", action: "saved rocket hit", storyRole: "payoff", source: "human-reviewed", confirmedAt: "2026-06-29T00:00:00.000Z" }]
          }
        },
        {
          ...savedFolderProject.files[1],
          id: "mixed-unreviewed-clip",
          metadata: {
            ...savedFolderProject.files[1].metadata,
            duration: 45,
            semanticEvents: [{ start: 16, end: 25, score: 82, state: "impact", action: "new vehicle hit", storyRole: "payoff", payoffVerified: true }]
          }
        }
      ]
    } as Project;
    const draft = {
      id: "mixed-reviewed-draft",
      title: "Mixed Reviewed Highlight",
      description: "Generated from selected moments",
      duration: 30,
      format: "Landscape" as const,
      style: "Trailer",
      accent: "#b9ff66",
      score: 88,
      moments: 2,
      version: 1,
      music: "Game audio only",
      captionStyle: "Clean",
      intensity: 80,
      changes: [],
      fileIds: ["mixed-reviewed-clip", "mixed-unreviewed-clip"],
      segments: [
        { fileId: "mixed-reviewed-clip", start: 5, duration: 9, score: 86, source: "vision", confidence: "high" as const },
        { fileId: "mixed-unreviewed-clip", start: 16, duration: 9, score: 82, source: "vision", confidence: "high" as const }
      ]
    };
    vi.mocked(api.listProjects).mockResolvedValueOnce([mixedProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(mixedProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(mixedProject);
    vi.mocked(api.generateDraft).mockResolvedValueOnce(draft);
    vi.mocked(api.confirmHighlightMoment).mockResolvedValue(mixedProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Mixed Reviewed/i }));
    for (const checkbox of await screen.findAllByRole("checkbox", { name: /Select .*highlight\.mp4/i })) {
      fireEvent.change(checkbox, { target: { checked: true } });
    }
    const generateAction = await waitFor(() => {
      const enabled = screen.getAllByRole("button", { name: /^Generate video$/i }).find((button) => !button.hasAttribute("disabled"));
      if (!enabled) throw new Error("Generate video button is still disabled");
      return enabled;
    });
    fireEvent.click(generateAction);

    await waitFor(() => expect(api.generateDraft).toHaveBeenCalledTimes(1));
    expect(window.location.pathname).toBe("/review");
    expect(await screen.findByRole("heading", { name: "second-highlight" })).toBeInTheDocument();
    expect(screen.getByText(/0 of 1 reviewed - 1 agreed - 00:09 approved - Part 1 of 1/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Confirmed$/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Agree, use it/i }));

    await waitFor(() => expect(api.confirmHighlightMoment).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.confirmHighlightMoment).mock.calls[0][1]).toBe("mixed-unreviewed-clip");
  });

  it("marks skipped candidates reviewed so they are not shown again", async () => {
    const reviewProject = {
      ...savedFolderProject,
      id: "skip-folder",
      name: "Skip Folder",
      files: [{
        ...savedFolderProject.files[0],
        id: "skip-clip",
        metadata: {
          ...savedFolderProject.files[0].metadata,
          duration: 40,
          semanticEvents: [],
          semanticCandidateHistory: [
            { start: 5, end: 12, score: 92, state: "aim", action: "first candidate", storyRole: "payoff", payoffVerified: false },
            { start: 20, end: 28, score: 84, state: "impact", action: "second candidate", storyRole: "payoff", payoffVerified: false }
          ]
        }
      }]
    } as Project;
    vi.mocked(api.listProjects).mockResolvedValueOnce([reviewProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(reviewProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(reviewProject);
    vi.mocked(api.markHighlightReviewed).mockResolvedValueOnce({
      ...reviewProject,
      files: reviewProject.files.map((file) => ({
        ...file,
        metadata: { ...file.metadata, reviewed: true, reviewedAt: "2026-06-29T00:00:00.000Z" }
      }))
    } as Project);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Skip Folder/i }));
    const checkbox = await screen.findByRole("checkbox", { name: /Select first-highlight/i });
    fireEvent.change(checkbox, { target: { checked: true } });
    await waitFor(() => expect(checkbox).toBeChecked());
    const reviewButton = await waitFor(() => {
      const enabled = screen.getAllByRole("button", { name: /Review moments/i }).find((button) => !button.hasAttribute("disabled"));
      if (!enabled) throw new Error("Review moments button is still disabled");
      return enabled;
    });

    fireEvent.click(reviewButton);
    expect(await screen.findByText(/0 of 2 reviewed .* Part 1 of 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Skip this time/i }));

    await waitFor(() => expect(api.markHighlightReviewed).toHaveBeenCalledWith("skip-folder", "skip-clip", true));
    expect(api.rejectHighlightMoment).not.toHaveBeenCalled();
    expect(await screen.findByText(/1 of 2 reviewed/)).toBeInTheDocument();
  });

  it("can permanently reject a period as not a highlight", async () => {
    const reviewProject = {
      ...savedFolderProject,
      id: "reject-folder",
      name: "Reject Folder",
      files: [{
        ...savedFolderProject.files[0],
        id: "reject-clip",
        metadata: {
          ...savedFolderProject.files[0].metadata,
          duration: 40,
          semanticEvents: [],
          semanticCandidateHistory: [{ start: 8, end: 18, score: 90, state: "aim", action: "not good", storyRole: "payoff", payoffVerified: false }]
        }
      }]
    } as Project;
    const rejectedProject = {
      ...reviewProject,
      files: reviewProject.files.map((file) => ({
        ...file,
        metadata: {
          ...file.metadata,
          semanticCandidateHistory: [],
          rejectedHighlightMoments: [{ start: 8, end: 18, duration: 10, reason: "not-highlight", source: "vision-candidate", rejectedAt: "2026-06-28T00:00:00.000Z" }]
        }
      }))
    } as Project;
    vi.mocked(api.listProjects).mockResolvedValueOnce([reviewProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(reviewProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(reviewProject);
    vi.mocked(api.rejectHighlightMoment).mockResolvedValueOnce(rejectedProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reject Folder/i }));
    const checkbox = await screen.findByRole("checkbox", { name: /Select first-highlight/i });
    fireEvent.change(checkbox, { target: { checked: true } });
    await waitFor(() => expect(checkbox).toBeChecked());
    const reviewButton = await waitFor(() => {
      const enabled = screen.getAllByRole("button", { name: /Review moments/i }).find((button) => !button.hasAttribute("disabled"));
      if (!enabled) throw new Error("Review moments button is still disabled");
      return enabled;
    });

    fireEvent.click(reviewButton);
    expect(await screen.findByText("Review page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Not a highlight/i }));

    await waitFor(() => expect(api.rejectHighlightMoment).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.rejectHighlightMoment).mock.calls[0][2]).toMatchObject({
      start: 8,
      end: 18,
      reason: "not-highlight"
    });
    expect(await screen.findByText("No active candidate")).toBeInTheDocument();
    expect(await screen.findByText(/This period will not be shown or used again/)).toBeInTheDocument();
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

  it("shows a user verified label for clips the user already reviewed", async () => {
    const reviewedProject = {
      ...savedFolderProject,
      id: "user-verified-folder",
      name: "User Verified Folder",
      files: [{
        ...savedFolderProject.files[0],
        metadata: {
          ...savedFolderProject.files[0].metadata,
          reviewed: true,
          semanticScore: 86,
          semanticQuality: "verified" as const,
          semanticEvents: [{ start: 3, end: 9, score: 86, state: "impact", action: "verified event", payoffVerified: true }]
        }
      }]
    } as Project;
    vi.mocked(api.listProjects).mockResolvedValueOnce([reviewedProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(reviewedProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(reviewedProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /User Verified Folder/i }));

    expect(await screen.findByText("user verified")).toBeInTheDocument();
    expect(screen.getByTitle("You already reviewed this clip. HighlightAI will not ask you to review it again.")).toBeInTheDocument();
  });

  it("lets users select an AI-flagged clip as a false red flag override", async () => {
    const flaggedProject = {
      ...savedFolderProject,
      id: "false-red-flag-folder",
      name: "False Red Flag Folder",
      files: [{
        ...savedFolderProject.files[0],
        id: "battlefield-false-red-flag",
        name: "Battlefield 6 2026.01.02 - 22.49.15.33.DVR.mp4",
        metadata: {
          ...savedFolderProject.files[0].metadata,
          semanticScore: 12,
          semanticFramesReviewed: 8,
          semanticFineReviewed: true,
          semanticReviewVersion: 2,
          semanticReviewAttemptVersion: 2,
          semanticReviewAttempts: 2,
          aiDecision: "rejected" as const,
          semanticRejectReason: "AI saw no complete payoff"
        }
      }]
    } as Project;
    const flaggedDraft = {
      id: "false-red-flag-draft",
      title: "False Red Flag Highlight",
      description: "Manual override generation",
      duration: 20,
      format: "Landscape" as const,
      style: "Trailer",
      accent: "#b9ff66",
      score: 84,
      moments: 1,
      version: 1,
      music: "Game audio only",
      captionStyle: "Clean",
      intensity: 75,
      changes: [],
      fileIds: ["battlefield-false-red-flag"],
      segments: [{ fileId: "battlefield-false-red-flag", start: 2, duration: 12, score: 84, source: "manual", confidence: "medium" as const }]
    };
    vi.mocked(api.listProjects).mockResolvedValueOnce([flaggedProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(flaggedProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(flaggedProject);
    vi.mocked(api.generateDraft).mockResolvedValueOnce(flaggedDraft);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /False Red Flag Folder/i }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Select Battlefield 6/i }));

    expect(await screen.findByText(/Selected despite the AI red flag/i)).toBeInTheDocument();
    expect(screen.getAllByText(/1 selected/).length).toBeGreaterThan(0);
    expect(screen.getByText(/AI rejected this clip as low-signal, but that is only a recommendation/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));
    await waitFor(() => expect(api.generateDraft).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.generateDraft).mock.calls[0][1].fileIds).toEqual(["battlefield-false-red-flag"]);
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
    expect(await screen.findByText("AI verified 75")).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Four-column grid view" }));
    expect(document.querySelector(".clip-grid")).toHaveClass("view-grid-4");
    expect(localStorage.getItem("highlight-ai-library-view")).toBe("grid-4");
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
    expect(screen.getByRole("option", { name: "Play music twice, up to 3 minutes" })).toBeInTheDocument();
    expect(screen.getAllByText("AI chooses the best duration, up to 3 minutes.").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Add music file" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create another version" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Version 1" })).not.toBeInTheDocument();
  });

  it("uses a finite show-more control instead of a stuck loading state at the end of clip paging", async () => {
    const largeProject = {
      ...savedFolderProject,
      id: "large-library",
      name: "Large Library",
      files: Array.from({ length: 45 }, (_, index) => ({
        ...savedFolderProject.files[index % savedFolderProject.files.length],
        id: `large-clip-${index + 1}`,
        name: `large-clip-${index + 1}.mp4`,
        metadata: {
          ...savedFolderProject.files[index % savedFolderProject.files.length].metadata,
          duration: 20 + index,
          indexScore: 100 - index
        }
      }))
    } as Project;
    vi.mocked(api.listProjects).mockResolvedValueOnce([largeProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(largeProject);
    vi.mocked(api.reconcileProject).mockResolvedValueOnce(largeProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Large Library/i }));

    expect(await screen.findByText("Showing 40 of 45 clips")).toBeInTheDocument();
    expect(screen.queryByText("Loading more clips...")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    await waitFor(() => expect(screen.queryByLabelText("More clips available")).not.toBeInTheDocument());
    expect(screen.queryByText("Loading more clips...")).not.toBeInTheDocument();
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
      segments: [{ fileId: "many-clip-1", start: 4, duration: 10, score: 88, source: "index", confidence: "high" as const }]
    };
    vi.mocked(api.listProjects).mockResolvedValueOnce([manyClipProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(manyClipProject);
    vi.mocked(api.reconcileProject).mockResolvedValue(manyClipProject);
    vi.mocked(api.generateDraft).mockResolvedValueOnce(draft);
    vi.mocked(api.confirmHighlightMoment).mockResolvedValue(manyClipProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Many Clip Project/i }));
    await waitFor(() => expect(screen.getAllByText("Many Clip Project").length).toBeGreaterThan(1));

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    await waitFor(() => expect(screen.getByText("25 selected clips ready for review checkpoint")).toBeInTheDocument());
    expect(screen.getByLabelText("Advice for a better video")).toHaveTextContent("25 selected clips are AI-verified");

    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => expect(api.generateDraft).toHaveBeenCalledTimes(1));
    expect(api.renderDraft).not.toHaveBeenCalled();
    expect(await screen.findByText(/0 of 20 reviewed - 0 agreed - .* approved - Part 1 of 20/)).toBeInTheDocument();
    for (let index = 0; index < 20; index += 1) {
      fireEvent.click(await screen.findByRole("button", { name: /Agree, use it/i }));
      await waitFor(() => expect(api.confirmHighlightMoment).toHaveBeenCalledTimes(index + 1));
    }
    expect(await screen.findByRole("heading", { name: "Generate this reviewed video?" })).toBeInTheDocument();
    const idea = vi.mocked(api.generateDraft).mock.calls[0][1];
    expect(idea.fileIds).toHaveLength(25);
  }, 12000);

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
      segments: [{ fileId: "generation-clip-1", start: 4, duration: 6, score: 90, source: "vision", confidence: "high" as const }]
    };
    vi.mocked(api.getProject).mockResolvedValueOnce(generationProject);
    vi.mocked(api.reconcileProject).mockResolvedValue(generationProject);
    vi.mocked(api.generateDraft).mockResolvedValueOnce(draft);
    vi.mocked(api.confirmHighlightMoment).mockResolvedValue(generationProject);
    vi.mocked(api.updateDraft).mockImplementation(async (_projectId, _draftId, changes) => ({ ...draft, ...changes, version: 2 }));
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
    expect(api.renderDraft).not.toHaveBeenCalled();
    const agreeButton = screen.queryByRole("button", { name: /Agree, use it/i });
    if (agreeButton) {
      fireEvent.click(agreeButton);
      await waitFor(() => expect(api.confirmHighlightMoment).toHaveBeenCalledTimes(1));
      expect(await screen.findByRole("heading", { name: "Generate this reviewed video?" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /^Generate now$/i }));
    } else {
      expect(await screen.findByText("All planned parts reviewed")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Generate reviewed video/i }));
    }
    await waitFor(() => expect(api.updateDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.renderDraft).toHaveBeenCalled());
    expect(vi.mocked(api.renderDraft).mock.calls[0][2]).toBeUndefined();
    expect(await screen.findByText("Export complete. Your MP4 is ready.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Your finished videos/i })).toHaveTextContent("1 saved video ready to watch");
    fireEvent.click(screen.getByRole("button", { name: /Your finished videos/i }));
    expect(await screen.findByRole("heading", { name: "Your finished videos" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview Generated Highlight" }));
    expect(await screen.findByText("Generated video")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Version/i })).not.toBeInTheDocument();
  });

  it("enters review before warning when the selected soundtrack is longer than approved parts", async () => {
    const shortMusicProject = {
      ...generationProject,
      assets: [{
        id: "long-music",
        name: "long-theme.flac",
        size: 1234,
        type: "audio" as const,
        source: "local-asset" as const,
        url: "/media/uploads/long-theme.flac",
        duration: 100
      }]
    } as Project;
    const draft = {
      id: "short-source-draft",
      title: "Short Source Highlight",
      description: "Test generated highlight",
      duration: 30,
      format: "Landscape" as const,
      style: "Trailer",
      accent: "#b9ff66",
      score: 90,
      moments: 5,
      version: 1,
      music: "long-theme.flac",
      captionStyle: "Clean",
      intensity: 80,
      changes: [],
      fileIds: ["generation-clip-1"],
      segments: [{ fileId: "generation-clip-1", start: 4, duration: 6, score: 90, source: "vision", confidence: "high" as const }]
    };
    vi.mocked(api.getProject).mockResolvedValueOnce(shortMusicProject);
    vi.mocked(api.reconcileProject).mockResolvedValue(shortMusicProject);
    vi.mocked(api.generateDraft).mockResolvedValueOnce(draft);
    vi.mocked(api.confirmHighlightMoment).mockResolvedValue(shortMusicProject);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Saved Folder/i }));
    await screen.findByText("Generation Project");

    fireEvent.change(screen.getByLabelText("Choose music (optional)"), { target: { value: "long-music" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => expect(api.generateDraft).toHaveBeenCalledTimes(1));
    expect(window.location.pathname).toBe("/review");
    expect(screen.queryByRole("alert", { name: "Add more clips for selected music" })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /Agree, use it/i }));
    await waitFor(() => expect(api.confirmHighlightMoment).toHaveBeenCalledTimes(1));

    expect(await screen.findByRole("alert", { name: "Add more reviewed parts for selected music" })).toBeInTheDocument();
    expect(screen.getByText(/total 00:06, but long-theme\.flac needs 01:40/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate anyway" })).not.toBeInTheDocument();
    expect(api.renderDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Choose more clips" }));
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(screen.getByText("Generate your highlight")).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "Reviewed parts saved" })).toBeInTheDocument();
    expect(api.renderDraft).not.toHaveBeenCalled();
  });

  it("asks users to add more reviewed parts when approved highlight duration is shorter than the soundtrack", async () => {
    const musicProject = {
      ...generationProject,
      assets: [{
        id: "review-music",
        name: "review-theme.flac",
        size: 1234,
        type: "audio" as const,
        source: "local-asset" as const,
        url: "/media/uploads/review-theme.flac",
        duration: 60
      }]
    } as Project;
    const draft = {
      id: "review-short-draft",
      title: "Review Short Highlight",
      description: "Test generated highlight",
      duration: 30,
      format: "Landscape" as const,
      style: "Trailer",
      accent: "#b9ff66",
      score: 90,
      moments: 5,
      version: 1,
      music: "review-theme.flac",
      captionStyle: "Clean",
      intensity: 80,
      changes: [],
      segments: [{ fileId: "generation-clip-1", start: 4, duration: 6, score: 90, source: "vision", confidence: "high" as const }]
    };
    vi.mocked(api.getProject).mockResolvedValueOnce(musicProject);
    vi.mocked(api.reconcileProject).mockResolvedValue(musicProject);
    vi.mocked(api.generateDraft).mockResolvedValueOnce(draft);
    vi.mocked(api.confirmHighlightMoment).mockResolvedValue(musicProject);
    vi.mocked(api.updateDraft).mockImplementation(async (_projectId, _draftId, changes) => ({ ...draft, ...changes, version: 2 }));
    vi.mocked(api.renderDraft).mockResolvedValueOnce({
      draft: { ...draft, exportUrl: "/media/exports/review-short.mp4", exportPath: "D:\\exports\\neview-short.mp4", status: "exported" },
      url: "/media/exports/review-short.mp4",
      localPath: "D:\\exports\\neview-short.mp4"
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Saved Folder/i }));
    await screen.findByText("Generation Project");

    fireEvent.change(screen.getByLabelText("Choose music (optional)"), { target: { value: "review-music" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => expect(api.generateDraft).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: /Agree, use it/i }));
    await waitFor(() => expect(api.confirmHighlightMoment).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert", { name: "Add more reviewed parts for selected music" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Generate this reviewed video?" })).not.toBeInTheDocument();
    expect(screen.getByText(/total 00:06, but review-theme\.flac needs 01:00/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate anyway" })).not.toBeInTheDocument();
    expect(api.updateDraft).not.toHaveBeenCalled();
    expect(api.renderDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Choose more clips" }));
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(screen.getByText("Generate your highlight")).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "Reviewed parts saved" })).toBeInTheDocument();
    expect(api.updateDraft).not.toHaveBeenCalled();
    expect(api.renderDraft).not.toHaveBeenCalled();
  });

  it("keeps approved parts and includes unique saved parts without re-review", async () => {
    const musicProject = {
      ...generationProject,
      files: generationProject.files.map((file, index) => index === 0 ? file : ({
        ...file,
        metadata: {
          ...file.metadata,
          confirmedHighlightMoments: [{ start: 4, end: 10, duration: 6, score: Number(file.metadata?.semanticScore || 80), state: "impact", action: "saved highlight", storyRole: "payoff", source: "human-reviewed", confirmedAt: "2026-06-29T00:00:00.000Z" }]
        }
      })),
      assets: [{
        id: "short-review-music",
        name: "short-review-theme.flac",
        size: 1234,
        type: "audio" as const,
        source: "local-asset" as const,
        url: "/media/uploads/short-review-theme.flac",
        duration: 10
      }]
    } as Project;
    const draft = {
      id: "review-append-draft",
      title: "Review Append Highlight",
      description: "Test generated highlight",
      duration: 30,
      format: "Landscape" as const,
      style: "Trailer",
      accent: "#b9ff66",
      score: 90,
      moments: 5,
      version: 1,
      music: "short-review-theme.flac",
      captionStyle: "Clean",
      intensity: 80,
      changes: [],
      fileIds: generationProject.files.map((file) => file.id),
      segments: [{ fileId: "generation-clip-1", start: 4, duration: 6, score: 90, source: "vision", confidence: "high" as const }]
    };
    vi.mocked(api.getProject).mockResolvedValueOnce(musicProject);
    vi.mocked(api.reconcileProject).mockResolvedValue(musicProject);
    vi.mocked(api.generateDraft).mockResolvedValueOnce(draft);
    vi.mocked(api.confirmHighlightMoment).mockResolvedValue(musicProject);
    vi.mocked(api.updateDraft).mockImplementation(async (_projectId, _draftId, changes) => ({ ...draft, ...changes, version: 2 }));
    vi.mocked(api.renderDraft).mockResolvedValueOnce({
      draft: { ...draft, exportUrl: "/media/exports/review-append.mp4", exportPath: "D:\\exports\\neview-append.mp4", status: "exported" },
      url: "/media/exports/review-append.mp4",
      localPath: "D:\\exports\\neview-append.mp4"
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Saved Folder/i }));
    await screen.findByText("Generation Project");

    fireEvent.change(screen.getByLabelText("Choose music (optional)"), { target: { value: "short-review-music" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => expect(api.generateDraft).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: /Agree, use it/i }));
    await waitFor(() => expect(api.confirmHighlightMoment).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "Generate this reviewed video?" })).toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: "Add more reviewed parts for selected music" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Generate now$/i }));

    await waitFor(() => expect(api.updateDraft).toHaveBeenCalledTimes(1));
    const changes = vi.mocked(api.updateDraft).mock.calls[0][2] as unknown as { segments: Array<{ fileId: string }>; reviewedFileIds: string[] };
    const segmentFileIds = changes.segments.map((segment) => segment.fileId);
    expect(segmentFileIds).toContain("generation-clip-1");
    expect(segmentFileIds.some((id) => id !== "generation-clip-1")).toBe(true);
    expect(new Set(segmentFileIds).size).toBe(segmentFileIds.length);
    expect(changes.reviewedFileIds).toEqual(expect.arrayContaining(segmentFileIds));
    await waitFor(() => expect(api.renderDraft).toHaveBeenCalledTimes(1));
  });

  it("limits saved-part inclusion to the draft file scope instead of the whole library", async () => {
    const scopedProject = {
      ...generationProject,
      id: "scoped-add-more",
      name: "Scoped Add More",
      files: generationProject.files.slice(0, 3).map((file, index) => index === 1 ? ({
        ...file,
        metadata: {
          ...file.metadata,
          confirmedHighlightMoments: [{ start: 4, end: 10, duration: 6, score: Number(file.metadata?.semanticScore || 80), state: "impact", action: "scoped saved highlight", storyRole: "payoff", source: "human-reviewed", confirmedAt: "2026-06-29T00:00:00.000Z" }]
        }
      }) : file),
      assets: [{
        id: "scoped-review-music",
        name: "scoped-review-theme.flac",
        size: 1234,
        type: "audio" as const,
        source: "local-asset" as const,
        url: "/media/uploads/scoped-review-theme.flac",
        duration: 10
      }]
    } as Project;
    const draft = {
      id: "scoped-add-more-draft",
      title: "Scoped Add More Highlight",
      description: "Test generated highlight",
      duration: 30,
      format: "Landscape" as const,
      style: "Trailer",
      accent: "#b9ff66",
      score: 90,
      moments: 1,
      version: 1,
      music: "scoped-review-theme.flac",
      captionStyle: "Clean",
      intensity: 80,
      changes: [],
      fileIds: ["generation-clip-1", "generation-clip-2"],
      segments: [{ fileId: "generation-clip-1", start: 4, duration: 6, score: 90, source: "vision", confidence: "high" as const }]
    };
    vi.mocked(api.listProjects).mockResolvedValueOnce([scopedProject]);
    vi.mocked(api.getProject).mockResolvedValueOnce(scopedProject);
    vi.mocked(api.reconcileProject).mockResolvedValue(scopedProject);
    vi.mocked(api.generateDraft).mockResolvedValueOnce(draft);
    vi.mocked(api.confirmHighlightMoment).mockResolvedValue(scopedProject);
    vi.mocked(api.updateDraft).mockImplementation(async (_projectId, _draftId, changes) => ({ ...draft, ...changes, version: 2 }));
    vi.mocked(api.renderDraft).mockResolvedValueOnce({
      draft: { ...draft, exportUrl: "/media/exports/scoped-add-more.mp4", exportPath: "D:\\exports\\scoped-add-more.mp4", status: "exported" },
      url: "/media/exports/scoped-add-more.mp4",
      localPath: "D:\\exports\\scoped-add-more.mp4"
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Scoped Add More/i }));
    expect((await screen.findAllByText("Scoped Add More")).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Choose music (optional)"), { target: { value: "scoped-review-music" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => expect(api.generateDraft).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: /Agree, use it/i }));
    await waitFor(() => expect(api.confirmHighlightMoment).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "Generate this reviewed video?" })).toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: "Add more reviewed parts for selected music" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Generate now$/i }));

    await waitFor(() => expect(api.updateDraft).toHaveBeenCalledTimes(1));
    const changes = vi.mocked(api.updateDraft).mock.calls[0][2] as unknown as { segments: Array<{ fileId: string }> };
    expect(new Set(changes.segments.map((segment) => segment.fileId))).toEqual(new Set(["generation-clip-1", "generation-clip-2"]));
    expect(changes.segments.map((segment) => segment.fileId)).not.toContain("generation-clip-3");
  });

  it("passes the double-music length option to render", async () => {
    const musicProject = {
      ...generationProject,
      assets: [{
        id: "music-asset",
        name: "battle-theme.flac",
        size: 1234,
        type: "audio" as const,
        source: "local-asset" as const,
        url: "/media/uploads/battle-theme.flac"
      }]
    } as Project;
    const draft = {
      id: "repeat-draft",
      title: "Repeat Music Highlight",
      description: "Test generated highlight",
      duration: 30,
      format: "Landscape" as const,
      style: "Trailer",
      accent: "#b9ff66",
      score: 90,
      moments: 5,
      version: 1,
      music: "battle-theme.flac",
      captionStyle: "Clean",
      intensity: 80,
      changes: [],
      segments: [{ fileId: "generation-clip-1", start: 4, duration: 6, score: 90, source: "vision", confidence: "high" as const }]
    };
    vi.mocked(api.getProject).mockResolvedValueOnce(musicProject);
    vi.mocked(api.reconcileProject).mockResolvedValue(musicProject);
    vi.mocked(api.generateDraft).mockResolvedValueOnce(draft);
    vi.mocked(api.confirmHighlightMoment).mockResolvedValue(musicProject);
    vi.mocked(api.updateDraft).mockImplementation(async (_projectId, _draftId, changes) => ({ ...draft, ...changes, version: 2 }));
    vi.mocked(api.renderDraft).mockResolvedValueOnce({
      draft: { ...draft, exportUrl: "/media/exports/repeat.mp4", exportPath: "D:\\exports\\nepeat.mp4", status: "exported" },
      url: "/media/exports/repeat.mp4",
      localPath: "D:\\exports\\nepeat.mp4"
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Saved Folder/i }));
    await screen.findByText("Generation Project");

    fireEvent.change(screen.getByLabelText("Choose music (optional)"), { target: { value: "music-asset" } });
    fireEvent.change(screen.getByLabelText("Video length"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    fireEvent.click(await screen.findByRole("button", { name: /Agree, use it/i }));
    await waitFor(() => expect(api.confirmHighlightMoment).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "Generate this reviewed video?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Generate now$/i }));
    await waitFor(() => expect(api.updateDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.renderDraft).toHaveBeenCalled());
    expect(vi.mocked(api.renderDraft).mock.calls[0][2]).toBe("music-asset");
    expect(vi.mocked(api.renderDraft).mock.calls[0][5]).toBe(2);
  });
});
