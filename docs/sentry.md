# Sentry Free Monitoring

This document prepares optional Sentry monitoring for AutoEdit AI staging. It does not install or configure the Sentry SDK.

## Current Status

The codebase does not currently include Sentry packages or runtime initialization.

For v0.13, Sentry is a deployment planning item only. Adding SDK instrumentation should be a separate code branch.

## Recommended Projects

Create two Sentry projects:

- AutoEdit AI Web - Next.js
- AutoEdit AI API - Node/Express

## Environment Variables

Reserved names for a future instrumentation branch:

Frontend:

```env
NEXT_PUBLIC_SENTRY_DSN=
SENTRY_AUTH_TOKEN=
SENTRY_ORG=
SENTRY_PROJECT=
```

Backend:

```env
SENTRY_DSN=
SENTRY_ENVIRONMENT=staging
```

Do not add these to `.env` unless the SDK is implemented.

## Manual Dashboard Step

Stop here for human action:

1. Create a Sentry account or use an existing free workspace.
2. Create a Next.js project.
3. Create a Node/Express project.
4. Save the DSNs securely.
5. Do not paste DSNs into Git.

## Future Implementation Notes

When instrumentation is added later:

- use `@sentry/nextjs` for `apps/web`
- use `@sentry/node` for `apps/api`
- initialize Sentry before route setup in the API
- avoid sending secrets, request bodies, or presigned URLs
- verify errors in staging before public launch
