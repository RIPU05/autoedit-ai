# AutoEdit AI v0.6.0 — Regression Test Suite

## Summary

This release introduces the first automated regression test suite for AutoEdit AI.

The goal of v0.6.0 is to protect all previously validated functionality before additional features are added.

The suite covers:

- API routes
- upload flow
- integrations
- worker behavior
- fallback behavior
- secret safety

This release prioritizes reliability over new product features.

## What’s New

### Route Test Coverage

Added tests for:

- register
- login
- me
- project creation
- project listing
- project retrieval
- upload/start
- upload/part
- upload/complete
- Claude integration routes
- n8n integration routes
- health endpoints

### Worker Test Coverage

Added tests for:

- transcript persistence
- AI-provider failure fallback
- timeline generation fallback
- render queue creation
- render completion
- render failure logging
- n8n best-effort dispatch

### Regression Command

Added:

```powershell
npm run test:regression
```

Runs:

- unit tests
- route tests
- worker tests

without requiring real cloud credentials.

### Testing Documentation

Added:

```text
docs/testing.md
```

Includes:

- local testing
- mocked services
- manual regression flow
- known gaps

## Verified

- API build passed
- Test suite passed
- 15 tests passed
- Manual regression passed
- Upload -> Transcribe -> Fallback -> Render -> S3 verified
- Secret non-disclosure verified
- Integration routes verified
- Worker fallback behavior verified

## Architecture Notes

To support route testing, the Express application bootstrap was separated from server startup.

Changes:

- `app.ts` introduced
- `index.ts` simplified

This is an intentional testability refactor.

Manual regression was performed after the change.

No runtime regressions were observed.

## Known Issues

### Intermittent Legacy Helper Upload Failure

The older helper script:

```text
tmp/run-v03-pipeline.ps1
```

occasionally exhibited S3 PUT failures.

The same upload path succeeded through equivalent direct execution and application usage.

Root cause has not been identified.

Current status:

- application upload flow passes
- issue remains under observation

### Remaining Project Gaps

- No-audio uploads still fail during analysis/extractAudio
- Audio ducking not implemented
- Real funded Claude path remains unverified
- Public deployment not yet completed

## Next Step

Recommended next branch:

```text
feature/no-audio-analysis-hardening-v0.7
```

Reason:

Render layer now handles no-audio media safely.

The remaining failure occurs earlier during analysis/transcription and can now be addressed safely with regression protection in place.
