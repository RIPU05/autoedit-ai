'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaHighlightItem, PrivateRenderJobResponse } from '@autoedit/contracts';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  Loader2,
  RefreshCw,
  Scissors,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { media as mediaApi } from '@/lib/api';
import {
  FREE_BETA_LIMITS,
  areSignedLinksStale,
  clearActivePrivateRenderRef,
  computeNextPollDelayMs,
  createSubmissionIdempotencyKey,
  formatMediaApiError,
  formatPrivateRenderStageLabel,
  formatTimestampRange,
  isTerminalJobStatus,
  loadActivePrivateRenderRef,
  saveActivePrivateRenderRef,
} from '@/lib/media-workspace';
import { cn } from '@/lib/utils';

type EditMode = 'auto' | 'prompt' | 'reference' | 'manual';

const RENDER_STATUS_BADGE: Record<string, string> = {
  QUEUED: 'border-edge bg-ink text-white/75',
  RUNNING: 'border-accent/50 bg-accent/10 text-accent',
  READY: 'border-signal/50 bg-signal/10 text-signal',
  FAILED: 'border-warn/50 bg-warn/10 text-warn',
  CANCELLED: 'border-edge bg-ink text-white/55',
};

const MAX_CONSECUTIVE_POLL_ERRORS = 10;

