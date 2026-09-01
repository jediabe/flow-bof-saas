# Ready-to-post local smoke runbook

This smoke proves one complete managed Style 1 run reaches `ready`, persists an approved final MP4, and emits machine-readable evidence. It uses an isolated temporary SQLite database, deterministic private in-memory storage, fake APEX/TTS/visual-QA providers, and the real local FFmpeg/ffprobe binaries. It performs no network calls and incurs no provider spend.

## Prerequisites

- Install repository dependencies (`npm ci`).
- Ensure `ffmpeg` and `ffprobe` are on `PATH`, or set `FFMPEG_PATH` and `FFPROBE_PATH`.
- Choose an explicit persistent output directory. The smoke never deletes that directory or its artifacts.

## Run

```bash
npm run smoke:ready-to-post -- --output-dir "C:/absolute/path/to/ready-to-post-smoke"
```

Expected preserved files:

- `ready-to-post-style1.mp4` — playable H.264/AAC, 1080x1920 final video.
- `ready-to-post-evidence.json` — run/final IDs, READY/final-QA status, SHA-256, byte count, probe metadata, deterministic provider call counts, and `networkProviderSpend: false`.

## Inspect

```bash
ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name,width,height -of json "C:/absolute/path/to/ready-to-post-smoke/ready-to-post-style1.mp4"
```

Compare the MP4 SHA-256 with `sha256` in `ready-to-post-evidence.json`:

```bash
sha256sum "C:/absolute/path/to/ready-to-post-smoke/ready-to-post-style1.mp4"
```

Success requires the command to exit 0, JSON `status` to equal `ready`, `finalQaStatus` to equal `APPROVED`, `networkProviderSpend` to be `false`, and the persisted MP4 hash to match the evidence.

## Failure handling

The harness cleans only its temporary database and synthetic source-media directory. It deliberately preserves the explicit smoke output directory. A failure must not be treated as READY evidence; retain the console output and rerun only after correcting the local prerequisite or code defect.
