# Video Generation Workflow

This document distinguishes HighlightAI's current implementation from the workflow required for reliable, exciting edits.

## Current Workflow

1. **Link or copy footage**
   - Desktop folder selection links local files in place.
   - Browser uploads copy files one at a time into the local workspace.

2. **Technical and action-signal analysis**
   - FFprobe reads codec, resolution, duration, frame rate, and audio availability.
   - FFmpeg analyzes one short window near the end of each recording.
   - Scene-change density and audio loudness produce one action score and one preferred timestamp per file.
   - Large folders are processed by a small background worker pool.
   - The ingest job reports ETA, worker count, active files, skipped files, and recoverable failures.
   - After import, the app starts a reusable fast-index job in the background.

3. **Reusable fast candidate index**
   - FFmpeg scans low-resolution proxy signals across the imported folder.
   - The job stores candidate story windows on each recording: start, end, score, scene-change count, audio peak, story role, and cut risk.
   - The job also stores a short per-video description, tags, index score, and recommendation flag for the video library.
   - The index is saved in the local project database, so future drafts can reuse it instantly.
   - This is the default under-10-minute path. It avoids asking a slow vision model to inspect every frame.

4. **Optional AI frame review**
   - The user explicitly starts frame review and configures an OpenAI-compatible multimodal model.
   - The app currently reviews one JPEG from at most 24 high-action candidate files.
   - It records generic traits: subject, shot scale, environment, intensity, spectacle, clarity, and obstruction.
   - It can reject obvious menus, maps, death states, and unreadable frames only when they appear in the sampled JPEG.

5. **Optional AI folder preprocessing**
   - The app estimates frame count, local frame-cache size, worker count, and time before the user starts.
   - For large folders, the first pass shortlists likely candidates so the model does not spend hours rating obvious low-value footage.
   - A durable background job samples frames every few seconds, caches JPEGs locally, and sends them to the configured vision model.
   - The vision model is the primary rating judge for sampled footage. FFmpeg only supplies cheap technical sampling signals.
   - The model returns trailer usefulness, excitement, visual quality, novelty, boredom, exclusion reason, payoff stage, story role, context-needed-before, context-needed-after, and cut-risk.
   - The reviewer prompt frames the model as a professional trailer director and explicitly rejects map checks, scoreboards, walking, waiting, weak aim, empty vehicle traversal, and cuts that miss the payoff.
   - The job reports reviewed frames, approved frames, rejected frames, active file, ETA, failures, and cancellation state.
   - It stores compact per-file AI ratings and semantic events for later draft planning.
   - API keys are kept in process memory for the active job and are not written to job JSON.

6. **Draft planning**
   - Users select 5 to 20 videos from the indexed library before creating a trailer.
   - The app recommends a focused subset based on index score, semantic score, and action score.
   - Trailer duration is adaptive; the AI/planner chooses the length from selected content instead of always forcing 5 minutes.
   - Trailer mode starts from AI-rated semantic events whenever they exist.
   - If semantic events are sparse, trailer mode uses stored fast-index candidate windows before generic fallback.
   - Semantic events preserve a longer mini-story window around setup, anticipation, payoff, and reaction instead of using only a tiny 4-second slice.
   - Fallback clips are longer than before, but they are still less reliable than AI-indexed semantic events.
   - AI-rated footage is ranked by the vision model's semantic score, not by filename, codec quality, or FFmpeg loudness.
   - A heuristic sequencer tries to increase intensity and vary generic visual traits.
   - Similarity is trait-based, not based on visual embeddings or complete event understanding.
   - The user's natural-language request currently influences advice and labels more than actual timeline constraints.

7. **Music alignment**
   - FFmpeg detects simple audio-energy peaks.
   - Existing segment durations are adjusted toward nearby peaks.
   - The planner does not understand musical sections, downbeats, drops, phrases, or emotional changes.

8. **Render**
   - Segments are hard-cut together and color-treated.
   - Trailer mode renders at 2560x1440 with high-quality H.264 settings.
   - Music is mixed as the primary track with a low game-audio bed.
   - Trailer mode starts on gameplay footage. Static black title cards are avoided unless replaced by a dynamic footage-based title treatment.

9. **Optional AI review team**
   - After rendering, the app can sample the exported MP4 into a contact sheet.
   - One director reviewer plus three audience personas score the finished draft on a 100-point scale.
   - Average score >= 90 means the draft is approved.
   - Under 90 returns a revision plan that can drive the next edit pass.

## Why The Current Workflow Fails

