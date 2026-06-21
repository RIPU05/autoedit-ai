-- AlterTable
ALTER TABLE "IntegrationEventLog" ADD COLUMN "projectId" TEXT;
ALTER TABLE "IntegrationEventLog" ADD COLUMN "renderId" TEXT;
ALTER TABLE "IntegrationEventLog" ADD COLUMN "responseStatusCode" INTEGER;

-- CreateIndex
CREATE INDEX "IntegrationEventLog_projectId_createdAt_idx" ON "IntegrationEventLog"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationEventLog_renderId_createdAt_idx" ON "IntegrationEventLog"("renderId", "createdAt");

