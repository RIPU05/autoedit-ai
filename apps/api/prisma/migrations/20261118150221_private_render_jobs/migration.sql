-- CreateTable
CREATE TABLE "PrivateRenderJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "editVersionId" TEXT NOT NULL,
    "mediaSourceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "customEditHash" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "windowStartSec" DOUBLE PRECISION NOT NULL,
    "windowEndSec" DOUBLE PRECISION NOT NULL,
    "effects" JSONB NOT NULL DEFAULT '{}',
    "renderSettings" JSONB NOT NULL DEFAULT '{}',
    "status" "MediaJobStatusEnum" NOT NULL DEFAULT 'QUEUED',
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "ownerWorkerId" TEXT,
    "ownerToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "bullJobId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "artifactCacheKey" TEXT,
    "outputObjectKey" TEXT,
    "outputSha256" TEXT,
    "outputEtag" TEXT,
    "outputSizeBytes" BIGINT,
    "outputDurationSec" DOUBLE PRECISION,
    "outputWidth" INTEGER,
    "outputHeight" INTEGER,
    "outputExpiresAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivateRenderJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrivateRenderJob_projectId_createdAt_idx" ON "PrivateRenderJob"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "PrivateRenderJob_userId_status_idx" ON "PrivateRenderJob"("userId", "status");

-- CreateIndex
CREATE INDEX "PrivateRenderJob_status_leaseExpiresAt_idx" ON "PrivateRenderJob"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateRenderJob_userId_idempotencyKey_key" ON "PrivateRenderJob"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "PrivateRenderJob" ADD CONSTRAINT "PrivateRenderJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateRenderJob" ADD CONSTRAINT "PrivateRenderJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateRenderJob" ADD CONSTRAINT "PrivateRenderJob_editVersionId_fkey" FOREIGN KEY ("editVersionId") REFERENCES "EditVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
