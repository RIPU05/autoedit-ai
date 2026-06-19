-- AI Edit History & Versioning — reference migration.
--
-- CANONICAL PATH: run `npx prisma migrate dev --name edit_versioning`. Prisma
-- diffs the updated schema against your DB and generates a migration that
-- integrates with your existing baseline. Use the SQL below only if you apply
-- migrations by hand.
--
-- Immutable timeline snapshots with a parent pointer for future branching.

CREATE TABLE "EditVersion" (
    "id"              TEXT NOT NULL,
    "projectId"       TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "userPrompt"      TEXT,
    "aiExplanation"   TEXT,
    "changes"         JSONB NOT NULL DEFAULT '[]',
    "timelineJson"    JSONB NOT NULL,
    "parentVersionId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EditVersion_projectId_createdAt_idx" ON "EditVersion"("projectId", "createdAt");

ALTER TABLE "EditVersion"
    ADD CONSTRAINT "EditVersion_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EditVersion"
    ADD CONSTRAINT "EditVersion_parentVersionId_fkey"
    FOREIGN KEY ("parentVersionId") REFERENCES "EditVersion"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── Multi-agent analysis fields (Phase 5) ──────────────────────────────────
-- Canonical: `npx prisma migrate dev` regenerates this from the schema.
ALTER TABLE "Analysis" ADD COLUMN "hook"     JSONB;
ALTER TABLE "Analysis" ADD COLUMN "thumbnail" JSONB;
ALTER TABLE "Analysis" ADD COLUMN "agentLog" JSONB;
ALTER TABLE "Analysis" ADD COLUMN "strategy" TEXT;

-- ── Reliability / transcription / creator / feedback (Phases 1-6) ───────────
-- Canonical: `npx prisma migrate dev --name reliability_phases`.

ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'USER';  -- enum UserRole

CREATE TABLE "StageTiming" (
  "id" TEXT NOT NULL, "projectId" TEXT, "stage" TEXT NOT NULL, "ms" INTEGER NOT NULL,
  "ok" BOOLEAN NOT NULL DEFAULT true, "meta" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StageTiming_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StageTiming_stage_createdAt_idx" ON "StageTiming"("stage","createdAt");
CREATE INDEX "StageTiming_projectId_idx" ON "StageTiming"("projectId");

CREATE TABLE "ErrorEvent" (
  "id" TEXT NOT NULL, "category" TEXT NOT NULL, "projectId" TEXT, "jobId" TEXT,
  "message" TEXT NOT NULL, "stack" TEXT, "meta" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ErrorEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ErrorEvent_category_createdAt_idx" ON "ErrorEvent"("category","createdAt");

CREATE TABLE "Transcript" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "language" TEXT NOT NULL,
  "durationSec" DOUBLE PRECISION NOT NULL, "segments" JSONB NOT NULL, "words" JSONB NOT NULL,
  "avgConfidence" DOUBLE PRECISION, "model" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Transcript_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Transcript_projectId_key" ON "Transcript"("projectId");
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CreatorProfile" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "pacingPreference" TEXT NOT NULL DEFAULT 'balanced',
  "captionPreference" TEXT NOT NULL DEFAULT 'on',
  "musicPreference" TEXT NOT NULL DEFAULT 'subtle',
  "hookPreference" TEXT NOT NULL DEFAULT 'strong',
  "platformPreference" TEXT NOT NULL DEFAULT 'shorts',
  "editingStyle" TEXT NOT NULL DEFAULT 'viral',
  "signals" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreatorProfile_userId_key" ON "CreatorProfile"("userId");
ALTER TABLE "CreatorProfile" ADD CONSTRAINT "CreatorProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Feedback" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "projectId" TEXT, "rating" INTEGER NOT NULL,
  "comment" TEXT, "category" TEXT, "answers" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt");
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
