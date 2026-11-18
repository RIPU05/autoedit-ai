import type {
  MediaApiJobStatus,
  ResolveMediaSourceResponse,
} from '@autoedit/contracts';

export const ACTIVE_MEDIA_JOB_STORAGE_KEY = 'autoedit_active_media_job_v1';
export const ACTIVE_PRIVATE_RENDER_STORAGE_PREFIX = 'autoedit_active_priv_render_v1_';
export const MEDIA_TAB_SYNC_CHANNEL = 'autoedit_media_job_sync_v1';

/**
 * Honest free-beta resource limits surfaced clearly in the UI.
 * No billing, no subscription checkout, no "unlimited" promises.
 */
export const FREE_BETA_LIMITS = {
  maxVodDurationMinutes: 60,
  maxHighlightSourceMb: 500,
  maxDirectUploadGb: 5,
  maxActiveJobs: 5,
  maxDailyJobs: 50,
  maxActivePrivateRenders: 2,
  maxDailyClipRenders: 20,
  maxPrivateClipDurationSec: 180,
  signedUrlTtlMinutes: 5,
} as const;

export interface ActiveMediaJobRef {
  jobId: string;
  sourceLabel: string;
  savedAt: number;
}

export function isTerminalJobStatus(status: MediaApiJobStatus | string | undefined): boolean {
  return status === 'READY' || status === 'FAILED' || status === 'CANCELLED';
}

/**
 * Bounded polling cadence with exponential backoff on transient network errors.
 * Returns `null` when polling MUST stop (terminal job state).
 */
export function computeNextPollDelayMs(params: {
  status?: MediaApiJobStatus;
  pollCount: number;
  consecutiveErrors: number;
}): number | null {
  if (isTerminalJobStatus(params.status)) {
    return null;
  }
  if (params.consecutiveErrors > 0) {
    return Math.min(15_000, 2_000 * Math.pow(2, Math.min(params.consecutiveErrors - 1, 3)));
  }
  if (params.pollCount < 3) return 1_200;
  if (params.pollCount < 10) return 2_000;
  return 3_000;
}

/**
 * Generates a stable idempotency key for a specific submission attempt so
 * double-clicks or retries never create duplicate shared/user jobs.
 */
export function createSubmissionIdempotencyKey(sourceDiscriminator: string): string {
  const clean = sourceDiscriminator
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 48);
  const nonce =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `ui_${clean}_${nonce}`;
}

/**
 * Client-side pre-flight URL guard blocking local/private-network/non-HTTP(S) URLs
 * before sending them to the backend (backend independently enforces full SSRF protection).
 */
export function validatePublicMediaUrlInput(rawUrl: string): { ok: true; url: string } | { ok: false; message: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, message: 'Paste a public YouTube, Twitch, or Kick URL first.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: 'Enter a valid full URL starting with https:// (for example, https://www.youtube.com/watch?v=...).' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, message: 'Only public http:// and https:// links are allowed.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return {
      ok: false,
      message: 'Local and private-network addresses are blocked for security. Paste a public YouTube, Twitch, or Kick link or upload a video file.',
    };
  }

  return { ok: true, url: parsed.toString() };
}

/**
 * Translates backend capability status into honest, friendly user-facing guidance.
 * Never fakes external acquisition or implies unsupported sources will process.
 */
export function describeCapabilityResult(resolved: ResolveMediaSourceResponse): {
  tone: 'ready' | 'unsupported' | 'warning';
  headline: string;
  body: string;
  technicalReason?: string;
  showUploadCta: boolean;
  contentKindLabel: string;
} {
  const providerLabel =
    resolved.provider === 'youtube'
      ? 'YouTube'
      : resolved.provider === 'twitch'
        ? 'Twitch'
        : resolved.provider === 'kick'
          ? 'Kick'
          : resolved.provider === 'upload'
            ? 'Uploaded video'
            : resolved.provider === 'direct_media'
              ? 'Authorized direct media'
              : 'Media source';

  const contentKindLabel = resolved.isClip
    ? 'Clip'
    : resolved.isLive || resolved.availability === 'LIVE_NOW'
      ? 'Live'
      : resolved.availability === 'OFFLINE'
        ? 'Offline channel'
        : resolved.sourceType === 'uploaded'
          ? 'Uploaded'
          : resolved.sourceType === 'live'
            ? 'Live channel'
            : 'Recorded VOD';

  switch (resolved.capabilityStatus) {
    case 'READY_TO_PROCESS':
      return {
        tone: 'ready',
        headline: `${providerLabel} ready for highlight detection`,
        body: resolved.reason || 'This source is authorized and ready to process.',
        showUploadCta: false,
        contentKindLabel,
      };
    case 'UNSUPPORTED_ACQUISITION':
      return {
        tone: 'unsupported',
        headline: `${providerLabel} ${contentKindLabel.toLowerCase()} recognized — URL capture not yet enabled`,
        body: `AutoAI Edit recognized this ${providerLabel} source and loaded its metadata, but automatic processing isn't available for ${providerLabel} URLs yet because live/VOD playback capture is not enabled in this build. Upload a local MP4/MOV video file to detect highlights and edit private clips now.`,
        technicalReason: resolved.reason,
        showUploadCta: true,
        contentKindLabel,
      };
    case 'BROADCAST_UNRESOLVED':
      return {
        tone: 'unsupported',
        headline:
          resolved.availability === 'OFFLINE'
            ? `${providerLabel} channel is currently offline`
            : `${providerLabel} live channel recognized — live URL capture not yet enabled`,
        body: `AutoAI Edit recognized this ${providerLabel} channel, but automatic processing isn't available for live ${providerLabel} URLs yet because live stream capture is not enabled in this build. Upload a local video recording to detect highlights and edit clips now.`,
        technicalReason: resolved.reason,
        showUploadCta: true,
        contentKindLabel,
      };
    case 'REQUIRES_PERMISSION':
      return {
        tone: 'warning',
        headline: 'Permission required for this source',
        body:
          resolved.reason ||
          'Permission could not be verified for this source. Upload a video you are authorized to edit.',
        showUploadCta: true,
        contentKindLabel,
      };
    case 'SOURCE_UNAVAILABLE':
    default:
      return {
        tone: 'warning',
        headline: 'Source unavailable',
        body:
          resolved.reason ||
          'This source could not be found or accessed for your account. Try uploading a video instead.',
        showUploadCta: true,
        contentKindLabel,
      };
  }
}

