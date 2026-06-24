# Hugging Face Spaces Docker CPU - Whisper

This document prepares the Whisper sidecar for Hugging Face Spaces using Docker CPU. It does not create the Space.

## What Runs On Hugging Face

The Whisper sidecar in `services/whisper` should run as a Docker Space.

It exposes:

- `GET /health`
- `POST /transcribe`

## Source Files

Use:

```text
services/whisper/Dockerfile
services/whisper/main.py
services/whisper/requirements.txt
```

## Port

The service Dockerfile exposes port `9000`.

Hugging Face Docker Spaces default to port `7860` unless configured. For this app, configure the Space README YAML with:

```yaml
---
sdk: docker
app_port: 9000
---
```

## Environment Variables

Set these in the Space settings:

```env
WHISPER_MODEL=base
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
ENABLE_DIARIZATION=false
HUGGINGFACE_TOKEN=
```

Do not enable diarization for free staging.

## API Configuration

Set the Render API and worker environment variable:

```env
WHISPER_URL=https://YOUR_SPACE_USERNAME-YOUR_SPACE_NAME.hf.space
```

Do not include a trailing slash.

## Manual Dashboard Step

Stop here for human action:

1. Create a Hugging Face Space.
2. Choose Docker SDK.
3. Copy the files from `services/whisper`.
4. Set `app_port: 9000`.
5. Add environment variables.
6. Wait for the Space build to finish.

## Verification

Open:

```text
https://YOUR_SPACE_USERNAME-YOUR_SPACE_NAME.hf.space/health
```

Expected:

```json
{ "ok": true }
```

Then run a small transcription request before connecting the full pipeline.

## Known Free-Tier Caveats

- CPU transcription can be slow.
- Spaces can sleep or cold start.
- Large uploads may time out.
- Use short 10-30 second staging videos.
