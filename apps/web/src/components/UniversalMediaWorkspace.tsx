'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  MediaHighlightItem,
  MediaJobResponse,
  ResolveMediaSourceResponse,
  UniversalMediaInput,
} from '@autoedit/contracts';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  Film,
  Link2,
  Loader2,
  RefreshCw,
  Scissors,
  Sparkles,
  Upload,
  XCircle,
} from 'lucide-react';
import { media as mediaApi } from '@/lib/api';
import {
  FREE_BETA_LIMITS,
  areSignedLinksStale,
  broadcastMediaJobSync,
  clearActiveMediaJobRef,
  computeNextPollDelayMs,
  createSubmissionIdempotencyKey,
  describeCapabilityResult,
  formatJobStageLabel,
  formatMediaApiError,
  formatTimestampRange,
  isTerminalJobStatus,
  loadActiveMediaJobRef,
  saveActiveMediaJobRef,
  subscribeMediaJobSync,
  validatePublicMediaUrlInput,
} from '@/lib/media-workspace';
import { cn } from '@/lib/utils';

export interface UploadedProjectOption {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  sourceAsset?: {
    id: string;
    durationSec?: number | null;
    width?: number | null;
    height?: number | null;
  } | null;
}

type InputTab = 'url' | 'existing_upload';

const STATUS_BADGE: Record<string, string> = {
  QUEUED: 'border-edge bg-ink text-white/70',
  RUNNING: 'border-accent/50 bg-accent/10 text-accent',
  READY: 'border-signal/50 bg-signal/10 text-signal',
  FAILED: 'border-warn/50 bg-warn/10 text-warn',
  CANCELLED: 'border-edge bg-ink text-white/50',
};

