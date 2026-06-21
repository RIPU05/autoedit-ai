import { env } from './config/env.js';
import { createApp } from './app.js';
import { startMemorySampler } from './lib/observability.js';

startMemorySampler();

const app = createApp();

app.listen(env.API_PORT, () => {
  console.log(`AutoEdit API listening on :${env.API_PORT}`);
});
