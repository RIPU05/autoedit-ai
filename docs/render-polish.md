# Render Polish

AutoEdit's render polish path improves video output without Claude or paid AI. It uses the existing timeline effects produced by local/fallback analysis and keeps rendering best-effort.

## Crossfades

Crossfades use the existing timeline effect:

```json
{
  "transitions": "fade"
}
```

When enabled, the FFmpeg pipeline attempts a short 0.25 second fade between adjacent kept clips. Crossfade is skipped when:

- there is only one kept clip
- a clip is too short for a safe fade
- FFmpeg rejects the crossfade graph

If crossfade is skipped, AutoEdit falls back to normal hard-cut concatenation. Subtitles are still burned in after the concat/crossfade step.

## Background Music

Background music is optional and local-only by default. No copyrighted music is included in the repository.

Configure a local music file:

```env
BACKGROUND_MUSIC_PATH=C:\path\to\music.mp3
BACKGROUND_MUSIC_VOLUME=0.1
```

Behavior:

- Music is used only when the timeline effect has `music: true`.
- If `BACKGROUND_MUSIC_PATH` is missing or invalid, rendering continues without music.
- Music is mixed quietly under the original audio.
- Default volume is 10%.
- Music is looped or trimmed to the output duration.
- If the source has no audio, the music track can be used as the output audio bed.

## Audio Ducking

Full sidechain ducking is not implemented yet. The current safe behavior is a low default music volume so speech remains audible. Proper ducking should be added later with a dedicated FFmpeg sidechain/compressor pass and regression tests on speech-heavy samples.

## Known Limitations

- Crossfade is intentionally short and conservative.
- Crossfade may fall back to hard cuts on unusual media or clips without compatible audio streams.
- Music must be a valid local file available to the worker process.
- The current UI does not expose music selection yet.
- Render speed may be slower when crossfades or music are enabled because FFmpeg must re-encode.

