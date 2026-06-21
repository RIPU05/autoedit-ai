# No-Audio Video Handling

AutoEdit AI supports video files that do not contain an audio stream.

## Behavior

When the analysis worker detects that a source video has no audio stream:

- FFmpeg audio extraction is skipped.
- Whisper transcription is skipped.
- An empty transcript record is stored.
- Transcript language is set to `unknown`.
- Transcript `segments` and `words` are empty arrays.
- Fallback timeline generation continues.
- Captions are empty.
- Render jobs are enqueued normally.

The worker logs:

```text
No audio stream detected; skipping transcription and using fallback timeline
```

## Timeline

For no-audio media, the fallback provider creates a simple full-duration edit operation using the probed video duration. This keeps the video renderable without inventing transcript text or fake audio.

## Rendering

The render layer can produce video-only output when no audio or music is present. If background music is configured and enabled by the timeline effects, the music track can be used as the output audio bed.

## Limitations

- Captions are empty because there is no transcript.
- No speech analysis is available.
- No fake silent audio is generated.
- AI providers that require transcript text should fall back to the local fallback timeline.
