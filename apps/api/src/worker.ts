// Worker process entrypoint. Run separately from the API so renders scale
// independently (this is the process you replicate for horizontal scaling).
import { analysisWorker } from './queue/workers/analysis.worker.js';
import { renderWorker } from './queue/workers/render.worker.js';
import { n8nWorker } from './queue/workers/n8n.worker.js';
import { createMediaWorker } from './queue/workers/media.worker.js';

const { worker: mediaWorker } = createMediaWorker();

console.log('AutoEdit workers started: analysis, render, n8n-dispatch, media-process');

const shutdown = async () => {
  await Promise.allSettled([
    analysisWorker.close(),
    renderWorker.close(),
    n8nWorker.close(),
    mediaWorker.close(),
  ]);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
