# HighlightAI

HighlightAI is a local-first desktop app for turning raw gameplay recordings into polished highlight videos. It links or imports recordings, analyzes video/audio signals with FFmpeg, optionally asks an OpenAI-compatible vision model to review candidate moments, and renders local MP4 exports.

The project is built as a React/Vite renderer, an Express local API, and an Electron desktop shell. Runtime project data is stored on disk as JSON and media files instead of requiring a database.

## Preview

### App UI

The desktop workspace for importing recordings, reviewing candidate clips, configuring AI, and starting local render jobs.

![HighlightAI app UI](docs/assets/App.gif)

### Generated Video

An example of the final video output rendered by HighlightAI from selected gameplay moments.

[Watch the generated video on YouTube](https://youtu.be/jIYO9-3kVyE)

![HighlightAI generated video](docs/assets/GenerateVideo.gif)

## Architecture

```text
Electron desktop shell
  |
  | opens packaged app or Vite dev server
  v
React + Vite UI
  |
  | typed fetch client
  v
Express local API
  |
  | JSON projects, jobs, uploads, previews, thumbnails, exports
  v
Local data root
  |
  +-- FFprobe metadata probing
  +-- FFmpeg signal analysis and rendering
  +-- Optional OpenAI-compatible vision/text endpoints
```

### Frontend

The frontend lives in `src/`.

- `src/App.tsx` owns the main workflow: importing footage, listing clips, configuring AI, launching background jobs, planning drafts, rendering exports, and showing project state.
- `src/services/api.ts` is the typed HTTP client for the local API.
- `src/services/analyzer.ts` contains UI-side helpers for formatting, presets, duration limits, and asset conversion.
- `src/types.ts` defines the project, media, job, draft, diagnostics, and AI contracts shared by the renderer.

During Vite development the client talks to `http://127.0.0.1:4312/api`. In production it uses same-origin `/api` through the Express app.

### Backend

The backend lives in `server/`.

- `server/index.mjs` starts the Express API, owns storage paths, serves uploaded/exported media, manages ingest, fast-index, vision-review, draft, render, pause/resume, cancellation, recovery, and cleanup endpoints.
- `server/media.mjs` wraps FFmpeg/FFprobe and contains media analysis, candidate-window scoring, draft planning, segment alignment, trailer rendering, and JSON utility helpers.
- `server/dev.mjs` runs the API and Vite dev server together for local web development.

The backend stores state under `data/` by default. Packaged desktop builds set `HIGHLIGHTAI_DATA_ROOT` to the Electron user-data folder so generated projects and exports stay outside the app install.

### Desktop Shell

The desktop entrypoint lives in `desktop/`.

- `desktop/main.mjs` creates the Electron window, starts the local API in packaged mode, waits for `/api/health`, and loads either the packaged app or the Vite dev URL.
- `desktop/preload.cjs` exposes a narrow bridge for desktop-only operations such as choosing a local folder and showing an exported file in the OS file browser.

The Electron package is configured in `package.json` and outputs Windows portable builds into `release/`.

## Processing Flow

1. Import browser-selected files or link a local folder from the desktop shell.
2. Probe each video with FFprobe for duration, codecs, frame rate, resolution, bitrate, and audio availability.
3. Run FFmpeg-based local analysis to identify scene changes, loud audio, action scores, highlight starts, thumbnails, and candidate windows.
4. Optionally run Vision AI review against an OpenAI-compatible multimodal endpoint. The app stores compact review metadata, tags, event timing, and rejection reasons.
5. Generate a draft from verified semantic events, reviewed candidates, fast-index windows, or deterministic local-signal fallbacks.
6. Render the selected draft locally with FFmpeg and save the export plus source metadata.

## Project Layout

```text
desktop/              Electron main process and preload bridge
server/               Express API, job recovery, FFmpeg/AI orchestration
src/                  React app, API client, shared types, frontend tests
scripts/              Packaging, mock AI, icon, FFmpeg, and QA utilities
docs/                 Workflow notes, QA audit, and engineering checklists
build/                Source build assets such as app icons
data/                 Local runtime data, ignored by Git
dist/                 Vite production build, ignored by Git
release/              Electron package output, ignored by Git
vendor/               Prepared local FFmpeg assets, ignored by Git
```

## Runtime Data

`data/` is generated at runtime and intentionally ignored by Git. It can contain:

- uploaded or linked project records;
- project JSON under `data/projects/`;
- background job JSON under `data/jobs/`;
- thumbnails, previews, preprocess frames, and temporary render files;
- rendered exports under `data/exports/`;
- QA reports and other manual review artifacts.

Large source recordings, generated videos, package outputs, tool state, logs, and local secrets are ignored in `.gitignore`.

## Requirements

- Node.js 20 or newer.
- npm.
- FFmpeg and FFprobe on `PATH` for development.
- Optional: Ollama or another OpenAI-compatible multimodal endpoint for Vision AI.

## Install

```powershell
npm install
```

## Run

API only:

```powershell
npm run api
```

Vite frontend only:

```powershell
npm run dev
```

Full local web app:

```powershell
npm run dev:full
```

Desktop development:

```powershell
npm run desktop:dev
```

## Build And Verify

Production web build:

```powershell
npm run build
```

Windows portable desktop package:

```powershell
npm run package:win
```

Full verification:

```powershell
npm run verify
```

`npm run verify` runs the TypeScript build, Vite build, Vitest suite, and backend syntax checks.

## AI Configuration

Vision review is optional. The app can use local Ollama, a LAN-hosted server, or a cloud endpoint that exposes an OpenAI-compatible chat completions API.

Default local vision settings:

```text
Endpoint: http://127.0.0.1:11434/v1/chat/completions
Model: qwen2.5vl:7b
API key: blank
```

Local Ollama endpoints are capped to one active vision request to reduce GPU contention. Other endpoints can use more workers through the app's AI settings.

## Privacy Model

- Raw footage stays local unless the user explicitly configures and starts an AI review against an external endpoint.
- FFmpeg analysis and rendering run locally.
- Runtime project data is stored under `data/` in development or Electron user data in packaged builds.
- API keys for active AI jobs are kept in process memory and are not written to job JSON.
- Generated media and local project data are ignored by Git.

## License

MIT