export function formatJobStageLabel(stage: string, status: MediaApiJobStatus): string {
  if (status === 'QUEUED') return 'Waiting in queue';
  if (status === 'READY') return 'Highlights ready';
  if (status === 'CANCELLED') return 'Cancelled by you';
  if (status === 'FAILED') return 'Processing failed';
  switch (stage) {
    case 'acquiring_source':
      return 'Preparing verified source footage';
    case 'analyzing_highlights':
      return 'Detecting highlight moments';
    case 'generating_base_clips':
      return 'Rendering highlight clip previews';
    case 'ready_cached':
      return 'Loaded verified cached highlights';
    case 'recovering_after_worker_crash':
      return 'Recovering job automatically';
    default:
      if (stage.startsWith('streaming_live_')) {
        return 'Streaming live highlights as they arrive';
      }
      return stage.replace(/_/g, ' ');
  }
}

export function formatMediaApiError(err: any): {
  message: string;
  retryable: boolean;
  requiresLogin: boolean;
} {
  const status = typeof err?.status === 'number' ? err.status : 0;
  const code = typeof err?.data?.code === 'string' ? err.data.code : undefined;
  const rawMsg = typeof err?.message === 'string' ? err.message : 'Something went wrong.';

  if (status === 401) {
    return {
      message: 'Your session expired. Please sign in again to continue.',
      retryable: false,
      requiresLogin: true,
    };
  }
  if (status === 429) {
    return {
      message:
        rawMsg ||
        `Free beta limit reached (${FREE_BETA_LIMITS.maxActiveJobs} active jobs, ${FREE_BETA_LIMITS.maxDailyJobs} daily submissions). Please wait a moment and try again.`,
      retryable: true,
      requiresLogin: false,
    };
  }
  if (status === 403 || code === 'ACCESS_DENIED' || code === 'SSRF_BLOCKED' || code === 'PRIVATE_NETWORK_BLOCKED') {
    return {
      message: rawMsg || 'Access denied for this media source.',
      retryable: false,
      requiresLogin: false,
    };
  }
  if (status === 404) {
    return {
      message: 'That job or project was not found for your account.',
      retryable: false,
      requiresLogin: false,
    };
  }
  if (status === 422 || code === 'UNSUPPORTED_ACQUISITION') {
    return {
      message: "This source is recognized, but automatic processing isn't available for it yet. You can upload a video you are authorized to use.",
      retryable: false,
      requiresLogin: false,
    };
  }
  if (status === 0 || status === 408 || status >= 500) {
    return {
      message: 'Temporary connection issue — we will retry automatically, or you can retry now.',
      retryable: true,
      requiresLogin: false,
    };
  }
  return {
    message: rawMsg,
    retryable: false,
    requiresLogin: false,
  };
}

export function formatTimestampRange(startSec: number, endSec: number): string {
  const fmt = (sec: number) => {
    const clamped = Math.max(0, Math.floor(sec));
    const m = Math.floor(clamped / 60);
    const s = clamped % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  return `${fmt(startSec)} – ${fmt(endSec)}`;
}

/**
 * Persists ONLY an opaque active job ID + label in sessionStorage so refreshing
 * the browser resumes status polling via authenticated GET /api/media/jobs/:jobId.
 * NEVER stores signed download URLs, storage keys, or private media data.
 */
export function saveActiveMediaJobRef(ref: ActiveMediaJobRef): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      ACTIVE_MEDIA_JOB_STORAGE_KEY,
      JSON.stringify({
        jobId: ref.jobId,
        sourceLabel: ref.sourceLabel.slice(0, 120),
        savedAt: ref.savedAt,
      }),
    );
  } catch {
    // Ignore storage quota or private-mode errors
  }
}

