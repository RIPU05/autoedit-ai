# AutoEdit AI v0.8.0 — CI Regression

## Summary

v0.8.0 adds GitHub Actions CI for AutoEdit AI.

The workflow runs builds and mocked regression tests automatically, protecting the v0.1–v0.7 working pipeline without requiring live cloud services or secrets.

## What’s New

- `.github/workflows/ci.yml`
- CI on `push` and `pull_request`
- Node 20 runner
- API dependency install
- Prisma generate
- API build
- API mocked regression tests
- Web dependency install
- Web build
- README CI badge

## Verified

- CI green path passed on GitHub.
- CI red path verified with intentional failing test.
- Revert restored green CI.
- 16 mocked tests pass.
- No real AWS, Anthropic, Redis, Postgres, Docker, n8n, Ollama, or Whisper required.
- No secrets required.

## Known Limitations

- Live upload/S3/Whisper/render pipeline remains manual.
- Skipped E2E tests still require real services.
- Intermittent legacy S3 PUT helper issue remains under observation.
- Audio ducking is still deferred.
- Real funded Claude key path remains unverified.

## Next Step

Possible next branches:

- Audio ducking.
- Public deployment.
- Rate limiting.
- Stripe / usage limits.
- Real Claude key test.
