-- CreateEnum
CREATE TYPE "MediaJobStatusEnum" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "MediaProcessingJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mediaSourceId" TEXT NOT NULL,
    "projectId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "sharedWorkKey" TEXT NOT NULL,
    "sourceType" "MediaSourceTypeEnum" NOT NULL,
    "status" "MediaJobStatusEnum" NOT NULL DEFAULT 'QUEUED',
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "bullJobId" TEXT,
    "options" JSONB,
    "resultSummary" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaProcessingJob_userId_createdAt_idx" ON "MediaProcessingJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "MediaProcessingJob_userId_status_idx" ON "MediaProcessingJob"("userId", "status");

-- CreateIndex
CREATE INDEX "MediaProcessingJob_sharedWorkKey_status_idx" ON "MediaProcessingJob"("sharedWorkKey", "status");

-- CreateIndex
CREATE INDEX "MediaProcessingJob_mediaSourceId_status_idx" ON "MediaProcessingJob"("mediaSourceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MediaProcessingJob_userId_idempotencyKey_key" ON "MediaProcessingJob"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "MediaProcessingJob" ADD CONSTRAINT "MediaProcessingJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaProcessingJob" ADD CONSTRAINT "MediaProcessingJob_mediaSourceId_fkey" FOREIGN KEY ("mediaSourceId") REFERENCES "MediaSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaProcessingJob" ADD CONSTRAINT "MediaProcessingJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
