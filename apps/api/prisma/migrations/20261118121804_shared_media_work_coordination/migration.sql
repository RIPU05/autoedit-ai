-- CreateEnum
CREATE TYPE "SharedWorkStatusEnum" AS ENUM ('PENDING_ENQUEUE', 'ENQUEUED', 'RUNNING', 'READY', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "MediaProcessingJob" ADD COLUMN     "attachedGeneration" INTEGER;

-- CreateTable
CREATE TABLE "SharedMediaWork" (
    "id" TEXT NOT NULL,
    "sharedWorkKey" TEXT NOT NULL,
    "mediaSourceId" TEXT NOT NULL,
    "canonicalSourceId" TEXT NOT NULL,
    "sourceType" "MediaSourceTypeEnum" NOT NULL,
    "status" "SharedWorkStatusEnum" NOT NULL DEFAULT 'PENDING_ENQUEUE',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "ownerWorkerId" TEXT,
    "ownerToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "enqueuePayload" JSONB,
    "bullJobId" TEXT,
    "enqueueAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextEnqueueAt" TIMESTAMP(3),
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "resultSummary" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharedMediaWork_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SharedMediaWork_sharedWorkKey_key" ON "SharedMediaWork"("sharedWorkKey");

-- CreateIndex
CREATE INDEX "SharedMediaWork_status_nextEnqueueAt_idx" ON "SharedMediaWork"("status", "nextEnqueueAt");

-- CreateIndex
CREATE INDEX "SharedMediaWork_status_leaseExpiresAt_idx" ON "SharedMediaWork"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "SharedMediaWork_mediaSourceId_status_idx" ON "SharedMediaWork"("mediaSourceId", "status");

-- AddForeignKey
ALTER TABLE "SharedMediaWork" ADD CONSTRAINT "SharedMediaWork_mediaSourceId_fkey" FOREIGN KEY ("mediaSourceId") REFERENCES "MediaSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
