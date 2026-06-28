# Modern Software Checklist

This checklist defines the user-facing reliability bar for HighlightAI. The product supports highlight videos up to three minutes.

## Implemented

- [x] Preflight review shows selected video count, total size, local processing behavior, and a disk-space warning.
- [x] Large folders use durable per-file copy jobs instead of one opaque request.
- [x] The desktop app can analyze large local folders in place without duplicating the source files.
- [x] Progress distinguishes copying from FFmpeg verification and shows the current filename, bytes, and counts.
- [x] Large-folder ingest shows estimated remaining time, active files, and background worker count.
- [x] Cancellation is explicit and source recordings are never modified.
- [x] One unreadable video does not discard the rest of a successful batch.
- [x] Import state is persisted after every copied and verified file.
- [x] Errors explain what happened, what was preserved, and what the user can do next.
- [x] Built-in versus optional AI capabilities are disclosed without implying the app watched video frames.
- [x] Trailer planning ignores filenames and ranks footage using scene density, audio energy, action timestamps, and generic semantic shot traits.
- [x] Built-in processing remains local. External AI is opt-in.
- [x] AI folder preprocessing is an explicit background job with frame-count, cache-size, concurrency, ETA, progress, cancellation, and recoverable failures.
- [x] AI preprocessing caches sampled frames locally to trade disk space for faster retries.
- [x] Cloud or local AI API keys are not persisted in preprocessing job JSON.
- [x] Highlight duration has a hard 300-second maximum.
- [x] Public audio includes source and license metadata warnings.

## Next Reliability Work

- [ ] Resume an interrupted import after the app restarts without selecting the folder again.
- [ ] Add a diagnostics screen with FFmpeg version, storage path, free space, and exportable logs.
- [ ] Resume an interrupted AI preprocessing job after app restart when the model does not require an API key.
- [ ] Add an event inspector so users can approve/reject semantic events before rendering.
- [ ] Add automated power-loss and disk-full fault-injection tests.

## AI Model Policy

No semantic video-watching model is bundled in this version. Bundling one would add multiple gigabytes, increase GPU/RAM requirements, and make reliability harder to predict across gaming PCs.

Users can connect Ollama or another OpenAI-compatible local server for metadata advice, quick frame review, or full folder preprocessing. For local visual rating, recommend `qwen2.5vl:7b`; use `qwen2.5vl:3b` on lower-VRAM machines. A vision-capable model is required for frame inspection. Text-only models can provide advice but cannot inspect gameplay.
