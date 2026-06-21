# AutoEdit AI v0.5.0 — Render Polish

## Summary

v0.5.0 builds on v0.4.0 integrations UI and improves rendered output quality without requiring Claude or paid AI. This release adds real crossfade support, optional background music support, and keeps the existing fallback video pipeline working.

## What’s New

- 0.25s crossfade between adjacent clips.
- Hard-cut fallback when crossfade cannot be applied.
- Caption timestamp remapping for rendered-output time.
- Optional `BACKGROUND_MUSIC_PATH` support.
- Background music mixed at low volume.
- Finite music-bed generation to avoid FFmpeg hanging on looped music.
- Windows concat absolute path fix.
- Music ffprobe/helper wiring fixed.
- No-audio render layer handling improved.

## Verified

- API build passed.
- Regression pipeline passed.
- All three output formats rendered.
- Outputs uploaded to S3.
- Caption sync visually verified after remapping.
- Crossfade output verified.
- No-music render succeeds.
- Music render succeeds when a valid music path exists.
- Video-only render layer succeeds.

## Known Limitations

- Full upload pipeline still assumes source audio exists.
- No-audio uploaded videos fail earlier in `analysis.worker.ts` during `extractAudio`.
- No-audio pipeline hardening should be handled in a future branch.
- Audio ducking is not implemented yet.
- Claude remains optional/skipped.

## Upgrade Notes

- Optional env variable: `BACKGROUND_MUSIC_PATH`.
- Optional env variable: `BACKGROUND_MUSIC_VOLUME`, default `0.1`.
- If the music path is missing or invalid, music is skipped safely.
- No schema migration is required for this release.

## Next Step

Possible next branches:

- Analysis no-audio hardening.
- Route-test suite.
- Public deployment.
- Prompt editing only after the real AI path is proven.
