import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { alignTrailerSegmentsToMusic, buildAgenticEditPlan, calibrateHighlightScores, canStartBackgroundJob, createSegments, createTrailerSegments, extendDraftToMusicDuration, loadJson, MAX_DURATION, maxLogoOutroDuration, refineDraftPlan, run, saveJson, scoreCandidateWindow } from "./media.mjs";

const files = [
  {
    id: "long-recording",
    path: "C:\\private\\recording.mp4",
    metadata: { duration: 1200 }
  }
];

describe("server highlight planning", () => {
  it("never starts a paused or cancelled background job", () => {
    expect(canStartBackgroundJob({ status: "processing", cancelRequested: false }, ["processing"])).toBe(true);
    expect(canStartBackgroundJob({ status: "paused", cancelRequested: false }, ["processing"])).toBe(false);
    expect(canStartBackgroundJob({ status: "processing", cancelRequested: true }, ["processing"])).toBe(false);
  });

  it("enforces the hard five-minute maximum", () => {
    const result = createSegments(files, 600, 90);
    expect(result.duration).toBeLessThanOrEqual(MAX_DURATION);
  });

  it("does not expose local source paths in the segment plan", () => {
    const result = createSegments(files, 60, 78);
    expect(result.segments[0]).not.toHaveProperty("source");
  });

  it("builds an escalating trailer from unique ranked clips", () => {
    const ranked = Array.from({ length: 60 }, (_, index) => ({
      id: `clip-${index}`,
      metadata: { duration: 90, actionScore: 100 - index, highlightStart: 74 }
    }));
    const result = createTrailerSegments(ranked, 150);
    expect(result.duration).toBeLessThanOrEqual(MAX_DURATION);
    expect(new Set(result.segments.map((segment) => segment.fileId)).size).toBe(result.segments.length);
    expect(result.segments.at(-1).duration).toBeLessThan(result.segments[0].duration);
  });

  it("prefers AI-preprocessed semantic events when enough indexed footage exists", () => {
    const ranked = Array.from({ length: 12 }, (_, index) => ({
      id: `semantic-${index}`,
      metadata: {
        duration: 90,
        actionScore: 30,
        semanticScore: 85,
        semanticTraits: { subject: index % 2 ? "vehicle" : "character", spectacle: 80, clarity: 90 },
        semanticEvents: [{ start: 20 + index, end: 26 + index, score: 88, state: "impact", action: "combat payoff" }]
      }
    }));
    const result = createTrailerSegments(ranked, 80);
    expect(result.segments[0].start).toBeLessThan(20);
    expect(result.segments[0].start).toBeGreaterThanOrEqual(17.5);
    expect(result.segments[0].duration).toBeGreaterThanOrEqual(5.5);
    expect(result.duration).toBeLessThanOrEqual(MAX_DURATION);
  });

  it("uses sparse AI semantic events first and ignores previous generated exports", () => {
    const ranked = [
      {
        id: "previous-export",
        name: "WARSAW - Battlefield 6 Trailer - Vision Reviewed 1440p.mp4",
        metadata: { duration: 180, actionScore: 999, visionScore: 100, highlightStart: 90 }
      },
      {
        id: "semantic-hit",
        name: "Battlefield 6 2026.05.31 - 22.05.42.03.DVR.mp4",
        metadata: {
          duration: 90,
          actionScore: 30,
          semanticScore: 75,
          semanticEvents: [{ start: 12, end: 17, score: 90, state: "combat", action: "explosion" }]
        }
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `fallback-${index}`,
        name: `Battlefield fallback ${index}.mp4`,
        metadata: { duration: 90, actionScore: 80 - index, visionScore: 80 - index, highlightStart: 70 }
      }))
    ];

    const result = createTrailerSegments(ranked, 60);
    expect(result.segments[0].fileId).toBe("semantic-hit");
    expect(result.segments[0].start).toBeLessThan(12);
    expect(result.segments.some((segment) => segment.fileId === "previous-export")).toBe(false);
    expect(result.duration).toBeLessThanOrEqual(60);
  });

  it("uses reusable fast-index candidate windows before generic fallback", () => {
    const ranked = [
      {
        id: "indexed-payoff",
        name: "gameplay-highlight.mp4",
        metadata: {
          duration: 90,
          actionScore: 10,
          candidateWindows: [{ start: 33, end: 47, duration: 14, score: 94, reason: "audio_peak", sceneChanges: 4, audioPeak: -6, storyRole: "payoff", cutRisk: "high" }]
        }
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `fallback-index-${index}`,
        name: `fallback-index-${index}.mp4`,
        metadata: { duration: 90, actionScore: 80 - index, highlightStart: 60 }
      }))
    ];

    const result = createTrailerSegments(ranked, 45);
    expect(result.segments[0]).toMatchObject({ fileId: "indexed-payoff", start: 33 });
    expect(result.segments[0].duration).toBeGreaterThanOrEqual(12);
  });

  it("builds an audited edit without duplicate intervals or rejected UI states", () => {
    const sources = Array.from({ length: 6 }, (_, index) => ({
      id: `agent-${index}`,
      name: `Gameplay ${index}.mp4`,
      metadata: {
        duration: 90,
        qualityScore: 82,
        indexScore: 78 + index,
        ratingConfidence: "high",
        semanticTags: [index % 2 ? "tank" : "infantry firefight"],
        semanticTraits: { subject: index % 2 ? "vehicle" : "character", action: "explosion" },
        semanticEvents: [
          { start: 25, end: 31, score: 88 + index, state: "impact", action: "vehicle destruction", storyRole: "payoff", cutRisk: "high" },
          { start: 45, end: 50, score: 10, state: "scoreboard", action: "scoreboard" }
        ],
        candidateWindows: [
          { start: 20, end: 34, duration: 14, score: 90, reason: "audio_peak", sceneChanges: 7, audioPeak: -8, storyRole: "payoff", cutRisk: "high" }
        ]
      }
    }));

    const result = buildAgenticEditPlan(sources, 70);
    const intervals = result.segments.map((segment) => `${segment.fileId}:${Math.round(segment.start)}:${Math.round(segment.duration)}`);

    expect(result.segments.length).toBeGreaterThanOrEqual(5);
    expect(new Set(intervals).size).toBe(intervals.length);
    expect(result.workflow.critique.duplicateIntervals).toBe(0);
    expect(result.workflow.critique.payoffMoments).toBeGreaterThan(0);
    expect(result.workflow.rejectedMoments).toBeGreaterThan(0);
  });

  it("does not fill a vision-directed trailer with unverified indexed windows", () => {
    const sources = [
      {
        id: "verified",
        name: "verified.mp4",
        metadata: {
          duration: 90,
          semanticFramesReviewed: 8,
          semanticScore: 91,
          semanticEvents: [{ start: 20, end: 31, score: 91, state: "impact", action: "vehicle destruction", storyRole: "payoff", payoffVerified: true }],
          candidateWindows: [{ start: 50, duration: 14, score: 96, storyRole: "setup" }]
        }
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `miss-${index}`,
        name: `miss-${index}.mp4`,
        metadata: {
          duration: 90,
          semanticFramesReviewed: 8,
          semanticScore: 10,
          semanticEvents: [],
          candidateWindows: [{ start: 30, duration: 14, score: 99, storyRole: "setup" }]
        }
      }))
    ];

    const result = buildAgenticEditPlan(sources, 150, {
      minScore: 64,
      requireVerifiedVision: true,
      qualityFirst: true,
      gameGenre: "military_fps"
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].fileId).toBe("verified");
    expect(result.duration).toBeLessThan(30);
    expect(result.workflow.critique.lowConfidenceMoments).toBe(0);
  });

  it("only exposes stored vision candidates to a configured final reviewer", () => {
    const sources = [{
      id: "candidate",
      name: "candidate.mp4",
      metadata: {
        duration: 90,
        semanticFramesReviewed: 8,
        semanticEvents: [],
        semanticCandidateHistory: [{
          start: 44,
          end: 57,
          score: 88,
          state: "impact",
          action: "vehicle explosion",
          storyRole: "payoff"
        }]
      }
    }];

    expect(buildAgenticEditPlan(sources, 30, {
      requireVerifiedVision: true,
      qualityFirst: true
    }).segments).toHaveLength(0);

    const reviewed = buildAgenticEditPlan(sources, 30, {
      requireVerifiedVision: true,
      allowReviewCandidates: true,
      allowWeakReviewCandidates: true,
      qualityFirst: true
    });
    expect(reviewed.segments).toEqual([
      expect.objectContaining({ fileId: "candidate", start: 44, duration: 13 })
    ]);
  });

  it("keeps weak stored candidates out of strict generation plans", () => {
    const sources = [{
      id: "weak-candidate",
      name: "weak-candidate.mp4",
      metadata: {
        duration: 90,
        semanticFramesReviewed: 12,
        semanticReviewVersion: 2,
        semanticQuality: "weak",
        semanticEvents: [],
        semanticCandidateHistory: [{
          start: 40,
          end: 52,
          score: 90,
          state: "impact",
          action: "possible explosion",
          storyRole: "payoff",
          payoffVerified: false
        }]
      }
    }];

    const result = buildAgenticEditPlan(sources, 30, {
      requireVerifiedVision: true,
      allowReviewCandidates: true,
      qualityFirst: true
    });

    expect(result.segments).toHaveLength(0);
    expect(result.workflow.rejectedMoments).toBeGreaterThan(0);
  });

  it("keeps multiple non-overlapping verified events from one long recording", () => {
    const sources = [{
      id: "multi-event",
      name: "multi-event.mp4",
      metadata: {
        duration: 90,
        ratingConfidence: "high",
        semanticTraits: { subject: "vehicle" },
        semanticEvents: [
          { start: 5, end: 16, score: 92, state: "impact", action: "vehicle explosion", storyRole: "payoff", payoffVerified: true },
          { start: 35, end: 47, score: 94, state: "impact", action: "aircraft destruction", storyRole: "payoff", payoffVerified: true },
          { start: 70, end: 84, score: 96, state: "impact", action: "objective defense", storyRole: "payoff", payoffVerified: true }
        ]
      }
    }];

    const result = buildAgenticEditPlan(sources, 60, {
      requireVerifiedVision: true,
      qualityFirst: true,
      gameGenre: "military_fps"
    });
    const intervals = result.segments.map((segment) => `${segment.fileId}:${segment.start}:${segment.duration}`);

    expect(result.segments).toHaveLength(3);
    expect(new Set(intervals).size).toBe(3);
    expect(result.workflow.critique.duplicateIntervals).toBe(0);
  });

  it("extends verified event windows through delayed visible payoffs", () => {
    const sources = [{
      id: "delayed-payoff",
      name: "delayed-payoff.mp4",
      metadata: {
        duration: 50,
        ratingConfidence: "high",
        semanticTraits: { subject: "vehicle" },
        semanticEvents: [{
          start: 20,
          end: 22,
          impactTime: 26,
          score: 94,
          state: "impact",
          action: "rocket hits aircraft",
          storyRole: "payoff",
          cutRisk: "high",
          payoffVerified: true
        }]
      }
    }];

    const result = buildAgenticEditPlan(sources, 30, {
      requireVerifiedVision: true,
      qualityFirst: true,
      gameGenre: "military_fps"
    });

    expect(result.segments[0].start).toBeLessThanOrEqual(17);
    expect(result.segments[0].duration).toBeGreaterThanOrEqual(14);
    expect(result.segments[0].minDuration).toBeGreaterThanOrEqual(13);
  });

  it("orders selected moments as an editor arc instead of source selection order", () => {
    const sources = [
      {
        id: "climax-first-in-input",
        name: "climax.mp4",
        metadata: {
          duration: 60,
          semanticEvents: [{ start: 22, end: 31, score: 96, state: "impact", action: "final explosion", storyRole: "payoff", payoffVerified: true }]
        }
      },
      {
        id: "setup-second-in-input",
        name: "setup.mp4",
        metadata: {
          duration: 60,
          semanticEvents: [{ start: 12, end: 22, score: 82, state: "setup", action: "approach target", storyRole: "setup", payoffVerified: true }]
        }
      },
      {
        id: "combat-third-in-input",
        name: "combat.mp4",
        metadata: {
          duration: 60,
          semanticEvents: [{ start: 18, end: 27, score: 88, state: "combat", action: "mid fight", storyRole: "combat", payoffVerified: true }]
        }
      }
    ];

    const result = buildAgenticEditPlan(sources, 45, { requireVerifiedVision: true });

    expect(result.segments.map((segment) => segment.fileId)).toEqual([
      "setup-second-in-input",
      "combat-third-in-input",
      "climax-first-in-input"
    ]);
  });

  it("does not let music beat alignment cut protected payoff duration", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "highlightai-music-"));
    const musicPath = path.join(dir, "tone.wav");
    try {
      await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", musicPath]);
      const draft = {
        style: "Trailer",
        duration: 12,
        segments: [{ fileId: "clip", start: 10, duration: 3, minDuration: 7, score: 90 }]
      };

      const aligned = await alignTrailerSegmentsToMusic(draft, musicPath);

      expect(aligned.segments[0].duration).toBeGreaterThanOrEqual(7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps logo ending when usable gameplay is shorter than the soundtrack", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "highlightai-logo-cap-"));
    const musicPath = path.join(dir, "long-tone.wav");
    try {
      await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=40", musicPath]);
      const draft = {
        style: "Trailer",
        duration: 12,
        segments: [{ fileId: "clip", start: 10, duration: 8, minDuration: 6, score: 90 }]
      };

      const aligned = await alignTrailerSegmentsToMusic(draft, musicPath);

      expect(aligned.outroDuration).toBeLessThanOrEqual(maxLogoOutroDuration(40));
      expect(aligned.duration).toBeLessThan(40);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not use weak filler just to match a long soundtrack", () => {
    const sources = Array.from({ length: 20 }, (_, index) => ({
      id: `music-fill-${index}`,
      name: `music-fill-${index}.mp4`,
      metadata: {
        duration: 90,
        actionScore: 95 - index,
        highlightStart: 48 + (index % 5),
        candidateWindows: [{ start: 36 + (index % 4), duration: 11, score: 88 - index * 0.5, storyRole: "payoff" }]
      }
    }));
    const draft = {
      style: "Trailer",
      duration: 54,
      intensity: 78,
      segments: sources.slice(0, 9).map((source, index) => ({
        fileId: source.id,
        start: 45,
        duration: 6,
        minDuration: 4,
        score: 80 - index
      })),
      workflow: { critique: { score: 74 } }
    };
    const musicDuration = 156.4;
    const extended = extendDraftToMusicDuration(draft, sources, musicDuration, {
      maxLogoOutroDuration: maxLogoOutroDuration(musicDuration),
      gameGenre: "military_fps"
    });
    const contentDuration = extended.segments.reduce((sum, segment) => sum + segment.duration, 0);

    expect(contentDuration).toBeLessThan(musicDuration - maxLogoOutroDuration(musicDuration) - 1);
    expect(extended.workflow.musicExtension.addedSegments).toBe(0);
  });

  it("can still use weak music filler when explicitly requested", () => {
    const sources = Array.from({ length: 20 }, (_, index) => ({
      id: `music-fill-${index}`,
      name: `music-fill-${index}.mp4`,
      metadata: {
        duration: 90,
        actionScore: 95 - index,
        highlightStart: 48 + (index % 5),
        candidateWindows: [{ start: 36 + (index % 4), duration: 11, score: 88 - index * 0.5, storyRole: "payoff" }]
      }
    }));
    const draft = {
      style: "Trailer",
      duration: 54,
      intensity: 78,
      segments: sources.slice(0, 9).map((source, index) => ({
        fileId: source.id,
        start: 45,
        duration: 6,
        minDuration: 4,
        score: 80 - index
      })),
      workflow: { critique: { score: 74 } }
    };
    const musicDuration = 156.4;
    const extended = extendDraftToMusicDuration(draft, sources, musicDuration, {
      maxLogoOutroDuration: maxLogoOutroDuration(musicDuration),
      gameGenre: "military_fps",
      allowWeakFill: true
    });
    const contentDuration = extended.segments.reduce((sum, segment) => sum + segment.duration, 0);
    const intervals = extended.segments.map((segment) => `${segment.fileId}:${Math.round(segment.start)}:${Math.round(segment.duration)}`);

    expect(contentDuration).toBeGreaterThanOrEqual(musicDuration - maxLogoOutroDuration(musicDuration) - 1);
    expect(extended.workflow.musicExtension.addedSegments).toBeGreaterThan(0);
    expect(new Set(intervals).size).toBe(intervals.length);
  });

  it("keeps genre-relevant movement eligible outside shooter games", () => {
    const source = [{
      id: "race-pass",
      name: "race.mp4",
      metadata: {
        duration: 60,
        semanticEvents: [{ start: 20, end: 30, score: 90, state: "travel", action: "completed overtake", storyRole: "payoff" }]
      }
    }];

    expect(buildAgenticEditPlan(source, 30, { gameGenre: "racing" }).segments).toHaveLength(1);
    expect(buildAgenticEditPlan(source, 30, { gameGenre: "military_fps" }).segments).toHaveLength(0);
  });

  it("calibrates local highlight scores instead of saturating every clip at 100", () => {
    const clips = [
      { id: "quiet", metadata: { qualityScore: 70, actionScore: 12, candidateWindows: [{ score: 100, audioPeak: -24, sceneChanges: 1, reason: "audio_peak" }] } },
      { id: "medium", metadata: { qualityScore: 80, actionScore: 55, candidateWindows: [{ score: 100, audioPeak: -14, sceneChanges: 5, reason: "audio_peak" }] } },
      { id: "strong", metadata: { qualityScore: 90, actionScore: 140, candidateWindows: [{ score: 100, audioPeak: -8, sceneChanges: 10, reason: "audio_peak" }] } }
    ];

    calibrateHighlightScores(clips);

    expect(clips.map((clip) => clip.metadata.indexScore)).toEqual([38, 67, 95]);
    expect(new Set(clips.map((clip) => clip.metadata.candidateWindows[0].score)).size).toBe(3);
    expect(clips.every((clip) => clip.metadata.ratingSource === "local-signals")).toBe(true);
  });

  it("keeps actual vision scores identified separately from local signals", () => {
    const clips = [
      { id: "vision", metadata: { semanticScore: 87, actionScore: 999, candidateWindows: [] } },
      { id: "local", metadata: { qualityScore: 80, actionScore: 40, candidateWindows: [] } }
    ];

    calibrateHighlightScores(clips);

    expect(clips[0].metadata).toMatchObject({ indexScore: 87, ratingSource: "vision-ai" });
    expect(clips[1].metadata.ratingSource).toBe("local-signals");
  });

  it("does not let a sparse missed vision sample erase strong local evidence", () => {
    const clips = [
      {
        id: "sparse-miss",
        metadata: {
          qualityScore: 90,
          actionScore: 140,
          semanticScore: 1,
          semanticFramesReviewed: 4,
          semanticEvents: [],
          candidateWindows: [{ score: 100, audioPeak: -8, sceneChanges: 10, reason: "audio_peak" }]
        }
      },
      {
        id: "quiet",
        metadata: {
          qualityScore: 70,
          actionScore: 12,
          candidateWindows: [{ score: 100, audioPeak: -24, sceneChanges: 1, reason: "audio_peak" }]
        }
      }
    ];

    calibrateHighlightScores(clips);

    expect(clips[0].metadata.indexScore).toBeGreaterThan(60);
    expect(clips[0].metadata).toMatchObject({ ratingSource: "vision-ai-assisted", ratingConfidence: "low" });
    expect(clips[1].metadata.ratingSource).toBe("local-signals");
  });

  it("replans and invalidates an exported draft when it is refined", () => {
    const source = Array.from({ length: 6 }, (_, index) => ({
      id: `source-${index}`,
      metadata: { duration: 90, actionScore: 80 - index, highlightStart: 60 }
    }));
    const draft = {
      id: "draft",
      style: "Action",
      duration: 60,
      intensity: 70,
      version: 2,
      changes: [],
      segments: [],
      exportUrl: "/media/exports/old.mp4",
      exportPath: "C:\\exports\\old.mp4",
      status: "exported"
    };

    const refined = refineDraftPlan(draft, source, { instruction: "Shorter and more action" });

    expect(refined.version).toBe(3);
    expect(refined.duration).toBeLessThan(60);
    expect(refined.intensity).toBe(80);
    expect(refined.segments.length).toBeGreaterThan(0);
    expect(refined).not.toHaveProperty("exportUrl");
    expect(refined).not.toHaveProperty("exportPath");
    expect(refined.status).toBe("ready");
  });

  it("scores candidate windows across a useful range", () => {
    expect(scoreCandidateWindow({ audioPeak: -28, sceneChanges: 1, reason: "audio_peak" }, 10)).toBeLessThan(
      scoreCandidateWindow({ audioPeak: -8, sceneChanges: 10, reason: "audio_peak" }, 140)
    );
  });

  it("keeps JSON readable during concurrent saves", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "highlightai-json-"));
    const file = path.join(folder, "project.json");
    try {
      await Promise.all(Array.from({ length: 20 }, (_, index) => saveJson(file, { index, payload: "x".repeat(1000) })));
      const result = await loadJson(file);
      expect(result.payload).toHaveLength(1000);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(result);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("snapshots queued JSON state instead of persisting later mutations", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "highlightai-json-snapshot-"));
    const file = path.join(folder, "job.json");
    try {
      const job = { status: "processing", progress: 10 };
      const pending = saveJson(file, job);
      job.status = "paused";
      job.progress = 11;
      await pending;

      expect(await loadJson(file)).toEqual({ status: "processing", progress: 10 });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
