import { Redis } from 'ioredis';
import type { ConnectionOptions } from 'bullmq';
import { env } from '../config/env.js';

// BullMQ requires maxRetriesPerRequest: null for blocking connections.
export const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

// BullMQ bundles its own ioredis types, so passing our ioredis@5 instance trips
// a duplicate-identity type error. This alias casts once; runtime is unchanged
// (BullMQ accepts an existing ioredis client as its connection).
export const bullConnection = connection as unknown as ConnectionOptions;
