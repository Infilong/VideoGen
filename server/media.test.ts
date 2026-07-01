import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { alignTrailerSegmentsToMusic, applyVisualReviewEditsToDraft, buildAgenticEditPlan, calibrateHighlightScores, canStartBackgroundJob, createSegments, createTrailerSegments, extendDraftToMusicDuration, fitTimelineToDuration, loadJson, MAX_DURATION, maxLogoOutroDuration, polishFinalTimeline, probe, recommendTrailerDuration, refineDraftPlan, renderHighlight, run, saveJson, scoreCandidateWindow } from "./media.mjs";

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

  it("enforces the hard three-minute maximum", () => {
    const result = createSegments(files, 600, 90);
    expect(result.duration).toBeLessThanOrEqual(MAX_DURATION);
  });

  it("does not expose local source paths in the segment plan", () => {
    const result = createSegments(files, 60, 78);
    expect(result.segments[0]).not.toHaveProperty("source");
  });

  it("excludes AI-rejected low-signal clips from fallback and editor plans", () => {
    const ranked = [
      {
        id: "boring-local-winner",
        name: "boring.mp4",
        metadata: {
          duration: 90,
          actionScore: 999,
          indexScore: 95,
          highlightStart: 40,
          aiDecision: "rejected",
          indexDescription: "Rejected by AI: no clear payoff",
          recommendedForDraft: false,
          candidateWindows: [{ start: 32, end: 46, duration: 14, score: 95, reason: "audio_peak" }]
        }
      },
      {
        id: "usable-highlight",
        name: "highlight.mp4",
        metadata: {
          duration: 90,
          actionScore: 80,
          indexScore: 82,
          highlightStart: 52,
          candidateWindows: [{ start: 48, end: 62, duration: 14, score: 82, reason: "scene_change" }]
        }
      }
    ];

    expect(createSegments(ranked, 30, 90).segments.map((segment) => segment.fileId)).not.toContain("boring-local-winner");
    expect(buildAgenticEditPlan(ranked, 30, { allowReviewCandidates: true, allowIndexedAfterUncertainVision: true }).segments.map((segment) => segment.fileId)).not.toContain("boring-local-winner");
  });

  it("allows a user-overridden AI rejection to be used for generation", () => {
    const ranked = [
      {
        id: "battlefield-false-red-flag",
        name: "Battlefield 6 2026.01.02 - 22.49.15.33.DVR.mp4",
        metadata: {
          duration: 120,
          actionScore: 94,
          indexScore: 91,
          highlightStart: 48,
          aiDecision: "rejected",
          aiDecisionOverride: "include",
          indexDescription: "AI red flag overridden by user",
          candidateWindows: [{ start: 44, end: 62, duration: 18, score: 91, reason: "user_override" }]
        }
      }
    ];

    expect(createSegments(ranked, 30, 90).segments.map((segment) => segment.fileId)).toContain("battlefield-false-red-flag");
    expect(buildAgenticEditPlan(ranked, 30, { allowReviewCandidates: true, allowIndexedAfterUncertainVision: true }).segments.map((segment) => segment.fileId)).toContain("battlefield-false-red-flag");
  });

  it("keeps old AI-rejected text usable when the decision is only low confidence", () => {
    const ranked = [
      {
        id: "false-rejected-highlight",
        name: "scope-highlight.mp4",
        metadata: {
          duration: 90,
          actionScore: 999,
          indexScore: 95,
          highlightStart: 40,
          aiDecision: "low_confidence",
          indexDescription: "Rejected by AI: no clear payoff",
          recommendedForDraft: false,
          candidateWindows: [{ start: 32, end: 46, duration: 14, score: 95, reason: "audio_peak" }]
        }
      },
      {
        id: "weaker-highlight",
        name: "weaker.mp4",
        metadata: {
          duration: 90,
          actionScore: 80,
          indexScore: 82,
          highlightStart: 52,
          candidateWindows: [{ start: 48, end: 62, duration: 14, score: 82, reason: "scene_change" }]
        }
      }
    ];

    expect(createSegments(ranked, 30, 90).segments.map((segment) => segment.fileId)).toContain("false-rejected-highlight");
    expect(buildAgenticEditPlan(ranked, 30, { allowReviewCandidates: true, allowIndexedAfterUncertainVision: true }).segments.map((segment) => segment.fileId)).toContain("false-rejected-highlight");
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

  it("prioritizes human-confirmed highlight moments before other candidates", () => {
    const result = buildAgenticEditPlan([
      {
        id: "confirmed",
        name: "confirmed.mp4",
        metadata: {
          duration: 90,
          qualityScore: 80,
          indexScore: 60,
          semanticScore: 10,
          confirmedHighlightMoments: [{ start: 41.2, end: 52.7, duration: 11.5, score: 72, action: "tank kill", storyRole: "payoff", confirmedAt: "2026-06-28T00:00:00.000Z" }],
          candidateWindows: [{ start: 10, end: 20, duration: 10, score: 99, reason: "audio_peak", sceneChanges: 7, audioPeak: -8, storyRole: "setup", cutRisk: "high" }]
        }
      },
      {
        id: "indexed",
        name: "indexed.mp4",
        metadata: {
          duration: 90,
          qualityScore: 80,
          indexScore: 95,
          candidateWindows: [{ start: 22, end: 34, duration: 12, score: 96, reason: "scene_change", sceneChanges: 8, audioPeak: -9, storyRole: "payoff", cutRisk: "high" }]
        }
      }
    ], 45, { requireVerifiedVision: true, qualityFirst: true });

    expect(result.segments[0]).toMatchObject({ fileId: "confirmed", source: "human-confirmed" });
    expect(result.segments[0].start).toBe(41.2);
  });

  it("excludes user-rejected highlight moments from generation candidates", () => {
    const result = buildAgenticEditPlan([
      {
        id: "rejected",
        name: "rejected.mp4",
        metadata: {
          duration: 90,
          qualityScore: 90,
          indexScore: 96,
          rejectedHighlightMoments: [{ start: 20, end: 34, duration: 14, reason: "not-highlight", source: "index", rejectedAt: "2026-06-28T00:00:00.000Z" }],
          candidateWindows: [{ start: 22, end: 32, duration: 10, score: 99, reason: "audio_peak", sceneChanges: 8, audioPeak: -6, storyRole: "payoff", cutRisk: "high" }]
        }
      }
    ], 30, { requireVerifiedVision: false });

    expect(result.segments).toHaveLength(0);
    expect(result.workflow.rejectedMoments).toBeGreaterThan(0);
  });

  it("recommends a near-three-minute trailer when many long recordings have short verified payoffs", () => {
    const sources = Array.from({ length: 8 }, (_, index) => ({
      id: `verified-long-${index}`,
      name: `verified-long-${index}.mp4`,
      metadata: {
        duration: 150,
        semanticQuality: "verified",
        semanticScore: 90 - index,
        semanticEvents: [{ start: 45, end: 52, score: 92 - index, state: "impact", action: "vehicle destruction", storyRole: "payoff", payoffVerified: true }]
      }
    }));

    expect(recommendTrailerDuration(sources, 0)).toBe(180);
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

  it("auto-ranks strong uncertain stored candidates when relaxed generation is allowed", () => {
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
      allowWeakReviewCandidates: true,
      qualityFirst: true
    });

    expect(result.segments).toEqual([
      expect.objectContaining({ fileId: "weak-candidate", source: "vision-candidate", confidence: "medium" })
    ]);
  });

  it("keeps low-score uncertain candidates out of relaxed auto-rank plans", () => {
    const sources = [{
      id: "low-candidate",
      name: "low-candidate.mp4",
      metadata: {
        duration: 90,
        semanticFramesReviewed: 12,
        semanticReviewVersion: 2,
        semanticQuality: "weak",
        semanticEvents: [],
        semanticCandidateHistory: [{
          start: 40,
          end: 52,
          score: 45,
          state: "aim",
          action: "possible action",
          storyRole: "setup",
          payoffVerified: false
        }]
      }
    }];

    const result = buildAgenticEditPlan(sources, 30, {
      requireVerifiedVision: true,
      allowReviewCandidates: true,
      allowWeakReviewCandidates: true,
      reviewCandidateMinScore: 64,
      qualityFirst: false
    });

    expect(result.segments).toHaveLength(0);
    expect(result.workflow.rejectedMoments).toBeGreaterThan(0);
  });

  it("uses strong semantic summaries when exact candidate windows are missing", () => {
    const sources = [{
      id: "summary-candidate",
      name: "summary-candidate.mp4",
      metadata: {
        duration: 90,
        highlightStart: 54,
        indexScore: 42,
        semanticFramesReviewed: 12,
        semanticReviewVersion: 2,
        semanticScore: 77,
        semanticQuality: "weak",
        semanticRating: {
          trailerUsefulness: 90,
          excitement: 85,
          visualQuality: 92,
          novelty: 80,
          boredom: 10,
          payoffStage: "impact",
          excludeReason: "none"
        },
        semanticTraits: {
          subject: "vehicle",
          action: "explosion and destruction",
          intensity: 90,
          spectacle: 85,
          clarity: 95,
          obstruction: 10,
          payoffExpected: true,
          payoffVerified: true
        },
        semanticEvents: [],
        semanticCandidateHistory: [],
        candidateWindows: []
      }
    }];

    const result = buildAgenticEditPlan(sources, 30, {
      requireVerifiedVision: true,
      allowReviewCandidates: true,
      allowWeakReviewCandidates: true,
      allowSemanticSummaryCandidates: true,
      qualityFirst: false
    });

    expect(result.segments).toEqual([
      expect.objectContaining({ fileId: "summary-candidate", source: "vision-summary", confidence: "high" })
    ]);
  });

  it("uses local highlight timing when a low-confidence Vision pass picked the wrong frame", () => {
    const sources = [{
      id: "short-payoff",
      name: "short-payoff.mp4",
      metadata: {
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
        semanticRating: {
          trailerUsefulness: 10,
          excitement: 5,
          visualQuality: 8,
          novelty: 2,
          boredom: 7,
          payoffStage: "none",
          excludeReason: "travel"
        },
        semanticTraits: { subject: "vehicle", action: "traveling" },
        semanticEvents: [],
        semanticCandidateHistory: [],
        candidateWindows: []
      }
    }];

    const result = buildAgenticEditPlan(sources, 30, {
      allowReviewCandidates: true,
      allowWeakReviewCandidates: true,
      qualityFirst: false
    });

    expect(result.segments[0]).toMatchObject({ fileId: "short-payoff", source: "local-signal" });
    expect(result.segments[0].start).toBeGreaterThanOrEqual(55);
    expect(result.segments[0].start).toBeLessThan(58);
  });

  it("polishes sustained local signals into a longer final event envelope", () => {
    const sources = [{
      id: "sustained-payoff",
      name: "Battlefield 6 2026.06.14 - 00.20.26.13.DVR.mp4",
      metadata: {
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
        semanticRating: {
          trailerUsefulness: 10,
          excitement: 5,
          visualQuality: 8,
          novelty: 2,
          boredom: 90,
          payoffStage: "none",
          excludeReason: "boring_travel"
        },
        semanticTraits: { subject: "vehicle", action: "traveling" },
        semanticEvents: [],
        semanticCandidateHistory: [],
        candidateWindows: []
      }
    }];

    const result = buildAgenticEditPlan(sources, 45, {
      allowReviewCandidates: true,
      allowWeakReviewCandidates: true,
      qualityFirst: false
    });

    expect(result.segments[0]).toMatchObject({ fileId: "sustained-payoff", source: "local-signal" });
    expect(result.segments[0].start).toBe(60);
    expect(result.segments[0].duration).toBeCloseTo(24, 1);
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

  it("can align a trailer to two soundtrack plays up to the three-minute cap", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "highlightai-repeat-music-"));
    const musicPath = path.join(dir, "repeat-tone.wav");
    try {
      await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", musicPath]);
      const draft = {
        style: "Trailer",
        duration: 18,
        musicRepeats: 2,
        segments: [
          { fileId: "a", start: 0, duration: 7, minDuration: 5, score: 90 },
          { fileId: "b", start: 0, duration: 7, minDuration: 5, score: 88 },
          { fileId: "c", start: 0, duration: 7, minDuration: 5, score: 86 }
        ]
      };

      const aligned = await alignTrailerSegmentsToMusic(draft, musicPath);

      expect(aligned.musicPlan.repeats).toBe(2);
      expect(aligned.duration).toBeGreaterThan(12);
      expect(aligned.duration).toBeLessThanOrEqual(24);
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

  it("applies final visual review trims and removes rejected segments before render", () => {
    const draft = {
      segments: [
        { fileId: "a", start: 10, duration: 12, minDuration: 6, score: 90 },
        { fileId: "b", start: 30, duration: 8, minDuration: 4, score: 82 }
      ],
      workflow: { rejectedMoments: 1, selectedMoments: 2, visualReview: { score: 72 } }
    };

    const revised = applyVisualReviewEditsToDraft(draft, {
      score: 88,
      approved: false,
      rejectSegmentIndexes: [2],
      trimSegmentEdits: [{ segmentIndex: 1, start: 12.5, end: 19.25, reason: "walking lead-in and death tail" }]
    });

    expect(revised.segments).toHaveLength(1);
    expect(revised.segments[0]).toMatchObject({ fileId: "a", start: 12.5, duration: 6.75 });
    expect(revised.duration).toBe(6.8);
    expect(revised.workflow.selectedMoments).toBe(1);
    expect(revised.workflow.rejectedMoments).toBe(2);
    expect(revised.workflow.visualReview).toMatchObject({ trimmedSegments: 1, rejectedByTrim: 0 });
  });

  it("polishes a weak final review timeline by trimming around the payoff and replacing removed shots", () => {
    const sources = [
      {
        id: "payoff",
        name: "payoff.mp4",
        metadata: {
          duration: 90,
          qualityScore: 88,
          indexScore: 92,
          highlightStart: 60,
          semanticEvents: [{ start: 58, end: 61, impactTime: 60, score: 94, state: "impact", action: "vehicle destroyed", storyRole: "payoff", payoffVerified: true }]
        }
      },
      {
        id: "replacement",
        name: "replacement.mp4",
        metadata: {
          duration: 90,
          qualityScore: 86,
          indexScore: 90,
          semanticTraits: { subject: "vehicle", action: "explosion" },
          candidateWindows: [{ start: 32, end: 45, duration: 13, score: 91, reason: "audio_peak", storyRole: "payoff", cutRisk: "high" }]
        }
      }
    ];
    const visuallyRevised = applyVisualReviewEditsToDraft({
      style: "Trailer",
      duration: 24,
      segments: [
        { fileId: "payoff", start: 52, duration: 16, minDuration: 5, score: 94, storyRole: "payoff" },
        { fileId: "missing", start: 10, duration: 8, minDuration: 4, score: 40 }
      ],
      workflow: { rejectedMoments: 0, selectedMoments: 2 }
    }, {
      score: 50,
      approved: false,
      rejectSegmentIndexes: [2],
      problems: ["Shot 2 was weak."]
    });

    const polished = polishFinalTimeline(visuallyRevised, sources, 24, { gameGenre: "military_fps" });

    expect(polished.segments.map((segment) => segment.fileId)).toContain("payoff");
    expect(polished.segments.map((segment) => segment.fileId)).toContain("replacement");
    expect(polished.segments.find((segment) => segment.fileId === "payoff")).toMatchObject({ start: 57.5 });
    expect(polished.workflow.finalPolish).toMatchObject({ enabled: true, trimmedSegments: 1, replacementSegments: 1 });
    expect(polished.workflow.status).toBe("final-polished");
  });

  it("can rebuild a renderable final timeline after visual review removes every proposed shot", () => {
    const sources = Array.from({ length: 4 }, (_, index) => ({
      id: `source-${index}`,
      name: `source-${index}.mp4`,
      metadata: {
        duration: 90,
        qualityScore: 84,
        indexScore: 88 - index,
        semanticTraits: { subject: index % 2 ? "vehicle" : "infantry", action: index % 2 ? "explosion" : "sniper shot" },
        candidateWindows: [{ start: 20 + index * 5, end: 33 + index * 5, duration: 13, score: 90 - index, reason: "scene_change", storyRole: index % 2 ? "impact" : "payoff", cutRisk: "high" }]
      }
    }));

    const polished = polishFinalTimeline({
      style: "Trailer",
      duration: 32,
      segments: [],
      workflow: { rejectedMoments: 4, selectedMoments: 0, visualReview: { approved: false, score: 10 } }
    }, sources, 32, { gameGenre: "military_fps" });

    expect(polished.segments.length).toBeGreaterThan(0);
    expect(polished.workflow.finalPolish.replacementSegments).toBeGreaterThan(0);
    expect(polished.workflow.status).toBe("final-polished");
  });

  it("does not extend reviewed cuts into unreviewed tails when matching music", () => {
    const sources = [{
      id: "source",
      name: "source.mp4",
      metadata: {
        duration: 90,
        qualityScore: 80,
        semanticScore: 90,
        semanticEvents: [{ start: 10, end: 17, score: 90, state: "impact", action: "vehicle destroyed", storyRole: "payoff", payoffVerified: true }]
      }
    }];
    const draft = {
      id: "draft",
      style: "Trailer",
      duration: 7,
      segments: [{ fileId: "source", start: 10, duration: 7, minDuration: 7, score: 90 }],
      workflow: { critique: { score: 90 } }
    };

    const unlocked = extendDraftToMusicDuration(draft, sources, 20, { maxLogoOutroDuration: 4 });
    const locked = extendDraftToMusicDuration(draft, sources, 20, { maxLogoOutroDuration: 4, lockReviewedCuts: true });
    const lockedExisting = extendDraftToMusicDuration(draft, sources, 20, { maxLogoOutroDuration: 4, lockExistingCuts: true });

    expect(unlocked.segments[0].duration).toBeGreaterThan(7);
    expect(locked.segments[0].duration).toBe(7);
    expect(locked.segments).toHaveLength(1);
    expect(locked.workflow.musicExtension).toMatchObject({ addedSegments: 0, lockedReviewedCuts: true });
    expect(lockedExisting.segments[0].duration).toBe(7);
    expect(lockedExisting.workflow.musicExtension).toMatchObject({ lockExistingCuts: true });
  });

  it("fits reviewed timelines to the soundtrack budget instead of concatenating every picked clip", () => {
    const draft = {
      style: "Trailer",
      duration: 30,
      segments: [
        { fileId: "a", start: 0, duration: 8, minDuration: 4, score: 90, storyRole: "payoff", confidence: "high" },
        { fileId: "b", start: 0, duration: 8, minDuration: 4, score: 76, storyRole: "setup", confidence: "medium" },
        { fileId: "c", start: 0, duration: 8, minDuration: 4, score: 88, storyRole: "impact", confidence: "high" },
        { fileId: "a", start: 40, duration: 8, minDuration: 4, score: 64, storyRole: "setup", confidence: "low" },
        { fileId: "d", start: 0, duration: 8, minDuration: 4, score: 60, storyRole: "setup", confidence: "low" }
      ],
      workflow: { status: "user-reviewed", selectedMoments: 4 }
    };

    const fitted = fitTimelineToDuration(draft, 14, { mode: "reviewed-music-fit" });
    const duration = fitted.segments.reduce((sum, segment) => sum + segment.duration, 0);
    const sourceIds = fitted.segments.map((segment) => segment.fileId);

    expect(duration).toBeLessThanOrEqual(14);
    expect(fitted.segments.length).toBeLessThan(draft.segments.length);
    expect(sourceIds).toEqual(expect.arrayContaining(["a", "c"]));
    expect(new Set(sourceIds).size).toBe(sourceIds.length);
    expect(fitted.workflow.timelineFit).toMatchObject({ mode: "reviewed-music-fit", removedSegments: 3, duplicateSourcesRemoved: 1 });
  });

  it("removes duplicate reviewed source videos even when the timeline already fits the music", () => {
    const fitted = fitTimelineToDuration({
      style: "Trailer",
      duration: 20,
      segments: [
        { fileId: "same", start: 0, duration: 5, score: 70, storyRole: "setup", confidence: "medium" },
        { fileId: "same", start: 30, duration: 5, score: 94, storyRole: "payoff", confidence: "high" },
        { fileId: "other", start: 10, duration: 5, score: 86, storyRole: "impact", confidence: "high" }
      ],
      workflow: { status: "user-reviewed", selectedMoments: 3 }
    }, 20, { mode: "reviewed-music-fit" });

    expect(fitted.segments.map((segment) => segment.fileId)).toEqual(expect.arrayContaining(["same", "other"]));
    expect(fitted.segments.filter((segment) => segment.fileId === "same")).toHaveLength(1);
    expect(fitted.segments.find((segment) => segment.fileId === "same")).toMatchObject({ start: 30, score: 94 });
    expect(fitted.workflow.timelineFit).toMatchObject({ duplicateSourcesRemoved: 1, removedSegments: 1 });
  });

  it("caps the rendered MP4 to available soundtrack duration when a draft is too long", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "highlightai-music-cap-"));
    const sourcePath = path.join(dir, "source.mp4");
    const musicPath = path.join(dir, "music.wav");
    const outputPath = path.join(dir, "out.mp4");
    try {
      await run("ffmpeg", [
        "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=8",
        "-f", "lavfi", "-i", "sine=frequency=660:duration=8",
        "-shortest",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        sourcePath
      ]);
      await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", musicPath]);
      const draft = {
        id: "draft",
        style: "Trailer",
        duration: 8,
        musicDuration: 3,
        musicRepeats: 1,
        segments: [{ fileId: "source", start: 0, duration: 8, minDuration: 4, score: 90 }]
      };

      await renderHighlight({
        project: {
          id: "project",
          name: "Project",
          files: [{ id: "source", path: sourcePath, metadata: { duration: 8, hasAudio: true } }],
          assets: []
        },
        draft,
        outputPath,
        workRoot: dir,
        musicPath
      });
      const output = await probe(outputPath);
      const volume = async (args) => {
        const { stderr } = await run("ffmpeg", ["-hide_banner", ...args, "-i", outputPath, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
        return Number(stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/)?.[1] || 0);
      };
      const middleVolume = await volume(["-ss", "1.2", "-t", "0.35"]);
      const endingVolume = await volume(["-sseof", "-0.35"]);

      expect(output.duration).toBeLessThanOrEqual(3.35);
      expect(draft.duration).toBe(3);
      expect(endingVolume).toBeLessThan(middleVolume - 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);

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