export function SourceHighlightsEditorPanel({
  projectId,
  initialHighlightId,
  onVersionCreated,
}: {
  projectId: string;
  initialHighlightId?: string | null;
  onVersionCreated?: () => void;
}) {
  const [highlights, setHighlights] = useState<MediaHighlightItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialHighlightId ?? null);

  // Private editing controls (Auto / Prompt / Reference / Manual)
  const [mode, setMode] = useState<EditMode>('auto');
  const [versionName, setVersionName] = useState('Private Clip Cut');
  const [userPrompt, setUserPrompt] = useState('');
  const [windowStartSec, setWindowStartSec] = useState<number>(0);
  const [windowEndSec, setWindowEndSec] = useState<number>(10);
  const [subtitles, setSubtitles] = useState(false);
  const [zooms, setZooms] = useState(false);
  const [transitions, setTransitions] = useState<'fade' | 'none'>('none');
  const [music, setMusic] = useState(false);

  // Idempotent submission + double-click lock
  const submitLockRef = useRef(false);
  const [pendingIdemKey, setPendingIdemKey] = useState<string>(() =>
    createSubmissionIdempotencyKey(`priv_${projectId}`),
  );
  const [applying, setApplying] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [savedVersionNotice, setSavedVersionNotice] = useState<{
    versionId: string;
    customEditHash: string;
  } | null>(null);

  // Durable background private render state (signed URLs live ONLY in memory, never in storage!)
  const [renderJob, setRenderJob] = useState<PrivateRenderJobResponse | null>(null);
  const [renderPollNotice, setRenderPollNotice] = useState<string | null>(null);
  const [renderPollExhausted, setRenderPollExhausted] = useState(false);
  const [renderPollEpoch, setRenderPollEpoch] = useState(0);
  const [cancellingRender, setCancellingRender] = useState(false);
  const [refreshingRenderLink, setRefreshingRenderLink] = useState(false);
  const [retryingRender, setRetryingRender] = useState(false);
  const renderLinkFetchedAtRef = useRef<number | null>(null);
  const activeRenderIdRef = useRef<string | null>(null);
  const retriedUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    activeRenderIdRef.current = renderJob?.renderJobId ?? null;
  }, [renderJob?.renderJobId]);

  // Mint a fresh idempotency key whenever the user changes edit inputs so distinct edits create distinct versions,
  // while double-clicking the exact same edit form reuses the same idempotencyKey!
  const resetPendingIdempotencyKey = useCallback(() => {
    setPendingIdemKey(createSubmissionIdempotencyKey(`priv_${projectId}`));
  }, [projectId]);

  const loadHighlights = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await mediaApi.getProjectHighlights(projectId);
      const list = res.highlights ?? [];
      setHighlights(list);
      retriedUrlsRef.current.clear();

      if (list.length > 0) {
        const chosen =
          (selectedId && list.find((h) => h.highlightId === selectedId)) ||
          (initialHighlightId && list.find((h) => h.highlightId === initialHighlightId)) ||
          list[0];
        setSelectedId(chosen.highlightId);
        setWindowStartSec(Number(chosen.windowStartSec.toFixed(1)));
        setWindowEndSec(Number(chosen.windowEndSec.toFixed(1)));
      }
    } catch (err: any) {
      if (err?.status === 403) {
        setHighlights([]);
      }
      setError(formatMediaApiError(err).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, initialHighlightId, selectedId]);

  // Recover active or latest private render job on mount / browser refresh (from DB + opaque sessionStorage)
  const recoverPrivateRenderOnMount = useCallback(async () => {
    try {
      const savedRef = loadActivePrivateRenderRef(projectId);
      if (savedRef?.renderJobId) {
        try {
          const status = await mediaApi.getPrivateRenderStatus(projectId, savedRef.renderJobId);
          setRenderJob(status);
          if (status.downloadUrl) renderLinkFetchedAtRef.current = Date.now();
          return;
        } catch (err: any) {
          if (err?.status === 404) {
            clearActivePrivateRenderRef(projectId);
          }
        }
      }

      const listRes = await mediaApi.listProjectRenders(projectId);
      const latest =
        listRes.renders.find((r) => r.status === 'QUEUED' || r.status === 'RUNNING') ??
        listRes.renders[0] ??
        null;

      if (latest) {
        // If READY, call GET /:renderJobId to mint a fresh verified 300s signed download URL dynamically
        if (latest.status === 'READY') {
          const verified = await mediaApi.getPrivateRenderStatus(projectId, latest.renderJobId);
          setRenderJob(verified);
          if (verified.downloadUrl) renderLinkFetchedAtRef.current = Date.now();
        } else {
          setRenderJob(latest);
        }
        saveActivePrivateRenderRef(projectId, latest.renderJobId);
      }
    } catch {
      // Non-fatal: user can still submit new renders
    }
  }, [projectId]);

  useEffect(() => {
    void loadHighlights();
    void recoverPrivateRenderOnMount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Bounded backoff polling for QUEUED / RUNNING private renders — stops immediately on terminal status!
  useEffect(() => {
    if (!renderJob || isTerminalJobStatus(renderJob.status)) return;

    const trackedId = renderJob.renderJobId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollCount = 0;
    let consecutiveErrors = 0;

    const tick = async () => {
      if (cancelled || activeRenderIdRef.current !== trackedId) return;
      pollCount++;
      try {
        const next = await mediaApi.getPrivateRenderStatus(projectId, trackedId);
        if (cancelled || activeRenderIdRef.current !== trackedId) return;
        consecutiveErrors = 0;
        setRenderPollNotice(null);
        setRenderPollExhausted(false);
        setRenderJob(next);

        if (next.status === 'READY' && next.downloadUrl) {
          renderLinkFetchedAtRef.current = Date.now();
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
        if (cancelled || activeRenderIdRef.current !== trackedId) return;
        if (err?.status === 404) {
          clearActivePrivateRenderRef(projectId);
          setRenderJob(null);
          setEditError('That private render job is no longer available for your account.');
          return;
        }
        if (err?.status === 403) {
          setRenderJob((prev) =>
            prev
              ? {
                  ...prev,
                  status: 'FAILED',
                  stage: 'failed',
                  errorCode: 'ACCESS_DENIED',
                  errorMessage: formatMediaApiError(err).message,
                }
              : prev,
          );
          return;
        }
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          setRenderPollExhausted(true);
          setRenderPollNotice(
            'Unable to reach server after multiple retries. Your render continues safely in the background — click Refresh Status when ready.',
          );
          return;
        }
        setRenderPollNotice(
          `Connection interrupted while checking render progress (retry ${consecutiveErrors}). Rendering continues safely on the server.`,
        );
        const delay = computeNextPollDelayMs({
          status: renderJob.status,
          pollCount,
          consecutiveErrors,
        });
        if (delay !== null && !cancelled) {
          timer = setTimeout(tick, delay);
        }
      }
    };

    const initialDelay = computeNextPollDelayMs({
      status: renderJob.status,
      pollCount: 0,
      consecutiveErrors: 0,
    });
    if (initialDelay !== null) {
      timer = setTimeout(tick, initialDelay);
    }

    const onOnlineOrVisible = () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, 250);
    };
    window.addEventListener('online', onOnlineOrVisible);
    document.addEventListener('visibilitychange', onOnlineOrVisible);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', onOnlineOrVisible);
      document.removeEventListener('visibilitychange', onOnlineOrVisible);
    };
  }, [projectId, renderJob?.renderJobId, renderJob?.status, renderPollEpoch]);

  function selectHighlight(hl: MediaHighlightItem) {
    setSelectedId(hl.highlightId);
    setWindowStartSec(Number(hl.windowStartSec.toFixed(1)));
    setWindowEndSec(Number(hl.windowEndSec.toFixed(1)));
    setVersionName(`Cut ${formatTimestampRange(hl.windowStartSec, hl.windowEndSec)}`);
    resetPendingIdempotencyKey();
  }

  async function applyPrivateEdit(renderOutput: boolean) {
    if (submitLockRef.current || applying) return;
    if (!Number.isFinite(windowStartSec) || !Number.isFinite(windowEndSec) || windowEndSec <= windowStartSec) {
      setEditError('End time must be greater than start time.');
      return;
    }
    if (renderOutput && windowEndSec - windowStartSec > FREE_BETA_LIMITS.maxPrivateClipDurationSec) {
      setEditError(
        `Free beta renders are limited to ${FREE_BETA_LIMITS.maxPrivateClipDurationSec} seconds per clip.`,
      );
      return;
    }

    submitLockRef.current = true;
    setApplying(true);
    setEditError(null);
    setRenderPollNotice(null);
    setRenderPollExhausted(false);

    try {
      const res = await mediaApi.applyProjectEdit(projectId, {
        mode,
        versionName: versionName.trim() || `${mode.toUpperCase()} private cut`,
        userPrompt: userPrompt.trim() || undefined,
        windowStartSec,
        windowEndSec,
        effects: { subtitles, zooms, transitions, music },
        renderOutput,
        idempotencyKey: renderOutput ? pendingIdemKey : undefined,
      });

      setSavedVersionNotice({
        versionId: res.versionId,
        customEditHash: res.customEditHash,
      });

      if (res.renderJob) {
        setRenderJob(res.renderJob);
        activeRenderIdRef.current = res.renderJob.renderJobId;
        saveActivePrivateRenderRef(projectId, res.renderJob.renderJobId);
        if (res.renderJob.status === 'READY' && !res.renderJob.downloadUrl) {
          const verified = await mediaApi.getPrivateRenderStatus(projectId, res.renderJob.renderJobId);
          setRenderJob(verified);
          if (verified.downloadUrl) renderLinkFetchedAtRef.current = Date.now();
        }
      }

      onVersionCreated?.();
    } catch (err: any) {
      setEditError(formatMediaApiError(err).message);
    } finally {
      setApplying(false);
      submitLockRef.current = false;
    }
  }

  async function handleCancelPrivateRender() {
    if (!renderJob || cancellingRender || isTerminalJobStatus(renderJob.status)) return;
    setCancellingRender(true);
    setEditError(null);
    try {
      const res = await mediaApi.cancelPrivateRender(projectId, renderJob.renderJobId);
      setRenderJob((prev) =>
        prev
          ? {
              ...prev,
              status: res.status,
              stage: res.status === 'CANCELLED' ? 'cancelled' : prev.stage,
            }
          : prev,
      );
      if (res.alreadyCompleted && res.status === 'READY') {
        const verified = await mediaApi.getPrivateRenderStatus(projectId, renderJob.renderJobId);
        setRenderJob(verified);
        if (verified.downloadUrl) renderLinkFetchedAtRef.current = Date.now();
      }
    } catch (err: any) {
      setEditError(formatMediaApiError(err).message);
    } finally {
      setCancellingRender(false);
    }
  }

  async function handleRefreshRenderStatusAndLink() {
    if (!renderJob || refreshingRenderLink) return;
    setRefreshingRenderLink(true);
    setEditError(null);
    setRenderPollExhausted(false);
    try {
      const fresh = await mediaApi.getPrivateRenderStatus(projectId, renderJob.renderJobId);
      setRenderJob(fresh);
      if (fresh.downloadUrl) renderLinkFetchedAtRef.current = Date.now();
      if (!isTerminalJobStatus(fresh.status)) {
        setRenderPollEpoch((e) => e + 1);
      }
    } catch (err: any) {
      setEditError(formatMediaApiError(err).message);
    } finally {
      setRefreshingRenderLink(false);
    }
  }

  async function handleRetryExistingVersionRender() {
    if (!renderJob || retryingRender) return;
    setRetryingRender(true);
    setEditError(null);
    setRenderPollNotice(null);
    setRenderPollExhausted(false);
    try {
      const freshKey = createSubmissionIdempotencyKey(`retry_${renderJob.editVersionId}`);
      const next = await mediaApi.enqueueProjectRender(projectId, {
        editVersionId: renderJob.editVersionId,
        idempotencyKey: freshKey,
      });
      setRenderJob(next);
      activeRenderIdRef.current = next.renderJobId;
      saveActivePrivateRenderRef(projectId, next.renderJobId);
    } catch (err: any) {
      setEditError(formatMediaApiError(err).message);
    } finally {
      setRetryingRender(false);
    }
  }

  const selectedHighlight = highlights.find((h) => h.highlightId === selectedId) ?? highlights[0] ?? null;

  return (
    <section
      data-testid="source-highlights-editor-panel"
      className="mt-6 rounded-xl border border-edge bg-panel p-5 space-y-5"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-accent" />
            <h2 className="font-display text-base text-white">
              Source Highlights & Private Clip Export
            </h2>
          </div>
          <p className="text-xs text-white/55 mt-0.5">
            Your timeline, versions, and MP4 exports in this project are completely private to your account.
          </p>
        </div>

        <button
          type="button"
          disabled={loading}
          data-testid="refresh-project-highlights-btn"
          onClick={() => void loadHighlights()}
          className="self-start inline-flex items-center gap-1.5 rounded-lg border border-edge bg-ink px-3 py-1.5 text-xs text-white/75 hover:border-accent hover:text-white disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          Refresh signed links
        </button>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="project-highlights-error"
          className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-xs sm:text-sm text-warn flex items-start gap-2"
        >
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-edge bg-ink p-5 text-xs text-white/55 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-accent" />
          Loading authorized highlights…
        </div>
      ) : highlights.length > 0 ? (
        <div className="grid lg:grid-cols-2 gap-4">
          {/* Selected Highlight Video Preview */}
          <div className="space-y-2">
            {selectedHighlight?.downloadUrl ? (
              <video
                key={selectedHighlight.downloadUrl}
                src={selectedHighlight.downloadUrl}
                controls
                playsInline
                preload="metadata"
                onError={() => {
                  if (!retriedUrlsRef.current.has(selectedHighlight.highlightId)) {
                    retriedUrlsRef.current.add(selectedHighlight.highlightId);
                    void loadHighlights();
                  }
                }}
                className="w-full aspect-video rounded-lg bg-black object-contain border border-edge"
              />
            ) : (
              <div className="w-full aspect-video rounded-lg bg-ink border border-edge flex items-center justify-center text-xs text-white/40">
                Select a highlight to preview
              </div>
            )}

            {selectedHighlight?.downloadUrl && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-white/50">
                <span className="font-mono">
                  {formatTimestampRange(
                    selectedHighlight.windowStartSec,
                    selectedHighlight.windowEndSec,
                  )}{' '}
                  · Score {Math.round(selectedHighlight.compositeScore)}
                </span>
                <a
                  href={selectedHighlight.downloadUrl}
                  download="autoedit-base-highlight.mp4"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="project-base-highlight-download"
                  className="inline-flex items-center gap-1 text-signal hover:underline"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download base highlight MP4
                </a>
              </div>
            )}
          </div>

          {/* Highlight Picker List */}
          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            <p className="font-mono text-[11px] uppercase text-white/40">
              Select a highlight window
            </p>
            {highlights.map((hl, idx) => (
              <button
                key={hl.highlightId}
                type="button"
                onClick={() => selectHighlight(hl)}
                className={cn(
                  'w-full text-left rounded-lg border px-3 py-2.5 transition-colors flex items-center justify-between gap-2',
                  selectedHighlight?.highlightId === hl.highlightId
                    ? 'border-accent bg-accent/10'
                    : 'border-edge bg-ink hover:border-accent/40',
                )}
              >
                <div>
                  <p className="text-sm text-white font-medium">
                    Highlight #{idx + 1} · {formatTimestampRange(hl.windowStartSec, hl.windowEndSec)}
                  </p>
                  <p className="font-mono text-[11px] text-white/45 mt-0.5">
                    {hl.contributingSignals.map((s) => s.replace(/_/g, ' ')).join(' · ') || 'Detected peak'}
                  </p>
                </div>
                <span className="font-mono text-xs text-signal shrink-0">
                  {Math.round(hl.compositeScore)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* 4 Editing Modes (Auto / Prompt / Reference / Manual) + Durable Background Private MP4 Render */}
      <div className="border-t border-edge pt-4 space-y-4">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Private editing mode">
          {(
            [
              { id: 'auto', label: 'Auto' },
              { id: 'prompt', label: 'Prompt' },
              { id: 'reference', label: 'Reference' },
              { id: 'manual', label: 'Manual' },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              data-testid={`edit-mode-${m.id}`}
              onClick={() => {
                setMode(m.id);
                resetPendingIdempotencyKey();
              }}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                mode === m.id
                  ? 'border-accent bg-accent/15 text-white'
                  : 'border-edge bg-ink text-white/60 hover:text-white',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

        {mode === 'reference' && (
          <p className="text-xs text-white/60 bg-ink border border-edge rounded-lg px-3 py-2">
            Reference mode in Beta saves your pacing/effect preset as a versioned timeline cut. Full external reference-video style transfer is planned in an upcoming milestone.
          </p>
        )}

        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="block font-mono text-[11px] text-white/50 mb-1" htmlFor="priv-version-name">
              Version name
            </label>
            <input
              id="priv-version-name"
              data-testid="private-edit-version-name"
              type="text"
              value={versionName}
              onChange={(e) => {
                setVersionName(e.target.value);
                resetPendingIdempotencyKey();
              }}
              className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-sm text-white outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="block font-mono text-[11px] text-white/50 mb-1" htmlFor="priv-start-sec">
              Start (sec)
            </label>
            <input
              id="priv-start-sec"
              data-testid="private-edit-start"
              type="number"
              min={0}
              step={0.5}
              value={windowStartSec}
              onChange={(e) => {
                setWindowStartSec(Number(e.target.value));
                resetPendingIdempotencyKey();
              }}
              className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-sm text-white outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="block font-mono text-[11px] text-white/50 mb-1" htmlFor="priv-end-sec">
              End (sec)
            </label>
            <input
              id="priv-end-sec"
              data-testid="private-edit-end"
              type="number"
              min={0.5}
              step={0.5}
              value={windowEndSec}
              onChange={(e) => {
                setWindowEndSec(Number(e.target.value));
                resetPendingIdempotencyKey();
              }}
              className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-sm text-white outline-none focus:border-accent"
            />
          </div>
        </div>

        {(mode === 'prompt' || mode === 'reference') && (
          <div>
            <label className="block font-mono text-[11px] text-white/50 mb-1" htmlFor="priv-prompt">
              {mode === 'prompt' ? 'Prompt instruction' : 'Reference pacing notes'}
            </label>
            <input
              id="priv-prompt"
              data-testid="private-edit-prompt"
              type="text"
              value={userPrompt}
              onChange={(e) => {
                setUserPrompt(e.target.value);
                resetPendingIdempotencyKey();
              }}
              placeholder={
                mode === 'prompt'
                  ? 'e.g. Tighten around the peak reaction with punchy zoom'
                  : 'e.g. Fast-paced Shorts cut with subtle zoom'
              }
              className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-sm text-white placeholder:text-white/35 outline-none focus:border-accent"
            />
          </div>
        )}

        <div className="flex flex-wrap gap-3 text-xs text-white/75">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={subtitles}
              onChange={(e) => {
                setSubtitles(e.target.checked);
                resetPendingIdempotencyKey();
              }}
            />
            Subtitles
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={zooms}
              onChange={(e) => {
                setZooms(e.target.checked);
                resetPendingIdempotencyKey();
              }}
            />
            Zooms
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={transitions === 'fade'}
              onChange={(e) => {
                setTransitions(e.target.checked ? 'fade' : 'none');
                resetPendingIdempotencyKey();
              }}
            />
            Fade transitions
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={music}
              onChange={(e) => {
                setMusic(e.target.checked);
                resetPendingIdempotencyKey();
              }}
            />
            Music bed
          </label>
        </div>

        <p className="font-mono text-[11px] text-white/40">
          Free Beta render limits: up to {FREE_BETA_LIMITS.maxPrivateClipDurationSec}s per clip ·{' '}
          {FREE_BETA_LIMITS.maxActivePrivateRenders} active / {FREE_BETA_LIMITS.maxDailyClipRenders} daily renders ·
          signed MP4 links expire every {FREE_BETA_LIMITS.signedUrlTtlMinutes} min.
        </p>

        {editError && (
          <p role="alert" data-testid="private-edit-error" className="text-xs text-warn">
            {editError}
          </p>
        )}

        <div className="flex flex-wrap gap-2.5">
          <button
            type="button"
            disabled={applying}
            data-testid="private-edit-render-btn"
            onClick={() => void applyPrivateEdit(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
          >
            {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scissors className="w-4 h-4" />}
            {applying ? 'Queueing private render…' : 'Save Version & Render Private MP4'}
          </button>

          <button
            type="button"
            disabled={applying}
            data-testid="private-edit-save-only-btn"
            onClick={() => void applyPrivateEdit(false)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-ink px-3.5 py-2 text-xs sm:text-sm text-white/80 hover:border-accent hover:text-white disabled:opacity-50"
          >
            Save Version Only
          </button>
        </div>

        {savedVersionNotice && !renderJob && (
          <div
            data-testid="private-edit-saved-notice"
            className="rounded-lg border border-signal/40 bg-signal/10 px-4 py-2.5 flex items-center gap-2 text-xs sm:text-sm text-signal"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>Private edit version saved to your timeline history.</span>
          </div>
        )}

        {/* Durable Background Private Render Status Card (QUEUED / RUNNING / READY / FAILED / CANCELLED) */}
        {renderJob && (
          <div
            data-testid="private-render-status-card"
            data-render-job-id={renderJob.renderJobId}
            data-render-status={renderJob.status}
            aria-live="polite"
            className="rounded-lg border border-edge bg-ink p-4 space-y-3"
          >
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    data-testid="private-render-status-badge"
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase',
                      RENDER_STATUS_BADGE[renderJob.status] ?? 'border-edge text-white/70',
                    )}
                  >
                    {(renderJob.status === 'QUEUED' || renderJob.status === 'RUNNING') && (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    )}
                    {renderJob.status === 'READY' && <CheckCircle2 className="w-3 h-3" />}
                    {renderJob.status === 'FAILED' && <AlertCircle className="w-3 h-3" />}
                    {renderJob.status === 'CANCELLED' && <XCircle className="w-3 h-3" />}
                    {renderJob.status}
                  </span>
                  <span className="text-xs sm:text-sm font-medium text-white">
                    Private MP4 · {formatTimestampRange(renderJob.windowStartSec, renderJob.windowEndSec)}
                  </span>
                </div>
                <p data-testid="private-render-stage" className="text-xs text-white/60">
                  {formatPrivateRenderStageLabel(renderJob.stage, renderJob.status)}
                  {renderJob.durationSec && renderJob.width && renderJob.height
                    ? ` · ${renderJob.durationSec.toFixed(1)}s · ${renderJob.width}×${renderJob.height}`
                    : ''}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {!isTerminalJobStatus(renderJob.status) && (
                  <button
                    type="button"
                    disabled={cancellingRender}
                    data-testid="cancel-private-render-btn"
                    onClick={() => void handleCancelPrivateRender()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-warn/40 bg-warn/10 px-3 py-1.5 text-xs font-medium text-warn hover:bg-warn/20 disabled:opacity-50"
                  >
                    {cancellingRender ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5" />
                    )}
                    {cancellingRender ? 'Cancelling…' : 'Cancel Render'}
                  </button>
                )}

                {renderJob.status === 'READY' && (
                  <button
                    type="button"
                    disabled={refreshingRenderLink}
                    data-testid="refresh-private-render-link-btn"
                    onClick={() => void handleRefreshRenderStatusAndLink()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-panel px-3 py-1.5 text-xs text-white/75 hover:border-accent hover:text-white disabled:opacity-50"
                  >
                    <RefreshCw className={cn('w-3.5 h-3.5', refreshingRenderLink && 'animate-spin')} />
                    Refresh link
                  </button>
                )}

                {(renderJob.status === 'FAILED' ||
                  renderJob.status === 'CANCELLED' ||
                  (renderJob.status === 'READY' && !renderJob.downloadUrl)) && (
                  <button
                    type="button"
                    disabled={retryingRender}
                    data-testid="retry-private-render-btn"
                    onClick={() => void handleRetryExistingVersionRender()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
                  >
                    <RefreshCw className={cn('w-3.5 h-3.5', retryingRender && 'animate-spin')} />
                    {retryingRender ? 'Queueing retry…' : 'Retry Render'}
                  </button>
                )}
              </div>
            </div>

            {/* Real backend progress bar (never fabricated) */}
            {(renderJob.status === 'QUEUED' || renderJob.status === 'RUNNING') && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px] font-mono text-white/50">
                  <span>
                    {renderJob.status === 'QUEUED'
                      ? 'Queued — waiting for an available render slot'
                      : `Stage: ${renderJob.stage}`}
                  </span>
                  <span>{Math.max(0, Math.min(100, renderJob.progressPercent))}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label="Private render progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.max(0, Math.min(100, renderJob.progressPercent))}
                  className="h-2 rounded-full bg-edge overflow-hidden"
                >
                  <div
                    className="h-full bg-accent transition-all duration-300"
                    style={{ width: `${Math.max(0, Math.min(100, renderJob.progressPercent))}%` }}
                  />
                </div>
              </div>
            )}

            {renderPollNotice && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-accent">
                <span className="flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 shrink-0" />
                  {renderPollNotice}
                </span>
                {renderPollExhausted && (
                  <button
                    type="button"
                    onClick={() => void handleRefreshRenderStatusAndLink()}
                    className="rounded border border-accent/50 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/10"
                  >
                    Refresh Status
                  </button>
                )}
              </div>
            )}

            {renderJob.status === 'READY' && renderJob.downloadUrl && (
              <div
                data-testid="private-edit-result"
                className="rounded-lg border border-signal/40 bg-signal/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
              >
                <div className="flex items-center gap-2 text-xs sm:text-sm text-signal">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>
                    Verified private MP4 ready (signed link expires in{' '}
                    {Math.round((renderJob.downloadUrlExpiresInSec ?? 300) / 60)} min).
                  </span>
                </div>
                <a
                  href={renderJob.downloadUrl}
                  download={`autoedit-private-clip-${renderJob.customEditHash.slice(0, 8)}.mp4`}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="private-edit-download-link"
                  onClick={(e) => {
                    if (
                      areSignedLinksStale(
                        renderLinkFetchedAtRef.current,
                        renderJob.downloadUrlExpiresInSec ?? 300,
                      )
                    ) {
                      e.preventDefault();
                      void handleRefreshRenderStatusAndLink();
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-signal px-3.5 py-1.5 text-xs font-medium text-ink shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download Private MP4
                </a>
              </div>
            )}

            {(renderJob.status === 'FAILED' ||
              (renderJob.status === 'READY' && !renderJob.downloadUrl && renderJob.errorMessage)) && (
              <div
                role="alert"
                data-testid="private-render-failed-banner"
                className="rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-xs sm:text-sm text-warn space-y-1"
              >
                <p className="font-medium">
                  Render issue{renderJob.errorCode ? ` (${renderJob.errorCode})` : ''}
                </p>
                <p className="text-warn/90">
                  {renderJob.errorMessage || 'Private rendering did not complete. Click Retry Render to try again.'}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