- A scoreboard can appear after the single reviewed frame if full folder preprocessing has not indexed that source.
- A loud but boring movement can still score highly in the fast index if the optional VLM review has not reviewed that candidate.
- Clips can still cut before an impact if the folder has not been indexed deeply enough to find the complete event boundaries.
- Similar scenes repeat because there are no visual embeddings or sequence-level duplicate checks.
- Energy-peak alignment is not real beat or phrase synchronization.
- Complete-video review is now available as an explicit AI review-team step, but automatic re-edit loops are still future work.

## Target Workflow

### 1. Durable Full-Video Semantic Index

- Create low-resolution proxy video for every recording.
- Detect shot boundaries and sample continuously at a configurable rate.
- Use adaptive sampling:
  - low rate during static footage;
  - high rate around motion, audio spikes, scene changes, and detected actions.
- Process samples in resumable batches through a local Ollama vision model.
- Store results by timestamp so interrupted analysis resumes without repeating completed work.

### 2. Event Understanding

The vision model should identify event states across multiple frames:

- setup;
- anticipation or aiming;
- action;
- impact or payoff;
- reaction or result;
- recovery.

An event clip must preserve the complete payoff. The editor must not cut after setup but before impact.

### 3. Quality and Exclusion Detection

Detect and exclude timeline ranges containing:

- menus, scoreboards, tactical maps, loading screens, and overlays;
- death, respawn, or low-readability damage states;
- long traversal with no meaningful action;
- extreme motion blur, darkness, obstruction, or repeated frames.

### 4. Semantic Search and Deduplication

- Create visual and text embeddings for every event.
- Group near-duplicates and repeated action patterns.
- Limit repeated subjects, environments, camera perspectives, and event types.
- Let users search naturally, such as:
  - "RPG hits a helicopter";
  - "large destruction moments";
  - "funny squad failures";
  - "only clean sniper eliminations."

### 5. Reference-Style Planning

- Analyze user-provided reference videos or a written style request.
- Convert the user's natural-language request into explicit timeline constraints, required event types, exclusions, pacing, format, and duration.
- Extract pacing, shot-length distribution, visual traits, title-card use, and transition frequency.
- Create a story plan before editing:
  - hook;
  - setup;
  - escalation;
  - climax;
  - resolution.
- Show the planned events and reasons before rendering.

### 6. Music Understanding

- Analyze downbeats, tempo, musical sections, drops, quiet passages, and ending cadence.
- Match complete events to musical phrases.
- Place impacts and reveals on strong beats without cutting event payoffs.
- Prefer changing clip speed slightly or moving the cut rather than truncating the action.

### 7. AI Rough-Cut Review

Before final rendering, the system should render a low-resolution rough cut and review it:

- verify every selected event has a payoff;
- detect boring or repeated sections;
- detect menus, scoreboards, and unreadable frames anywhere in the cut;
- score music synchronization and narrative escalation;
- revise the timeline automatically, then show the user what changed.

Current implementation has the scoring/revision-plan part of this loop. Automatic timeline rewriting from review feedback still needs to be implemented.

## Required Architecture

- `fast-candidate-index` job: low-resolution proxy scanning, audio/motion/scene candidate windows, ETA, cancellation, and local database persistence.
- `semantic-index` job: resumable proxy generation, shot detection, and timestamped vision batches.
- `events` store: event boundaries, descriptions, traits, exclusions, and embeddings.
- `music-analysis` job: beat grid, sections, intensity curve, and phrase boundaries.
- `timeline-planner`: constraint-based event selection and sequencing.
- `rough-cut-review` job: complete-output multimodal review and automatic revision.
- UI inspector: users can inspect every selected event, rejection reason, music cue, and AI decision.

## AI Rating Workflow

1. FFmpeg/ffprobe only produce cheap facts: duration, codec, scene-change hints, audio energy, and candidate timestamps.
2. The fast index converts those facts into reusable candidate windows and stores them in the project database.
3. The app uses the candidate database to decide what the vision model should inspect first.
4. The vision model rates sampled frames and events with trailer usefulness, excitement, quality, novelty, boredom, exclusion reason, payoff state, story role, and context window.
5. Draft planning must prefer AI-rated semantic events whenever they exist.
6. Draft planning should preserve full mini-story arcs around payoffs.
7. If the first shortlist is weak, the app broadens the candidate set instead of falling back to FFmpeg as the judge.
8. After render, the review team scores the draft; under 90/100 should trigger another edit pass.

## Model Policy

- The app should not silently bundle a multi-gigabyte model.
- Local Ollama is the default recommendation for private full-video analysis.
- Recommended local quality model: `qwen2.5vl:7b`.
- Lower-VRAM fallback: `qwen2.5vl:3b`.
- A vision-capable model is required; text-only models cannot review gameplay frames.
- The UI must show which frames are processed, where they are sent, progress, estimated time, and how to stop or resume.
