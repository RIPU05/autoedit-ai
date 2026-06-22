# AutoEdit AI v0.7.0 — No-Audio Analysis Hardening

## Summary

v0.7.0 builds on the v0.6.0 regression test suite and fixes the no-audio upload pipeline failure.

No-audio videos now reach `RENDERED` using an empty-transcript fallback instead of fake silent audio. Normal audio behavior is unchanged.

## What’s New

- Audio stream detection before `extractAudio`.
- No-audio branch in the analysis pipeline.
- Whisper is skipped when no audio stream exists.
- Empty transcript stored with no segments.
- Captionless fallback timeline.
- No-audio videos render all output formats.
- No-audio videos upload final outputs to S3.

## Verified

- No-audio video reaches `RENDERED`.
- All three outputs render and upload to S3.
- Normal audio path still works.
- Test suite passes.
- API build passes.
- 16 tests passing.
- Render polish re-verified.
- Crossfade still works.
- Background music still works.
- Caption sync still remaps correctly after crossfade.

## Known Limitations

- No-audio videos produce no captions.
- Audio ducking is still deferred.
- Real funded Claude key path remains unverified.
- Intermittent legacy S3 PUT helper issue remains under observation.

## Upgrade Notes

- No schema migration is required.
- No new env variables are required.
- Existing pipeline behavior is unchanged for videos with audio.

## Next Step

Possible next branches:

- Audio ducking.
- Route-test expansion / CI.
- Public deployment.
- Stripe / usage limits.
- Prompt editing only after the real AI path is proven.
