import { MediaSourceError } from '../errors.js';
import type { ControlledVodAcquisitionAdapter } from '../vod/controlled-vod.adapter.js';
import type { ControlledRealTimeStreamAdapter } from '../live/controlled-stream.adapter.js';

export type RegisteredControlledFixture =
  | {
      kind: 'vod';
      fixtureKey: string;
      canonicalSourceId: string;
      adapter: ControlledVodAcquisitionAdapter;
      /** Optional test hook invoked on first worker attempt (for crash/retry tests). */
      onWorkerAttempt?: (attemptNumber: number) => Promise<void>;
    }
  | {
      kind: 'live';
      fixtureKey: string;
      canonicalSourceId: string;
      adapter: ControlledRealTimeStreamAdapter;
      onWorkerAttempt?: (attemptNumber: number) => Promise<void>;
    };

const registry = new Map<string, RegisteredControlledFixture>();

/**
 * Controlled test fixtures are STRICTLY inaccessible in production mode,
 * regardless of any other environment variable or request header.
 */
export function areControlledFixturesEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  return (
    process.env.ALLOW_CONTROLLED_MEDIA_FIXTURES === 'true' ||
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_ENV === 'development'
  );
}

export function assertControlledFixturesAllowed(): void {
  if (!areControlledFixturesEnabled()) {
    throw new MediaSourceError({
      code: 'UNSUPPORTED_ACQUISITION',
      message: 'Controlled test media fixtures are disabled in this environment.',
      statusCode: 403,
    });
  }
}

export function registerControlledTestFixture(entry: RegisteredControlledFixture): void {
  assertControlledFixturesAllowed();
  registry.set(entry.fixtureKey, entry);
}

export function getControlledTestFixture(fixtureKey: string): RegisteredControlledFixture | null {
  if (!areControlledFixturesEnabled()) {
    return null;
  }
  return registry.get(fixtureKey) ?? null;
}

export function unregisterControlledTestFixture(fixtureKey: string): void {
  registry.delete(fixtureKey);
}

export function clearControlledTestFixtures(): void {
  registry.clear();
}