export function UniversalMediaWorkspace({
  uploadedProjects,
  initialJobId,
  onRequestNewUpload,
  onProjectCreated,
}: {
  uploadedProjects: UploadedProjectOption[];
  initialJobId?: string | null;
  onRequestNewUpload?: () => void;
  onProjectCreated?: (projectId: string, highlightId?: string) => void;
}) {
  const router = useRouter();

  const eligibleUploads = useMemo(
    () => uploadedProjects.filter((p) => Boolean(p.sourceAsset?.id)),
    [uploadedProjects],
  );

  // Input selection state
  const [tab, setTab] = useState<InputTab>('url');
  const [urlInput, setUrlInput] = useState('');
  const [selectedUploadProjectId, setSelectedUploadProjectId] = useState<string>('');
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<ResolveMediaSourceResponse | null>(null);
  const [resolvedInput, setResolvedInput] = useState<UniversalMediaInput | null>(null);
  const [resolvedSourceLabel, setResolvedSourceLabel] = useState<string>('');
  const [inputError, setInputError] = useState<string | null>(null);

  // Stable per-submission idempotency key & double-submit lock
  const [pendingIdempotencyKey, setPendingIdempotencyKey] = useState<string | null>(null);
  const submitLockRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  // Active job + polling state
  const [job, setJob] = useState<MediaJobResponse | null>(null);
  const [jobSourceLabel, setJobSourceLabel] = useState<string>('');
  const [pollNotice, setPollNotice] = useState<string | null>(null);
  const [pollExhausted, setPollExhausted] = useState(false);
  const [pollEpoch, setPollEpoch] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [cancelFeedback, setCancelFeedback] = useState<string | null>(null);

  // Highlights + project handoff state (signed URLs are kept ONLY in memory, never persisted!)
  const [highlights, setHighlights] = useState<MediaHighlightItem[]>([]);
  const [highlightsLoading, setHighlightsLoading] = useState(false);
  const [highlightsError, setHighlightsError] = useState<string | null>(null);
  const [refreshingLinks, setRefreshingLinks] = useState(false);
  const [creatingProjectFor, setCreatingProjectFor] = useState<string | null>(null);
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const autoRetriedHighlightIdsRef = useRef<Set<string>>(new Set());
  const activeJobIdRef = useRef<string | null>(null);
  const jobEpochRef = useRef(0);
  const linksFetchedAtRef = useRef<number | null>(null);
  const linksTtlSecRef = useRef<number>(300);

  useEffect(() => {
    activeJobIdRef.current = job?.jobId ?? null;
  }, [job?.jobId]);

  // Keep selected upload synchronized when projects list loads
  useEffect(() => {
    if (!selectedUploadProjectId && eligibleUploads.length > 0) {
      setSelectedUploadProjectId(eligibleUploads[0].id);
    }
  }, [eligibleUploads, selectedUploadProjectId]);

  const handleAuthRedirect = useCallback(() => {
    const nextPath =
      typeof window !== 'undefined'
        ? `${window.location.pathname}${window.location.search}`
        : '/dashboard';
    router.push(`/login?next=${encodeURIComponent(nextPath)}`);
  }, [router]);

  const syncJobUrlParam = useCallback((jobId: string | null) => {
    if (typeof window === 'undefined') return;
    try {
      const u = new URL(window.location.href);
      if (jobId) u.searchParams.set('job', jobId);
      else u.searchParams.delete('job');
      window.history.replaceState({}, '', `${u.pathname}${u.search}`);
    } catch {
      // ignore history errors
    }
  }, []);

  const fetchHighlights = useCallback(
    async (jobId: string, opts: { silent?: boolean } = {}) => {
      const epochAtStart = jobEpochRef.current;
      if (!opts.silent) setHighlightsLoading(true);
      setHighlightsError(null);
      try {
        const res = await mediaApi.getJobHighlights(jobId);
        // Discard stale async response if user switched to another job or dismissed!
        if (activeJobIdRef.current !== jobId || jobEpochRef.current !== epochAtStart) return;
        const list = res.highlights ?? [];
        setHighlights(list);
        linksFetchedAtRef.current = Date.now();
        linksTtlSecRef.current = list[0]?.downloadUrlExpiresInSec ?? 300;
        autoRetriedHighlightIdsRef.current.clear();
      } catch (err: any) {
        if (activeJobIdRef.current !== jobId || jobEpochRef.current !== epochAtStart) return;
        const parsed = formatMediaApiError(err);
        if (parsed.requiresLogin) {
          handleAuthRedirect();
          return;
        }
        // Revoked rights (403) or deleted job (404) -> clear stale highlight URLs immediately!
        if (err?.status === 403 || err?.status === 404) {
          setHighlights([]);
          linksFetchedAtRef.current = null;
        }
        setHighlightsError(parsed.message);
      } finally {
        if (!opts.silent && activeJobIdRef.current === jobId && jobEpochRef.current === epochAtStart) {
          setHighlightsLoading(false);
        }
      }
    },
    [handleAuthRedirect],
  );

  // Resume existing job on mount or initialJobId switch (from ?job=<jobId> or sessionStorage opaque ID)
  useEffect(() => {
    let active = true;
    const savedRef = loadActiveMediaJobRef();
    const queryJobId =
      initialJobId ||
      (typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('job')
        : null);
    const resumeJobId = queryJobId || savedRef?.jobId || null;
    if (!resumeJobId) return;

    const resumeLabel =
      savedRef && savedRef.jobId === resumeJobId ? savedRef.sourceLabel : 'Resumed media job';

    const switchEpoch = ++jobEpochRef.current;
    activeJobIdRef.current = resumeJobId;
    setHighlights([]);
    setHighlightsError(null);
    setCancelFeedback(null);
    setPollNotice(null);
    setPollExhausted(false);

    (async () => {
      try {
        const status = await mediaApi.getJobStatus(resumeJobId);
        if (!active || jobEpochRef.current !== switchEpoch) return;
        setJob(status);
        activeJobIdRef.current = status.jobId;
        setJobSourceLabel(resumeLabel);
        saveActiveMediaJobRef({
          jobId: status.jobId,
          sourceLabel: resumeLabel,
          savedAt: Date.now(),
        });
        syncJobUrlParam(status.jobId);
        if (status.status === 'READY' || (status.status === 'RUNNING' && status.highlightsCount > 0)) {
          await fetchHighlights(status.jobId);
        }
      } catch (err: any) {
        if (!active || jobEpochRef.current !== switchEpoch) return;
        const parsed = formatMediaApiError(err);
        if (parsed.requiresLogin) {
          handleAuthRedirect();
          return;
        }
        // 404 (cleaned up or belongs to another account) -> clear stale local ref safely
        if (err?.status === 404) {
          clearActiveMediaJobRef();
          syncJobUrlParam(null);
          activeJobIdRef.current = null;
          setJob(null);
          setInputError(
            queryJobId
              ? 'That media job was not found for your account.'
              : 'Your previous media job is no longer available after cleanup. Submit a new source below.',
          );
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [initialJobId, fetchHighlights, handleAuthRedirect, syncJobUrlParam]);

  // Multi-tab sync: if another tab cancels or updates the SAME jobId, re-fetch authoritative status from server!
  // Never clobbers a tab that is viewing a DIFFERENT jobId.
  useEffect(() => {
    return subscribeMediaJobSync((msg) => {
      if (!activeJobIdRef.current || msg.jobId !== activeJobIdRef.current) return;
      const expectedEpoch = jobEpochRef.current;
      void (async () => {
        try {
          const fresh = await mediaApi.getJobStatus(msg.jobId);
          if (activeJobIdRef.current !== msg.jobId || jobEpochRef.current !== expectedEpoch) return;
          setJob(fresh);
          if (fresh.status === 'READY' || (fresh.status === 'RUNNING' && fresh.highlightsCount > 0)) {
            await fetchHighlights(fresh.jobId, { silent: true });
          }
        } catch (err: any) {
          if (err?.status === 401) handleAuthRedirect();
        }
      })();
    });
  }, [fetchHighlights, handleAuthRedirect]);

  // Auto-refresh expired highlight signed links when user returns to an idle tab
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      const currentJobId = activeJobIdRef.current;
      if (
        currentJobId &&
        highlights.length > 0 &&
        areSignedLinksStale(linksFetchedAtRef.current, linksTtlSecRef.current)
      ) {
        void fetchHighlights(currentJobId, { silent: true });
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [highlights.length, fetchHighlights]);

  // Bounded polling loop for active (QUEUED / RUNNING) jobs — stops immediately on terminal status!
  useEffect(() => {
    if (!job || isTerminalJobStatus(job.status)) return;

    const trackedJobId = job.jobId;
    const trackedEpoch = jobEpochRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollCount = 0;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 12;

    const tick = async () => {
      if (cancelled || activeJobIdRef.current !== trackedJobId || jobEpochRef.current !== trackedEpoch) return;
      pollCount++;
      try {
        const next = await mediaApi.getJobStatus(trackedJobId);
        if (cancelled || activeJobIdRef.current !== trackedJobId || jobEpochRef.current !== trackedEpoch) return;
        consecutiveErrors = 0;
        setPollNotice(null);
        setPollExhausted(false);
        setJob(next);

        if (isTerminalJobStatus(next.status)) {
          broadcastMediaJobSync({ jobId: next.jobId, status: next.status, ts: Date.now() });
        }

        if (
          next.status === 'READY' ||
          (next.status === 'RUNNING' && next.highlightsCount > 0)
        ) {
          await fetchHighlights(next.jobId, { silent: next.status === 'RUNNING' });
        }

        const delay = computeNextPollDelayMs({
          status: next.status,
          pollCount,
          consecutiveErrors: 0,
        });
        if (delay !== null && !cancelled) {
          timer = setTimeout(tick, delay);
        }
      } catch (err: any) {
        if (cancelled || activeJobIdRef.current !== trackedJobId || jobEpochRef.current !== trackedEpoch) return;
        const parsed = formatMediaApiError(err);
        if (parsed.requiresLogin) {
          handleAuthRedirect();
          return;
        }
        if (err?.status === 404) {
          clearActiveMediaJobRef();
          syncJobUrlParam(null);
          activeJobIdRef.current = null;
          setJob(null);
          setHighlights([]);
          setInputError('That media job is no longer available for your account.');
          return;
        }
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          setPollExhausted(true);
          setPollNotice(
            'Unable to reach server after multiple retries. Your job continues safely on the server — click Check Status to reconnect.',
          );
          return;
        }
        setPollNotice(
          `Connection interrupted while checking progress (retry ${consecutiveErrors}). Your job keeps running safely on the server.`,
        );
        const delay = computeNextPollDelayMs({
          status: job.status,
          pollCount,
          consecutiveErrors,
        });
        if (delay !== null && !cancelled) {
          timer = setTimeout(tick, delay);
        }
      }
    };

    const initialDelay = computeNextPollDelayMs({
      status: job.status,
      pollCount: 0,
      consecutiveErrors: 0,
    });
    if (initialDelay !== null) {
      timer = setTimeout(tick, initialDelay);
    }

    const onRecoverConnectivity = () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, 250);
    };
    window.addEventListener('online', onRecoverConnectivity);
    document.addEventListener('visibilitychange', onRecoverConnectivity);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', onRecoverConnectivity);
      document.removeEventListener('visibilitychange', onRecoverConnectivity);
    };
  }, [job?.jobId, job?.status, pollEpoch, fetchHighlights, handleAuthRedirect, syncJobUrlParam]);

  async function resolveCurrentInput(overrideInput?: {
    input: UniversalMediaInput;
    label: string;
    discriminator: string;
  }) {
    setInputError(null);
    setCancelFeedback(null);
    setProjectActionError(null);

    let inputToResolve: UniversalMediaInput;
    let label: string;
    let discriminator: string;

    if (overrideInput) {
      inputToResolve = overrideInput.input;
      label = overrideInput.label;
      discriminator = overrideInput.discriminator;
    } else if (tab === 'url') {
      const checked = validatePublicMediaUrlInput(urlInput);
      if (!checked.ok) {
        setInputError(checked.message);
        setResolved(null);
        setResolvedInput(null);
        return;
      }
      inputToResolve = { inputType: 'url', url: checked.url };
      label = checked.url;
      discriminator = `url_${checked.url.slice(-24)}`;
    } else {
      if (!selectedUploadProjectId) {
        setInputError('Choose an uploaded video project first, or upload a new video.');
        return;
      }
      const chosen = eligibleUploads.find((p) => p.id === selectedUploadProjectId);
      inputToResolve = { inputType: 'upload', projectId: selectedUploadProjectId };
      label = chosen?.title || 'Uploaded video';
      discriminator = `up_${selectedUploadProjectId}`;
    }

    setResolving(true);
    try {
      const result = await mediaApi.resolveSource(inputToResolve);
      setResolved(result);
      setResolvedInput(inputToResolve);
      setResolvedSourceLabel(result.title || label);
      setPendingIdempotencyKey(createSubmissionIdempotencyKey(discriminator));
    } catch (err: any) {
      const parsed = formatMediaApiError(err);
      if (parsed.requiresLogin) {
        handleAuthRedirect();
        return;
      }
      setResolved(null);
      setResolvedInput(null);
      setInputError(parsed.message);
    } finally {
      setResolving(false);
    }
  }

  async function handleSubmitJob() {
    if (!resolved || !resolved.canSubmitJob || !resolvedInput) return;
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmitting(true);
    setInputError(null);
    setCancelFeedback(null);
    setHighlightsError(null);
    setProjectActionError(null);

    const idemKey =
      pendingIdempotencyKey || createSubmissionIdempotencyKey(resolvedSourceLabel || 'media');
    if (!pendingIdempotencyKey) setPendingIdempotencyKey(idemKey);

    try {
      const submitted = await mediaApi.submitJob({
        input: resolvedInput,
        idempotencyKey: idemKey,
      });
      ++jobEpochRef.current;
      activeJobIdRef.current = submitted.jobId;
      linksFetchedAtRef.current = null;
      setJob(submitted);
      setJobSourceLabel(resolvedSourceLabel || 'Media job');
      setHighlights([]);
      setPollNotice(null);
      setPollExhausted(false);
      saveActiveMediaJobRef({
        jobId: submitted.jobId,
        sourceLabel: resolvedSourceLabel || 'Media job',
        savedAt: Date.now(),
      });
      syncJobUrlParam(submitted.jobId);
      broadcastMediaJobSync({ jobId: submitted.jobId, status: submitted.status, ts: Date.now() });

      if (submitted.status === 'READY') {
        await fetchHighlights(submitted.jobId);
      }
    } catch (err: any) {
      const parsed = formatMediaApiError(err);
      if (parsed.requiresLogin) {
        handleAuthRedirect();
        return;
      }
      setInputError(parsed.message);
    } finally {
      setSubmitting(false);
      submitLockRef.current = false;
    }
  }

  async function handleCancelJob() {
    if (!job || cancelling || isTerminalJobStatus(job.status)) return;
    setCancelling(true);
    setCancelFeedback(null);
    try {
      const res = await mediaApi.cancelJob(job.jobId);
      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: res.status,
              stage: res.status === 'CANCELLED' ? 'cancelled' : prev.stage,
            }
          : prev,
      );
      broadcastMediaJobSync({ jobId: job.jobId, status: res.status, ts: Date.now() });
      if (res.alreadyCompleted && res.status === 'READY') {
        setCancelFeedback('Your job already completed before cancellation — highlights are ready below.');
        await fetchHighlights(job.jobId);
      } else if (res.sharedWorkStillActive) {
        setCancelFeedback(
          'Your job was cancelled. Shared processing for other clippers remains active.',
        );
      } else {
        setCancelFeedback('Job cancelled cleanly.');
      }
    } catch (err: any) {
      const parsed = formatMediaApiError(err);
      if (parsed.requiresLogin) {
        handleAuthRedirect();
        return;
      }
      setCancelFeedback(parsed.message);
    } finally {
      setCancelling(false);
    }
  }

  async function handleRefreshHighlightLinks() {
    if (!job || refreshingLinks) return;
    setRefreshingLinks(true);
    try {
      await fetchHighlights(job.jobId);
    } finally {
      setRefreshingLinks(false);
    }
  }

  async function handleVideoError(highlightId: string) {
    if (!job || autoRetriedHighlightIdsRef.current.has(highlightId)) return;
    autoRetriedHighlightIdsRef.current.add(highlightId);
    await fetchHighlights(job.jobId, { silent: true });
  }

  async function handleOpenPrivateProject(highlight?: MediaHighlightItem) {
    if (!job || creatingProjectFor) return;
    const key = highlight?.highlightId ?? 'manual';
    setCreatingProjectFor(key);
    setProjectActionError(null);
    try {
      const title = highlight
        ? `${jobSourceLabel || 'Clip'} (${formatTimestampRange(highlight.windowStartSec, highlight.windowEndSec)})`
        : `${jobSourceLabel || 'Clip Project'}`;
      const created = await mediaApi.createProjectFromSource({
        jobId: job.jobId,
        title: title.slice(0, 180),
      });
      if (onProjectCreated) {
        onProjectCreated(created.projectId, highlight?.highlightId);
      } else {
        const qs = highlight ? `?highlight=${encodeURIComponent(highlight.highlightId)}` : '';
        router.push(`/projects/${created.projectId}${qs}`);
      }
    } catch (err: any) {
      const parsed = formatMediaApiError(err);
      if (parsed.requiresLogin) {
        handleAuthRedirect();
        return;
      }
      setProjectActionError(parsed.message);
    } finally {
      setCreatingProjectFor(null);
    }
  }

  const capabilityInfo = resolved ? describeCapabilityResult(resolved) : null;

  return (
    <section
      aria-label="Universal Media Input and Highlight Workspace"
      data-testid="universal-media-workspace"
      className="rounded-xl border border-edge bg-panel p-5 sm:p-6 space-y-5"
    >
      {/* Header + Honest Beta Limits */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-accent shrink-0" />
            <h2 className="font-display text-lg text-white">Universal Media Input</h2>
          </div>
          <p className="text-xs sm:text-sm text-white/55 mt-1">
            Paste a public YouTube, Twitch, or Kick link — or pick an uploaded video — to detect highlights and edit private MP4 clips. No streamer login required.
          </p>
        </div>
        <span className="self-start shrink-0 rounded-full border border-edge bg-ink px-3 py-1 font-mono text-[11px] text-white/60">
          Private MP4 Export
        </span>
      </div>

      {/* Free Beta Limits Banner (Honest, no billing/checkout, no unlimited promises) */}
      <div
        data-testid="free-beta-limits"
        className="rounded-lg border border-edge bg-ink/70 px-3.5 py-2.5 text-xs text-white/55 flex flex-wrap gap-x-4 gap-y-1"
      >
        <span className="font-mono text-white/70">Free Beta Limits:</span>
        <span>Up to {FREE_BETA_LIMITS.maxVodDurationMinutes} min duration</span>
        <span>Max {FREE_BETA_LIMITS.maxHighlightSourceMb} MB highlight scan ({FREE_BETA_LIMITS.maxDirectUploadGb} GB direct upload)</span>
        <span>{FREE_BETA_LIMITS.maxActiveJobs} active / {FREE_BETA_LIMITS.maxDailyJobs} daily jobs</span>
        <span>{FREE_BETA_LIMITS.signedUrlTtlMinutes}-min private download links</span>
      </div>

      {/* Mode Tabs */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Media source mode">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'url'}
          onClick={() => {
            setTab('url');
            setResolved(null);
            setResolvedInput(null);
            setInputError(null);
          }}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs sm:text-sm font-medium transition-colors',
            tab === 'url'
              ? 'border-accent bg-accent/15 text-white'
              : 'border-edge bg-ink text-white/60 hover:text-white',
          )}
        >
          <Link2 className="w-4 h-4" />
          YouTube / Twitch / Kick URL
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={tab === 'existing_upload'}
          onClick={() => {
            setTab('existing_upload');
            setResolved(null);
            setResolvedInput(null);
            setInputError(null);
          }}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs sm:text-sm font-medium transition-colors',
            tab === 'existing_upload'
              ? 'border-accent bg-accent/15 text-white'
              : 'border-edge bg-ink text-white/60 hover:text-white',
          )}
        >
          <Film className="w-4 h-4" />
          Existing Upload ({eligibleUploads.length})
        </button>

        {onRequestNewUpload && (
          <button
            type="button"
            onClick={onRequestNewUpload}
            className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-ink px-3.5 py-2 text-xs sm:text-sm font-medium text-white/70 hover:border-accent/50 hover:text-white transition-colors"
          >
            <Upload className="w-4 h-4" />
            Upload New Video
          </button>
        )}
      </div>

      {/* Input Panel */}
      {tab === 'url' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void resolveCurrentInput();
          }}
          className="flex flex-col sm:flex-row gap-2.5"
        >
          <label htmlFor="universal-media-url" className="sr-only">
            YouTube, Twitch, or Kick video or livestream URL
          </label>
          <input
            id="universal-media-url"
            data-testid="universal-url-input"
            type="url"
            value={urlInput}
            onChange={(e) => {
              setUrlInput(e.target.value);
              setResolved(null);
              setResolvedInput(null);
              setInputError(null);
            }}
            placeholder="https://www.youtube.com/watch?v=... or twitch.tv/videos/... or kick.com/..."
            className="flex-1 min-w-0 rounded-lg border border-edge bg-ink px-3.5 py-2.5 text-sm text-white placeholder:text-white/35 outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={resolving || !urlInput.trim()}
            data-testid="resolve-source-btn"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-ink disabled:opacity-50 shrink-0"
          >
            {resolving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {resolving ? 'Checking…' : 'Check Source'}
          </button>
        </form>
      ) : (
        <div className="space-y-3">
          {eligibleUploads.length === 0 ? (
            <div className="rounded-lg border border-edge bg-ink p-4 text-sm text-white/60 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <span>No uploaded videos found yet. Upload an authorized MP4/MOV to detect highlights.</span>
              {onRequestNewUpload && (
                <button
                  type="button"
                  onClick={onRequestNewUpload}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-ink shrink-0"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Upload Video
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row gap-2.5">
              <label htmlFor="existing-upload-select" className="sr-only">
                Select an existing uploaded video
              </label>
              <select
                id="existing-upload-select"
                data-testid="existing-upload-select"
                value={selectedUploadProjectId}
                onChange={(e) => {
                  setSelectedUploadProjectId(e.target.value);
                  setResolved(null);
                  setResolvedInput(null);
                  setInputError(null);
                }}
                className="flex-1 min-w-0 rounded-lg border border-edge bg-ink px-3.5 py-2.5 text-sm text-white outline-none focus:border-accent"
              >
                {eligibleUploads.map((p) => {
                  const dur =
                    typeof p.sourceAsset?.durationSec === 'number'
                      ? ` · ${Math.round(p.sourceAsset.durationSec)}s`
                      : '';
                  return (
                    <option key={p.id} value={p.id}>
                      {p.title}
                      {dur}
                    </option>
                  );
                })}
              </select>
              <button
                type="button"
                disabled={resolving || !selectedUploadProjectId}
                data-testid="resolve-upload-btn"
                onClick={() => void resolveCurrentInput()}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-ink disabled:opacity-50 shrink-0"
              >
                {resolving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {resolving ? 'Checking…' : 'Check Upload'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Validation / API Error */}
      {inputError && (
        <div
          role="alert"
          data-testid="media-input-error"
          className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn flex items-start gap-2.5"
        >
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{inputError}</span>
        </div>
      )}

      {/* Truthful Source Capability Result Card */}
      {resolved && capabilityInfo && (
        <div
          data-testid="source-capability-card"
          data-capability-status={resolved.capabilityStatus}
          className={cn(
            'rounded-lg border p-4 space-y-3',
            capabilityInfo.tone === 'ready'
              ? 'border-signal/40 bg-signal/5'
              : capabilityInfo.tone === 'unsupported'
                ? 'border-accent/40 bg-accent/5'
                : 'border-warn/40 bg-warn/10',
          )}
        >
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              {resolved.thumbnailUrl && (
                <img
                  src={resolved.thumbnailUrl}
                  alt={resolved.title || 'Resolved source thumbnail'}
                  className="w-24 h-14 rounded-md object-cover border border-edge shrink-0 bg-ink"
                />
              )}
              <div className="flex items-start gap-2.5 min-w-0">
                {capabilityInfo.tone === 'ready' ? (
                  <CheckCircle2 className="w-4 h-4 text-signal mt-0.5 shrink-0" />
                ) : (
                  <AlertCircle
                    className={cn(
                      'w-4 h-4 mt-0.5 shrink-0',
                      capabilityInfo.tone === 'unsupported' ? 'text-accent' : 'text-warn',
                    )}
                  />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">{capabilityInfo.headline}</p>
                  {(resolved.title || resolved.channelName || typeof resolved.durationSec === 'number') && (
                    <p
                      data-testid="resolved-source-metadata"
                      className="text-xs text-white/80 mt-1 truncate"
                    >
                      {resolved.title ? <span className="font-medium">{resolved.title}</span> : null}
                      {resolved.channelName ? (
                        <span className="text-white/55">
                          {resolved.title ? ' · ' : ''}
                          {resolved.channelName}
                        </span>
                      ) : null}
                      {typeof resolved.durationSec === 'number' && resolved.durationSec > 0 ? (
                        <span className="font-mono text-white/50">
                          {' '}
                          · {Math.floor(resolved.durationSec / 60)}m {Math.round(resolved.durationSec % 60)}s
                        </span>
                      ) : null}
                    </p>
                  )}
                  <p className="text-xs sm:text-sm text-white/70 mt-1">{capabilityInfo.body}</p>
                  {capabilityInfo.technicalReason &&
                    capabilityInfo.technicalReason !== capabilityInfo.body && (
                      <p className="text-xs text-white/55 mt-1">{capabilityInfo.technicalReason}</p>
                    )}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap sm:flex-col items-start sm:items-end gap-1 shrink-0">
              <span className="rounded border border-edge bg-ink px-2 py-0.5 font-mono text-[11px] uppercase text-white/60">
                {resolved.provider} · {capabilityInfo.contentKindLabel} · {resolved.capabilityStatus}
              </span>
              <span className="font-mono text-[10px] text-white/45">
                URL capture: {resolved.canSubmitJob ? 'Enabled (ready to process)' : 'Metadata only in this build'}
                {resolved.platformClipSupported !== undefined
                  ? ` · Platform clips: ${resolved.platformClipSupported ? 'API metadata (broadcaster/editor auth for download)' : 'Not supported'}`
                  : ''}
              </span>
            </div>
          </div>

          {resolved.providerNotice && (
            <div
              data-testid="provider-api-notice"
              className="rounded border border-edge bg-ink/80 px-3 py-2 text-xs text-white/60 flex items-center justify-between gap-2"
            >
              <span>
                <span className="font-mono text-white/75">{resolved.providerNotice.code}:</span>{' '}
                {resolved.providerNotice.message}
              </span>
              {resolved.providerNotice.retryAfterSec ? (
                <span className="font-mono text-[11px] text-accent shrink-0">
                  Retry in ~{resolved.providerNotice.retryAfterSec}s
                </span>
              ) : null}
            </div>
          )}

          <div className="flex flex-wrap gap-2.5 pt-1">
            {resolved.canSubmitJob && (
              <button
                type="button"
                disabled={submitting}
                data-testid="submit-media-job-btn"
                onClick={() => void handleSubmitJob()}
                className="inline-flex items-center gap-2 rounded-lg bg-signal px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {submitting ? 'Submitting…' : 'Detect Highlights'}
              </button>
            )}

            {capabilityInfo.showUploadCta && onRequestNewUpload && (
              <button
                type="button"
                onClick={onRequestNewUpload}
                className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-ink px-3.5 py-2 text-xs sm:text-sm text-white hover:border-accent"
              >
                <Upload className="w-4 h-4" />
                Upload a local video file
              </button>
            )}

            {capabilityInfo.showUploadCta && eligibleUploads.length > 0 && tab === 'url' && (
              <button
                type="button"
                onClick={() => {
                  setTab('existing_upload');
                  setResolved(null);
                  setResolvedInput(null);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-ink px-3.5 py-2 text-xs sm:text-sm text-white/80 hover:border-accent hover:text-white"
              >
                <Film className="w-4 h-4" />
                Use an existing upload
              </button>
            )}
          </div>
        </div>
      )}

      {/* Durable Job Progress Card */}
      {job && (
        <div
          data-testid="media-job-status-card"
          data-job-id={job.jobId}
          data-job-status={job.status}
          className="rounded-lg border border-edge bg-ink p-4 space-y-3"
          aria-live="polite"
        >
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  data-testid="media-job-status-badge"
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase',
                    STATUS_BADGE[job.status] ?? 'border-edge text-white/70',
                  )}
                >
                  {(job.status === 'QUEUED' || job.status === 'RUNNING') && (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  )}
                  {job.status === 'READY' && <CheckCircle2 className="w-3 h-3" />}
                  {job.status === 'FAILED' && <AlertCircle className="w-3 h-3" />}
                  {job.status === 'CANCELLED' && <XCircle className="w-3 h-3" />}
                  {job.status}
                </span>
                <span className="text-sm font-medium text-white truncate max-w-xs sm:max-w-md">
                  {jobSourceLabel || 'Media highlight job'}
                </span>
              </div>
              <p data-testid="media-job-stage" className="text-xs text-white/60 mt-1">
                {formatJobStageLabel(job.stage, job.status)}
                {job.deduplicatedSharedWork && job.status === 'READY'
                  ? ' · Reused verified shared highlights'
                  : ''}
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {!isTerminalJobStatus(job.status) && (
                <button
                  type="button"
                  disabled={cancelling}
                  data-testid="cancel-media-job-btn"
                  onClick={() => void handleCancelJob()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-warn/40 bg-warn/10 px-3 py-1.5 text-xs font-medium text-warn hover:bg-warn/20 disabled:opacity-50"
                >
                  {cancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                  {cancelling ? 'Cancelling…' : 'Cancel Job'}
                </button>
              )}

              {isTerminalJobStatus(job.status) && (
                <button
                  type="button"
                  onClick={() => {
                    ++jobEpochRef.current;
                    activeJobIdRef.current = null;
                    linksFetchedAtRef.current = null;
                    clearActiveMediaJobRef();
                    syncJobUrlParam(null);
                    setJob(null);
                    setHighlights([]);
                    setCancelFeedback(null);
                    setHighlightsError(null);
                    setPollNotice(null);
                    setPollExhausted(false);
                    setPendingIdempotencyKey(createSubmissionIdempotencyKey(resolvedSourceLabel || 'media'));
                  }}
                  className="rounded-lg border border-edge px-3 py-1.5 text-xs text-white/60 hover:text-white"
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>

          {/* Real backend progress bar (never faked animations) */}
          {(job.status === 'QUEUED' || job.status === 'RUNNING') && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-mono text-white/50">
                <span>
                  {job.status === 'QUEUED'
                    ? 'Queued — waiting for an available worker slot'
                    : `Stage: ${job.stage}`}
                </span>
                <span>{Math.max(0, Math.min(100, job.progressPercent))}%</span>
              </div>
              <div
                role="progressbar"
                aria-label="Highlight job progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.max(0, Math.min(100, job.progressPercent))}
                className="h-2 rounded-full bg-edge overflow-hidden"
              >
                <div
                  className="h-full bg-accent transition-all duration-300"
                  style={{ width: `${Math.max(0, Math.min(100, job.progressPercent))}%` }}
                />
              </div>
            </div>
          )}

          {pollNotice && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-accent">
              <p className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 shrink-0" />
                {pollNotice}
              </p>
              {pollExhausted && (
                <button
                  type="button"
                  data-testid="retry-media-poll-btn"
                  onClick={() => {
                    setPollExhausted(false);
                    setPollNotice(null);
                    setPollEpoch((e) => e + 1);
                  }}
                  className="rounded border border-accent/50 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/10"
                >
                  Check Status
                </button>
              )}
            </div>
          )}

          {cancelFeedback && (
            <p data-testid="cancel-job-feedback" className="text-xs text-white/75">
              {cancelFeedback}
            </p>
          )}

          {job.status === 'FAILED' && (
            <div
              role="alert"
              data-testid="media-job-failed-banner"
              className="rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-xs sm:text-sm text-warn space-y-1"
            >
              <p className="font-medium">
                Processing failed{job.errorCode ? ` (${job.errorCode})` : ''}
              </p>
              <p className="text-warn/90">
                {job.errorMessage || 'An unexpected error occurred during processing. You can retry with a fresh submission.'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Highlight Results Section */}
      {job && (job.status === 'READY' || highlights.length > 0) && (
        <div data-testid="media-highlights-section" className="space-y-3 pt-1">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <h3 className="font-display text-base text-white">
                Detected Highlights ({highlights.length})
              </h3>
              <p className="text-xs text-white/50">
                Preview highlights, download private MP4 clips, or open any highlight in your private timeline editor.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={refreshingLinks}
                data-testid="refresh-highlight-links-btn"
                onClick={() => void handleRefreshHighlightLinks()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-ink px-3 py-1.5 text-xs text-white/75 hover:border-accent hover:text-white disabled:opacity-50"
              >
                <RefreshCw className={cn('w-3.5 h-3.5', refreshingLinks && 'animate-spin')} />
                Refresh links
              </button>

              <button
                type="button"
                disabled={Boolean(creatingProjectFor)}
                data-testid="open-private-project-manual-btn"
                onClick={() => void handleOpenPrivateProject()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
              >
                <Scissors className="w-3.5 h-3.5" />
                {creatingProjectFor === 'manual' ? 'Creating…' : 'Open Private Project'}
              </button>
            </div>
          </div>

          {highlightsError && (
            <div
              role="alert"
              data-testid="highlights-error"
              className="rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-xs sm:text-sm text-warn"
            >
              {highlightsError}
            </div>
          )}

          {projectActionError && (
            <div
              role="alert"
              className="rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-xs sm:text-sm text-warn"
            >
              {projectActionError}
            </div>
          )}

          {highlightsLoading ? (
            <div className="rounded-lg border border-edge bg-ink p-6 text-center text-sm text-white/55 flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-accent" />
              Loading verified highlights…
            </div>
          ) : highlights.length === 0 && job.status === 'READY' ? (
            <div
              data-testid="no-highlights-empty"
              className="rounded-lg border border-edge bg-ink p-5 text-sm text-white/65 space-y-2"
            >
              <p className="font-medium text-white">No strong highlight spikes detected</p>
              <p className="text-xs text-white/55">
                Your footage was processed successfully, but no audio/activity peaks crossed the highlight threshold. You can still open a private project above to trim and edit manually.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {highlights.map((hl, idx) => (
                <article
                  key={hl.highlightId}
                  data-testid="highlight-card"
                  data-highlight-id={hl.highlightId}
                  className="rounded-lg border border-edge bg-ink overflow-hidden flex flex-col"
                >
                  {hl.downloadUrl ? (
                    <video
                      src={hl.downloadUrl}
                      controls
                      playsInline
                      preload="metadata"
                      onError={() => void handleVideoError(hl.highlightId)}
                      className="w-full aspect-video bg-black object-contain"
                    />
                  ) : (
                    <div className="w-full aspect-video bg-black/60 flex items-center justify-center text-xs text-white/40">
                      Preview unavailable — click Refresh links
                    </div>
                  )}

                  <div className="p-3.5 space-y-3 flex-1 flex flex-col justify-between">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-display text-sm text-white">
                          Highlight #{idx + 1} · {formatTimestampRange(hl.windowStartSec, hl.windowEndSec)}
                        </span>
                        <span className="rounded-full border border-signal/40 bg-signal/10 px-2 py-0.5 font-mono text-[11px] text-signal">
                          Score {Math.round(hl.compositeScore)}
                        </span>
                      </div>

                      <p className="font-mono text-[11px] text-white/45">
                        {hl.durationSec ? `${hl.durationSec.toFixed(1)}s` : `${(hl.windowEndSec - hl.windowStartSec).toFixed(1)}s`}
                        {hl.width && hl.height ? ` · ${hl.width}×${hl.height}` : ''}
                        {hl.downloadUrlExpiresInSec
                          ? ` · Link refreshes every ${Math.round(hl.downloadUrlExpiresInSec / 60)} min`
                          : ''}
                      </p>

                      {hl.contributingSignals?.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {hl.contributingSignals.map((sig) => (
                            <span
                              key={sig}
                              className="rounded bg-panel border border-edge px-1.5 py-0.5 font-mono text-[10px] text-white/60"
                            >
                              {sig.replace(/_/g, ' ')}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        type="button"
                        disabled={Boolean(creatingProjectFor)}
                        data-testid="edit-highlight-project-btn"
                        onClick={() => void handleOpenPrivateProject(hl)}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-ink disabled:opacity-50"
                      >
                        <Scissors className="w-3.5 h-3.5" />
                        {creatingProjectFor === hl.highlightId
                          ? 'Opening…'
                          : 'Edit in Private Project'}
                      </button>

                      {hl.downloadUrl && (
                        <a
                          href={hl.downloadUrl}
                          download={`autoedit-highlight-${idx + 1}.mp4`}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid="download-highlight-mp4-link"
                          onClick={(e) => {
                            if (
                              areSignedLinksStale(
                                linksFetchedAtRef.current,
                                hl.downloadUrlExpiresInSec ?? linksTtlSecRef.current,
                              )
                            ) {
                              e.preventDefault();
                              void handleRefreshHighlightLinks();
                            }
                          }}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-signal/50 bg-signal/10 px-3 py-2 text-xs font-medium text-signal hover:bg-signal/20"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download MP4
                        </a>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
