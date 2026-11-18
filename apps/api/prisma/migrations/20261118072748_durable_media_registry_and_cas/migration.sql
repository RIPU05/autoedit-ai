-- CreateEnum
CREATE TYPE "MediaSourceProviderEnum" AS ENUM ('UPLOAD', 'YOUTUBE', 'TWITCH', 'KICK', 'DIRECT_MEDIA');

-- CreateEnum
CREATE TYPE "MediaSourceTypeEnum" AS ENUM ('LIVE', 'VOD', 'UPLOADED');

-- CreateEnum
CREATE TYPE "MediaIdentityScopeEnum" AS ENUM ('IMMUTABLE_BROADCAST', 'IMMUTABLE_VOD', 'IMMUTABLE_UPLOAD');

-- CreateEnum
CREATE TYPE "MediaAcquisitionCapabilityEnum" AS ENUM ('DIRECT_UPLOAD', 'APPROVED_API', 'PERMITTED_STREAM', 'PERMITTED_DIRECT_URL', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "MediaRightsStatusEnum" AS ENUM ('USER_OWNED', 'PERMITTED_PUBLIC', 'REQUIRES_AUTHORIZATION', 'RESTRICTED_DRM', 'DENIED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MediaSourceAvailabilityEnum" AS ENUM ('AVAILABLE', 'LIVE_NOW', 'ENDED_PROCESSING', 'OFFLINE', 'UNAVAILABLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RightsGrantScopeEnum" AS ENUM ('ACQUISITION_ONLY', 'SHARED_REUSE', 'PRIVATE_OWNER');

-- CreateEnum
CREATE TYPE "SharedArtifactKindEnum" AS ENUM ('SOURCE_MEDIA', 'SOURCE_SEGMENT', 'TRANSCRIPTION', 'HIGHLIGHT_ANALYSIS', 'BASE_CLIP');

-- CreateEnum
CREATE TYPE "SharedArtifactStateEnum" AS ENUM ('PENDING', 'PUBLISHED', 'REPAIRING', 'INVALIDATED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ArtifactAttemptStateEnum" AS ENUM ('RESERVED', 'UPLOADED', 'COMMITTED', 'ABANDONED', 'SUPERSEDED', 'FAILED');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "mediaSourceId" TEXT;

-- CreateTable
CREATE TABLE "MediaSource" (
    "id" TEXT NOT NULL,
    "canonicalId" TEXT NOT NULL,
    "identityScope" "MediaIdentityScopeEnum" NOT NULL,
    "provider" "MediaSourceProviderEnum" NOT NULL,
    "sourceType" "MediaSourceTypeEnum" NOT NULL,
    "externalId" TEXT NOT NULL,
    "channelId" TEXT,
    "broadcastId" TEXT,
    "vodId" TEXT,
    "associatedLiveSourceId" TEXT,
    "sourceRevision" TEXT NOT NULL DEFAULT 'v1',
    "normalizedUrl" TEXT,
    "availability" "MediaSourceAvailabilityEnum" NOT NULL DEFAULT 'UNKNOWN',
    "acquisitionCapability" "MediaAcquisitionCapabilityEnum" NOT NULL DEFAULT 'UNSUPPORTED',
    "rightsStatus" "MediaRightsStatusEnum" NOT NULL DEFAULT 'UNKNOWN',
    "rightsScope" TEXT NOT NULL DEFAULT 'NONE',
    "rightsProvenance" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "ownerUserId" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "retentionExpiresAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaRightsGrant" (
    "id" TEXT NOT NULL,
    "mediaSourceId" TEXT NOT NULL,
    "grantScope" "RightsGrantScopeEnum" NOT NULL,
    "granteeUserId" TEXT,
    "allowAcquisition" BOOLEAN NOT NULL DEFAULT false,
    "allowSharedReuse" BOOLEAN NOT NULL DEFAULT false,
    "provenance" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "reason" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "MediaRightsGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedCacheArtifact" (
    "id" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "mediaSourceId" TEXT NOT NULL,
    "artifactKind" "SharedArtifactKindEnum" NOT NULL,
    "rightsScope" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "sourceRevision" TEXT NOT NULL DEFAULT 'v1',
    "algorithmVersion" TEXT NOT NULL DEFAULT 'v1',
    "renderSettingsHash" TEXT,
    "windowStartSec" DOUBLE PRECISION,
    "windowEndSec" DOUBLE PRECISION,
    "state" "SharedArtifactStateEnum" NOT NULL DEFAULT 'PENDING',
    "latestReservedGen" INTEGER NOT NULL DEFAULT 0,
    "publishedGeneration" INTEGER NOT NULL DEFAULT 0,
    "activeAttemptId" TEXT,
    "storageKeyPrefix" TEXT NOT NULL,
    "publishedObjectKey" TEXT,
    "contentSha256" TEXT,
    "etag" TEXT,
    "sizeBytes" BIGINT,
    "mimeType" TEXT,
    "mediaMetadata" JSONB,
    "expiresAt" TIMESTAMP(3),
    "cleanedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharedCacheArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedArtifactAttempt" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "workerId" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "state" "ArtifactAttemptStateEnum" NOT NULL DEFAULT 'RESERVED',
    "objectKey" TEXT,
    "contentSha256" TEXT,
    "etag" TEXT,
    "sizeBytes" BIGINT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cleanupEligibleAfter" TIMESTAMP(3),
    "cleanedUpAt" TIMESTAMP(3),

    CONSTRAINT "SharedArtifactAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaSource_canonicalId_key" ON "MediaSource"("canonicalId");

-- CreateIndex
CREATE INDEX "MediaSource_provider_channelId_idx" ON "MediaSource"("provider", "channelId");

-- CreateIndex
CREATE INDEX "MediaSource_provider_broadcastId_idx" ON "MediaSource"("provider", "broadcastId");

-- CreateIndex
CREATE INDEX "MediaSource_provider_vodId_idx" ON "MediaSource"("provider", "vodId");

-- CreateIndex
CREATE INDEX "MediaSource_ownerUserId_idx" ON "MediaSource"("ownerUserId");

-- CreateIndex
CREATE INDEX "MediaSource_rightsStatus_availability_idx" ON "MediaSource"("rightsStatus", "availability");

-- CreateIndex
CREATE INDEX "MediaSource_retentionExpiresAt_idx" ON "MediaSource"("retentionExpiresAt");

-- CreateIndex
CREATE INDEX "MediaRightsGrant_mediaSourceId_revokedAt_expiresAt_idx" ON "MediaRightsGrant"("mediaSourceId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "MediaRightsGrant_granteeUserId_idx" ON "MediaRightsGrant"("granteeUserId");

-- CreateIndex
CREATE UNIQUE INDEX "SharedCacheArtifact_cacheKey_key" ON "SharedCacheArtifact"("cacheKey");

-- CreateIndex
CREATE INDEX "SharedCacheArtifact_mediaSourceId_artifactKind_state_idx" ON "SharedCacheArtifact"("mediaSourceId", "artifactKind", "state");

-- CreateIndex
CREATE INDEX "SharedCacheArtifact_rightsScope_ownerUserId_idx" ON "SharedCacheArtifact"("rightsScope", "ownerUserId");

-- CreateIndex
CREATE INDEX "SharedCacheArtifact_state_expiresAt_idx" ON "SharedCacheArtifact"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "SharedArtifactAttempt_state_cleanupEligibleAfter_cleanedUpA_idx" ON "SharedArtifactAttempt"("state", "cleanupEligibleAfter", "cleanedUpAt");

-- CreateIndex
CREATE UNIQUE INDEX "SharedArtifactAttempt_artifactId_generation_key" ON "SharedArtifactAttempt"("artifactId", "generation");

-- CreateIndex
CREATE INDEX "Project_mediaSourceId_idx" ON "Project"("mediaSourceId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_mediaSourceId_fkey" FOREIGN KEY ("mediaSourceId") REFERENCES "MediaSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaSource" ADD CONSTRAINT "MediaSource_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaSource" ADD CONSTRAINT "MediaSource_associatedLiveSourceId_fkey" FOREIGN KEY ("associatedLiveSourceId") REFERENCES "MediaSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaRightsGrant" ADD CONSTRAINT "MediaRightsGrant_mediaSourceId_fkey" FOREIGN KEY ("mediaSourceId") REFERENCES "MediaSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedCacheArtifact" ADD CONSTRAINT "SharedCacheArtifact_mediaSourceId_fkey" FOREIGN KEY ("mediaSourceId") REFERENCES "MediaSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedArtifactAttempt" ADD CONSTRAINT "SharedArtifactAttempt_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "SharedCacheArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
