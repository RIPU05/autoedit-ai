# AutoEdit AI v0.9.0 — Rate Limiting and Abuse Protection

## Summary

This release adds production-ready rate limiting before public deployment.

The goal of v0.9.0 is to reduce abuse risk on authentication, upload, integration, and general API surfaces while keeping the working upload/transcribe/fallback/render/S3 pipeline intact.

Claude, render logic, and the core upload implementation are unchanged.

## What’s New

### Central Rate Limit Module

Added reusable API limiters:

* `AUTH_LIMITER`: 5 requests per minute
* `UPLOAD_LIMITER`: 20 requests per minute
* `INTEGRATION_LIMITER`: 10 requests per minute
* `GENERAL_API_LIMITER`: 100 requests per minute

Limiter keying behavior:

* auth limiter is IP-based for login/register abuse protection
* authenticated upload, integration, project, dashboard, creator, analytics, and feedback routes are user-id based when `req.user` is available
* authenticated limiters fall back to client IP if a user id is unavailable
* test-only deterministic keys are used by mocked regression tests

### Protected Routes

Protected authentication routes:

* `POST /api/auth/register`
* `POST /api/auth/login`

Protected upload routes:

* `POST /api/upload/start`
* `POST /api/upload/part`
* `POST /api/upload/complete`

Protected integration routes:

* Claude integration routes under `/api/integrations`
* n8n integration routes under `/api/integrations`

Protected general API routes:

* `/api/projects`
* `/api/dashboard`
* `/api/creator`
* `/api/analytics`
* `/api/feedback`

Health checks remain unthrottled so deployment and monitoring probes are not blocked.

## Deployment Notes

`TRUST_PROXY` is now configurable for deployments behind a trusted proxy or load balancer.

Recommended local value:

```env
TRUST_PROXY=false
```

Recommended value behind a single trusted proxy, such as common Render/Railway/Cloudflare-style deployments:

```env
TRUST_PROXY=1
```

Configure this carefully. IP-based auth limiting depends on Express seeing the correct client IP.

Upload limits may need tuning for very large multipart uploads or very small chunk sizes. The current default allows 20 upload API requests per minute per authenticated user.

## 429 Behavior

When a limit is exceeded, the API returns HTTP `429` with a JSON response:

```json
{
  "error": "rate limit exceeded",
  "retryAfterSec": 60
}
```

Standard rate-limit headers are enabled. Legacy rate-limit headers are disabled.

## Tests Added

Added regression coverage for:

* auth limiter returning 429 on the 6th request
* upload limiter returning 429 over the configured threshold
* integration limiter returning 429 over the configured threshold
* normal below-threshold requests continuing to work
* JSON error response shape
* retry information

## Verified

* API build passed
* Regression test suite passed
* 19 mocked tests passed
* Manual upload/transcribe/fallback/render/S3 pipeline passed
* Three render outputs completed and uploaded to S3
* Health routes remained reachable
* No secrets were exposed

## Known Limitations

* Limits are in-process and should use a shared store before multi-instance production deployment.
* Live upload/S3/Whisper/render regression remains manual.
* Audio ducking is still deferred.
* Real funded Claude key path remains unverified.

## Next Step

Recommended next branches:

* Redis-backed distributed rate-limit store for multi-instance deployment
* public deployment hardening
* route-test expansion / CI coverage
* Stripe / usage limits
* real Claude key test
