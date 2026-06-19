import { Worker } from 'bullmq';
import { bullConnection as connection } from '../../lib/redis.js';
import { prisma } from '../../lib/prisma.js';
import { triggerWebhook } from '../../services/n8n.service.js';
import { decrypt } from '../../utils/crypto.js';
import { N8N_QUEUE, type N8nJobData } from '../queues.js';

export const n8nWorker = new Worker<N8nJobData>(
  N8N_QUEUE,
  async (job) => {
    const { connectionId, workflowRunId, webhookPath, payload } = job.data;
    const conn = await prisma.n8nConnection.findUnique({ where: { id: connectionId } });
    if (!conn) throw new Error('n8n connection not found');

    const result = await triggerWebhook(
      { baseUrl: conn.baseUrl, apiKey: decrypt(conn.apiKeyEnc) },
      webhookPath,
      payload,
    );

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: 'RUNNING', result: result as object, executionId: (result as any)?.executionId },
    });
    return result;
  },
  { connection, concurrency: 5 },
);

n8nWorker.on('failed', async (job, err) => {
  if (job) {
    await prisma.workflowRun
      .update({ where: { id: job.data.workflowRunId }, data: { status: 'ERROR', result: { error: err.message } } })
      .catch(() => {});
  }
  console.error('[n8n] failed', job?.id, err.message);
});
