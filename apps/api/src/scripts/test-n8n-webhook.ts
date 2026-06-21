import { prisma } from '../lib/prisma.js';
import { dispatchIntegrationEvent } from '../services/integration-events.service.js';

async function main() {
  const email = process.env.N8N_TEST_USER_EMAIL;
  const account = await prisma.integrationAccount.findFirst({
    where: {
      provider: 'N8N',
      status: 'CONNECTED',
      ...(email ? { user: { email } } : {}),
    },
    include: { user: { select: { id: true, email: true } } },
    orderBy: { updatedAt: 'desc' },
  });

  if (!account) {
    console.error(email ? `No connected n8n integration found for ${email}.` : 'No connected n8n integration found.');
    console.error('Connect n8n first with POST /api/integrations/n8n/connect, then rerun npm run test:n8n-webhook.');
    process.exitCode = 1;
    return;
  }

  const before = await prisma.integrationEventLog.count({ where: { userId: account.userId } });
  await dispatchIntegrationEvent(account.userId, 'project.created', {
    projectTitle: 'AutoEdit n8n webhook test',
    metadata: {
      test: true,
      source: 'npm run test:n8n-webhook',
    },
  });

  const event = await prisma.integrationEventLog.findFirst({
    where: { userId: account.userId },
    orderBy: { createdAt: 'desc' },
    select: {
      eventType: true,
      status: true,
      responseStatusCode: true,
      error: true,
      createdAt: true,
    },
  });
  const after = await prisma.integrationEventLog.count({ where: { userId: account.userId } });

  if (!event || after === before) {
    console.error('n8n test dispatch did not create an event log. Check whether the integration is connected.');
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        ok: event.status === 'SUCCESS',
        userEmail: account.user.email,
        eventType: event.eventType,
        status: event.status,
        responseStatusCode: event.responseStatusCode,
        error: event.error,
        createdAt: event.createdAt,
      },
      null,
      2,
    ),
  );

  if (event.status !== 'SUCCESS') process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