export function loadActiveMediaJobRef(): ActiveMediaJobRef | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_MEDIA_JOB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveMediaJobRef>;
    if (typeof parsed.jobId !== 'string' || !/^[a-zA-Z0-9_-]{4,128}$/.test(parsed.jobId)) {
      return null;
    }
    return {
      jobId: parsed.jobId,
      sourceLabel: typeof parsed.sourceLabel === 'string' ? parsed.sourceLabel : 'Media job',
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function clearActiveMediaJobRef(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(ACTIVE_MEDIA_JOB_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function formatPrivateRenderStageLabel(stage: string, status: MediaApiJobStatus): string {
  if (status === 'QUEUED') {
    if (stage === 'retrying') return 'Retrying private render';
    if (stage === 'recovering_after_worker_crash') return 'Recovering private render automatically';
    return 'Waiting in private render queue';
  }
  if (status === 'READY') return 'Private MP4 verified & ready';
  if (status === 'CANCELLED') return 'Private render cancelled';
  if (status === 'FAILED') return 'Private render failed';
  switch (stage) {
    case 'preparing_source':
      return 'Verifying source footage';
    case 'rendering_clip':
      return 'Encoding private MP4 clip';
    case 'validating_output':
      return 'Validating MP4 streams with FFmpeg';
    case 'uploading_output':
      return 'Saving private MP4 securely';
    default:
      return stage.replace(/_/g, ' ');
  }
}

export interface ActivePrivateRenderRef {
  projectId: string;
  renderJobId: string;
  savedAt: number;
}

/**
 * Stores ONLY an opaque private render job ID for a project in sessionStorage so
 * refreshing resumes background status polling. NEVER stores signed URLs or storage keys.
 */
export function saveActivePrivateRenderRef(projectId: string, renderJobId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      `${ACTIVE_PRIVATE_RENDER_STORAGE_PREFIX}${projectId}`,
      JSON.stringify({ projectId, renderJobId, savedAt: Date.now() }),
    );
  } catch {
    // ignore
  }
}

export function loadActivePrivateRenderRef(projectId: string): ActivePrivateRenderRef | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(`${ACTIVE_PRIVATE_RENDER_STORAGE_PREFIX}${projectId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActivePrivateRenderRef>;
    if (
      parsed.projectId !== projectId ||
      typeof parsed.renderJobId !== 'string' ||
      !/^[a-zA-Z0-9_-]{4,128}$/.test(parsed.renderJobId)
    ) {
      return null;
    }
    return {
      projectId,
      renderJobId: parsed.renderJobId,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function clearActivePrivateRenderRef(projectId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(`${ACTIVE_PRIVATE_RENDER_STORAGE_PREFIX}${projectId}`);
  } catch {
    // ignore
  }
}

export function areSignedLinksStale(fetchedAtMs: number | null, ttlSec = 300): boolean {
  if (!fetchedAtMs) return false;
  const safeMarginMs = Math.max(15_000, Math.min(45_000, Math.floor((ttlSec * 1000) * 0.15)));
  return Date.now() - fetchedAtMs >= ttlSec * 1000 - safeMarginMs;
}

export interface MediaTabSyncMessage {
  jobId: string;
  status: MediaApiJobStatus;
  ts: number;
}

/**
 * Broadcasts an opaque job status hint across tabs of the same browser session.
 * Contains ONLY `{ jobId, status, ts }` — NEVER signed URLs, cookies, or storage keys.
 */
export function broadcastMediaJobSync(msg: MediaTabSyncMessage): void {
  if (typeof window === 'undefined') return;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(MEDIA_TAB_SYNC_CHANNEL);
      ch.postMessage(msg);
      ch.close();
    }
  } catch {
    // ignore unsupported BroadcastChannel environments
  }
}

export function subscribeMediaJobSync(
  handler: (msg: MediaTabSyncMessage) => void,
): () => void {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return () => {};
  }
  try {
    const ch = new BroadcastChannel(MEDIA_TAB_SYNC_CHANNEL);
    const onMsg = (ev: MessageEvent) => {
      const data = ev.data as Partial<MediaTabSyncMessage> | null;
      if (
        data &&
        typeof data.jobId === 'string' &&
        /^[a-zA-Z0-9_-]{4,128}$/.test(data.jobId) &&
        typeof data.status === 'string' &&
        typeof data.ts === 'number'
      ) {
        handler(data as MediaTabSyncMessage);
      }
    };
    ch.addEventListener('message', onMsg);
    return () => {
      ch.removeEventListener('message', onMsg);
      ch.close();
    };
  } catch {
    return () => {};
  }
}
