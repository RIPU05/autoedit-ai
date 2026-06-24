# Neon Free PostgreSQL

This document prepares Neon PostgreSQL for AutoEdit AI staging. It does not create the database.

## What Runs On Neon

Neon hosts the PostgreSQL database used by:

- Express API
- BullMQ worker
- Prisma migrations

## Create Database

Manual dashboard action:

1. Create a Neon project.
2. Create or select a database for AutoEdit AI staging.
3. Copy the connection strings from the Neon console.

## Connection Strings

Use the pooled Neon connection string for runtime:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require
```

Prisma migrations should use a direct connection when available:

```env
DIRECT_URL=postgresql://USER:PASSWORD@HOST.REGION.aws.neon.tech/DB?sslmode=require
```

Current schema only reads `DATABASE_URL`, so for v0.13 run migrations manually from a trusted local shell or CI environment with the direct Neon URL temporarily assigned to `DATABASE_URL`.

## Migration Commands

From `apps/api`:

```powershell
$env:DATABASE_URL="postgresql://USER:PASSWORD@HOST.REGION.aws.neon.tech/DB?sslmode=require"
npx prisma generate
npx prisma migrate deploy
```

Do not commit the connection string.

## Verification

From `apps/api`:

```powershell
npx prisma migrate status
```

Then verify the API:

```text
GET /health/db
```

Expected:

```json
{ "ok": true }
```

## Notes

- Keep staging and production databases separate.
- Use `sslmode=require`.
- Neon free resources may sleep or cold start; the first DB connection can be slower.
- Do not use a local Docker Postgres URL in Render.
