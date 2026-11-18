import { describe, expect, it } from 'vitest';
import {
  computeNextPollDelayMs,
  createSubmissionIdempotencyKey,
  describeCapabilityResult,
  formatJobStageLabel,
  formatMediaApiError,
  formatTimestampRange,
  isTerminalJobStatus,
  validatePublicMediaUrlInput,
} from '../../../web/src/lib/media-workspace.js';

describe('Step 3C.1: Universal Media Workspace Frontend Helpers', () => {
  it('validates public URLs and blocks local/private-network & non-HTTP schemes', () => {
    expect(validatePublicMediaUrlInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ').ok).toBe(true);
    expect(validatePublicMediaUrlInput('https://www.twitch.tv/videos/1234567890').ok).toBe(true);
    expect(validatePublicMediaUrlInput('https://kick.com/video/11111111-2222-3333-4444-555555555555').ok).toBe(true);

    for (const bad of [
      '',
      'not-a-url',
      'file:///etc/passwd',
      'http://127.0.0.1:4000/health',
      'http://localhost:3000/dashboard',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/video.mp4',
      'http://192.168.1.10/video.mp4',
      'http://172.16.0.1/video.mp4',
    ]) {
      const res = validatePublicMediaUrlInput(bad);
      expect(res.ok).toBe(false);
    }
  });

  it('produces honest capability copy without faking unsupported external acquisition', () => {
    const yt = describeCapabilityResult({
      capabilityStatus: 'UNSUPPORTED_ACQUISITION',
      provider: 'youtube',
      sourceType: 'vod',
      identityScope: 'IMMUTABLE_VOD',
      canSubmitJob: false,
      reason: 'Unsupported',
      supportedActions: ['upload_video'],
    });
    expect(yt.tone).toBe('unsupported');
    expect(yt.body).toContain("automatic processing isn't available");
    expect(yt.showUploadCta).toBe(true);

    const ready = describeCapabilityResult({
      capabilityStatus: 'READY_TO_PROCESS',
      provider: 'upload',
      sourceType: 'uploaded',
      identityScope: 'IMMUTABLE_UPLOAD',
      canSubmitJob: true,
      reason: 'Ready',
      supportedActions: ['submit_job'],
    });
    expect(ready.tone).toBe('ready');
    expect(ready.showUploadCta).toBe(false);
  });

  it('stops polling on terminal job states and backs off exponentially on transient errors', () => {
    expect(isTerminalJobStatus('READY')).toBe(true);
    expect(isTerminalJobStatus('FAILED')).toBe(true);
    expect(isTerminalJobStatus('CANCELLED')).toBe(true);
    expect(isTerminalJobStatus('QUEUED')).toBe(false);
    expect(isTerminalJobStatus('RUNNING')).toBe(false);

    expect(computeNextPollDelayMs({ status: 'READY', pollCount: 1, consecutiveErrors: 0 })).toBeNull();
    expect(computeNextPollDelayMs({ status: 'FAILED', pollCount: 1, consecutiveErrors: 0 })).toBeNull();
    expect(computeNextPollDelayMs({ status: 'CANCELLED', pollCount: 1, consecutiveErrors: 0 })).toBeNull();

    expect(computeNextPollDelayMs({ status: 'QUEUED', pollCount: 0, consecutiveErrors: 0 })).toBe(1200);
    expect(computeNextPollDelayMs({ status: 'RUNNING', pollCount: 5, consecutiveErrors: 0 })).toBe(2000);
    expect(computeNextPollDelayMs({ status: 'RUNNING', pollCount: 12, consecutiveErrors: 0 })).toBe(3000);

    // Backoff on transient network errors, capped at 15s
    expect(computeNextPollDelayMs({ status: 'RUNNING', pollCount: 2, consecutiveErrors: 1 })).toBe(2000);
    expect(computeNextPollDelayMs({ status: 'RUNNING', pollCount: 2, consecutiveErrors: 2 })).toBe(4000);
    expect(computeNextPollDelayMs({ status: 'RUNNING', pollCount: 2, consecutiveErrors: 3 })).toBe(8000);
    expect(computeNextPollDelayMs({ status: 'RUNNING', pollCount: 2, consecutiveErrors: 8 })).toBe(15000);
  });

  it('formats idempotency keys, timestamps, stages, and API errors cleanly', () => {
    const k1 = createSubmissionIdempotencyKey('up_proj123');
    const k2 = createSubmissionIdempotencyKey('up_proj123');
    expect(k1).toMatch(/^ui_up_proj123_[a-zA-Z0-9_]+$/);
    expect(k1).not.toBe(k2);

    expect(formatTimestampRange(12, 75)).toBe('0:12 – 1:15');
    expect(formatJobStageLabel('queued', 'QUEUED')).toBe('Waiting in queue');
    expect(formatJobStageLabel('analyzing_highlights', 'RUNNING')).toBe('Detecting highlight moments');
    expect(formatJobStageLabel('streaming_live_2_highlights', 'RUNNING')).toContain('Streaming live');

    expect(formatMediaApiError({ status: 401, message: 'unauthorized' }).requiresLogin).toBe(true);
    expect(formatMediaApiError({ status: 429, message: '' }).retryable).toBe(true);
    expect(formatMediaApiError({ status: 503, message: 'down' }).retryable).toBe(true);
    expect(formatMediaApiError({ status: 422, data: { code: 'UNSUPPORTED_ACQUISITION' } }).message).toContain(
      "isn't available",
    );
  });
});
