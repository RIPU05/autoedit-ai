'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { projects as api } from '@/lib/api';
import { TimelineEditor } from '@/components/TimelineEditor';
import { VersionSidebar } from '@/components/VersionSidebar';
import { CompareView } from '@/components/CompareView';
import { RepurposePanel } from '@/components/RepurposePanel';
import { FeedbackModal } from '@/components/FeedbackModal';
import { SourceHighlightsEditorPanel } from '@/components/SourceHighlightsEditorPanel';

interface PageError {
  status: number;
  message: string;
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<any>(null);
  const [error, setError] = useState<PageError | null>(null);
  const [pollWarning, setPollWarning] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [retryingAnalysis, setRetryingAnalysis] = useState(false);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const [rendering, setRendering] = useState<{ id: string; pct: number; status?: string } | null>(null);
  const [versionRefresh, setVersionRefresh] = useState(0); // sidebar reload (prompt edits + restores)
  const [editorKey, setEditorKey] = useState(0); // remount editor only when working ops change (restore)
  const [compare, setCompare] = useState<{ a: string; b: string } | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const hasProjectRef = useRef(false);
  const inFlightRef = useRef(false);
  const terminalErrorRef = useRef(false);

  const load = useCallback(async () => {
    if (inFlightRef.current) return null;
    inFlightRef.current = true;
    try {
      const res = await api.get(id);
      if (!res || !res.project) {
        throw new Error('invalid project response from server');
      }
      hasProjectRef.current = true;
      terminalErrorRef.current = false;
      setProject(res.project);
      setError(null);
      setPollWarning(null);
      return res.project;
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      const message = err?.message || 'failed to load project';

      // 401 Unauthorized -> redirect to login with return path
      if (status === 401) {
        terminalErrorRef.current = true;
        router.push(`/login?next=${encodeURIComponent(`/projects/${id}`)}`);
        return null;
      }

      const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
      terminalErrorRef.current = !retryable;

      // If project is already rendered on screen and a background poll transiently fails/times out,
      // keep the project visible and show a non-destructive inline warning instead of wiping the page.
      if (hasProjectRef.current && retryable) {
        setPollWarning(
          status === 408
            ? 'Status refresh timed out. Your project is still open — retrying automatically.'
            : `Temporary connection issue while refreshing status (${message}).`,
        );
        return null;
      }

      setError({ status, message });
      return null;
    } finally {
      inFlightRef.current = false;
      setIsLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;

    async function pollLoop() {
      const loaded = await load();
      if (cancelled) return;

      if (!loaded) {
        if (terminalErrorRef.current) return;
        consecutiveFailures += 1;
        // Retry transiently failed polls automatically (both after load and on initial transient 408/5xx up to 5 times)
        if (hasProjectRef.current || consecutiveFailures <= 5) {
          const backoffMs = Math.min(20_000, 3_000 * Math.pow(2, Math.min(consecutiveFailures - 1, 3)));
          timer = setTimeout(pollLoop, backoffMs);
        }
        return;
      }

      consecutiveFailures = 0;
      const hasReadyTimeline = Boolean((loaded.analysis && loaded.timeline) || (loaded.mediaSourceId && loaded.timeline));
      const needsPolling =
        (!hasReadyTimeline || loaded.status === 'UPLOADED' || loaded.status === 'ANALYZING') &&
        loaded.status !== 'FAILED' &&
        loaded.status !== 'RENDERED';

      const hasPendingRenders = (loaded.renders ?? []).some(
        (r: any) => r.status === 'QUEUED' || r.status === 'RUNNING',
      );

      if (needsPolling || hasPendingRenders || loaded.status === 'RENDERING') {
        timer = setTimeout(pollLoop, 3_000);
      }
    }

    void pollLoop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  async function handleRetryAnalysis() {
    if (retryingAnalysis) return;
    setRetryingAnalysis(true);
    setRetryNotice(null);
    try {
      const res = await api.retryAnalysis(id);
      if (res.reusedExistingJob) {
        setRetryNotice(
          res.workersOnline === 0
            ? 'Your analysis job is already queued in Redis, but no analysis worker is currently connected.'
            : 'Your analysis job is already queued and waiting for an available worker.',
        );
      } else {
        setRetryNotice(
          res.workersOnline === 0
            ? 'Analysis re-queued, but no background worker is currently connected.'
            : 'Analysis job re-queued. Checking progress…',
        );
      }
      await load();
    } catch (err: any) {
      setRetryNotice(err?.message || 'Could not retry analysis.');
    } finally {
      setRetryingAnalysis(false);
    }
  }

  // poll a render once started
  useEffect(() => {
    if (!rendering) return;
    const t = setInterval(async () => {
      try {
        const { render } = await api.renderStatus(id, rendering.id);
        setRendering((r) => (r ? { ...r, pct: render.progress, status: render.status } : r));
        if (render.status === 'COMPLETED' || render.status === 'FAILED') {
          clearInterval(t);
          await load();
          setRendering(null);
          if (render.status === 'COMPLETED') setShowFeedback(true);
        }
      } catch (err: any) {
        console.error('Failed to poll render status', err);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [rendering?.id, id]);

  if (error) {
    return (
      <main className="max-w-2xl mx-auto px-6 py-16 text-center">
        <a href="/dashboard" className="text-sm text-white/40 hover:text-white mb-6 inline-block">
          ← Back to Dashboard
        </a>
        <div className="bg-panel border border-edge rounded-lg p-8 shadow-lg">
          {error.status === 404 ? (
            <>
              <h1 className="font-display text-2xl text-white mb-2">Project Not Found</h1>
              <p className="text-white/60 text-sm mb-6">
                The requested project does not exist or has been deleted.
              </p>
              <a
                href="/dashboard"
                className="inline-block px-5 py-2.5 bg-accent hover:bg-accent/80 text-white rounded font-medium text-sm transition-colors"
              >
                Return to Dashboard
              </a>
            </>
          ) : error.status === 403 ? (
            <>
              <h1 className="font-display text-2xl text-white mb-2">Access Denied</h1>
              <p className="text-white/60 text-sm mb-6">
                You do not have permission to view this project.
              </p>
              <a
                href="/dashboard"
                className="inline-block px-5 py-2.5 bg-accent hover:bg-accent/80 text-white rounded font-medium text-sm transition-colors"
              >
                Return to Dashboard
              </a>
            </>
          ) : error.status === 429 ? (
            <>
              <h1 className="font-display text-2xl text-white mb-2">Rate Limit Exceeded</h1>
              <p className="text-white/60 text-sm mb-6">
                Too many requests. Please wait a moment before trying again.
              </p>
              <button
                onClick={() => {
                  setIsLoading(true);
                  load();
                }}
                className="px-5 py-2.5 bg-accent hover:bg-accent/80 text-white rounded font-medium text-sm transition-colors"
              >
                Retry Now
              </button>
            </>
          ) : error.status === 408 ? (
            <>
              <h1 className="font-display text-2xl text-white mb-2">Request Timed Out</h1>
              <p className="text-white/60 text-sm mb-6">
                The server took too long to respond. Please check your connection and try again.
              </p>
              <button
                onClick={() => {
                  setIsLoading(true);
                  load();
                }}
                className="px-5 py-2.5 bg-accent hover:bg-accent/80 text-white rounded font-medium text-sm transition-colors"
              >
                Retry
              </button>
            </>
          ) : (
            <>
              <h1 className="font-display text-2xl text-white mb-2">Something Went Wrong</h1>
              <p className="text-white/60 text-sm mb-6">
                {error.message || 'An unexpected error occurred while loading this project.'}
              </p>
              <div className="flex gap-4 justify-center">
                <button
                  onClick={() => {
                    setIsLoading(true);
                    load();
                  }}
                  className="px-5 py-2.5 bg-accent hover:bg-accent/80 text-white rounded font-medium text-sm transition-colors"
                >
                  Retry
                </button>
                <a
                  href="/dashboard"
                  className="inline-block px-5 py-2.5 bg-panel border border-edge text-white/80 hover:text-white rounded font-medium text-sm transition-colors"
                >
                  Dashboard
                </a>
              </div>
            </>
          )}
        </div>
      </main>
    );
  }

  if (isLoading || !project) {
    return (
      <main className="max-w-5xl mx-auto px-6 py-16 text-center text-white/50">
        <div className="inline-block animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full mb-3" />
        <p className="font-mono text-sm">Loading project…</p>
      </main>
    );
  }
  const a = project.analysis;
  const t = project.timeline;
  const completed = (project.renders ?? []).filter((r: any) => r.status === 'COMPLETED');
  const hasMediaSourceEditor = Boolean(project.mediaSourceId && t);
  const initialHighlightId =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('highlight')
      : null;
  const sourceDuration =
    project.sourceAsset?.durationSec ??
    (typeof project.mediaSource?.metadata?.durationSec === 'number'
      ? project.mediaSource.metadata.durationSec
      : 0);

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <a href="/dashboard" className="text-white/40 hover:text-white">← Dashboard</a>
        <a href="/media" className="text-white/40 hover:text-white">Media Hub</a>
      </div>
      <h1 className="font-display text-2xl mt-2">{project.title}</h1>
      <p className="font-mono text-xs text-white/40 mt-1">
        status: {project.status}
        {project.mediaSource
          ? ` · source: ${String(project.mediaSource.provider).toLowerCase()} (${String(project.mediaSource.sourceType).toLowerCase()})`
          : ''}
      </p>

      {pollWarning && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-warn/40 bg-warn/10 px-4 py-2.5 text-xs text-warn flex flex-wrap items-center justify-between gap-2"
        >
          <span>{pollWarning}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-warn/50 px-2.5 py-1 text-xs font-medium text-warn hover:bg-warn/15"
          >
            Refresh now
          </button>
        </div>
      )}

      {!a && !hasMediaSourceEditor && project.status !== 'FAILED' && (() => {
        const jobStatus = project.analysisJob?.status as string | undefined;
        const workersOnline = project.workerStatus?.analysisWorkersOnline as number | null | undefined;
        const isAnalyzing = project.status === 'ANALYZING' || jobStatus === 'ACTIVE';
        const isQueued = !isAnalyzing && jobStatus === 'QUEUED';
        const workersOffline = workersOnline === 0;

        const headline = isAnalyzing
          ? "AutoAI Edit is analyzing your video's audio and scenes."
          : isQueued
            ? 'Your video is waiting for an available analysis worker.'
            : 'Video uploaded. Preparing analysis.';

        const detail = isAnalyzing
          ? 'Extracting audio, transcribing speech, detecting silences and highlights. This page updates automatically.'
          : workersOffline
            ? 'No background analysis worker is currently connected. Your uploaded video is safely saved and queued — start the local worker (`npm run worker --prefix apps/api`) or wait for a worker to come online.'
            : isQueued
              ? 'Your upload finished and is queued for processing. This page updates automatically as soon as analysis starts.'
              : 'Your video upload is complete and awaiting an analysis job.';

        return (
          <div
            data-testid="project-analysis-status"
            data-backend-status={project.status}
            data-job-status={jobStatus ?? 'NONE'}
            className="mt-6 rounded-lg border border-edge bg-panel p-5 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-white">{headline}</p>
              <span className="rounded border border-edge bg-ink px-2 py-0.5 font-mono text-[11px] uppercase text-white/60">
                project: {project.status}
                {jobStatus ? ` · job: ${jobStatus}` : ''}
              </span>
            </div>
            <p className="text-xs sm:text-sm text-white/65">{detail}</p>
            {workersOffline && (
              <div
                role="alert"
                data-testid="worker-offline-warning"
                className="rounded border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-xs text-warn"
              >
                Analysis worker offline (0 connected workers). Processing will start automatically once a worker connects.
              </div>
            )}
            {retryNotice && <p className="text-xs text-accent">{retryNotice}</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-md border border-edge bg-ink px-3 py-1.5 text-xs text-white/80 hover:border-accent hover:text-white"
              >
                Check Status
              </button>
              {!isAnalyzing && (
                <button
                  type="button"
                  disabled={retryingAnalysis}
                  onClick={() => void handleRetryAnalysis()}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-50"
                >
                  {retryingAnalysis ? 'Checking queue…' : 'Retry Analysis'}
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {project.status === 'FAILED' && (
        <div
          role="alert"
          data-testid="project-analysis-failed"
          className="mt-6 rounded-lg border border-warn/40 bg-warn/10 p-5 space-y-3"
        >
          <p className="text-sm font-medium text-warn">
            Analysis couldn&apos;t finish. View the error and retry.
          </p>
          {(project.analysisJob?.error || project.latestError?.message) && (
            <p className="font-mono text-xs text-white/80 bg-ink/80 border border-edge rounded px-3 py-2">
              {project.analysisJob?.error || project.latestError?.message}
            </p>
          )}
          {retryNotice && <p className="text-xs text-accent">{retryNotice}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={retryingAnalysis}
              onClick={() => void handleRetryAnalysis()}
              className="rounded-md bg-accent px-3.5 py-1.5 text-xs font-medium text-ink disabled:opacity-50"
            >
              {retryingAnalysis ? 'Retrying…' : 'Retry Analysis'}
            </button>
            <a
              href="/dashboard"
              className="rounded-md border border-edge bg-ink px-3.5 py-1.5 text-xs text-white/80 hover:text-white"
            >
              Back to Dashboard
            </a>
          </div>
        </div>
      )}

      {(a || hasMediaSourceEditor) && (
        <p className="mt-4 text-xs font-mono text-signal">Your highlights are ready.</p>
      )}

      {hasMediaSourceEditor && (
        <SourceHighlightsEditorPanel
          projectId={id}
          initialHighlightId={initialHighlightId}
          onVersionCreated={async () => {
            await load();
            setVersionRefresh((k) => k + 1);
            setEditorKey((k) => k + 1);
          }}
        />
      )}

      {(a || hasMediaSourceEditor) && (
        <>
          {/* analysis summary (for direct-upload AI analysis projects) */}
          {a && (
            <div className="mt-8 grid lg:grid-cols-2 gap-8">
              <section>
                <h2 className="font-display text-sm uppercase tracking-wider text-white/40 mb-2">Summary</h2>
                <p className="text-sm text-white/80">{a.summary}</p>
                {a.strategy && (
                  <>
                    <h2 className="font-display text-sm uppercase tracking-wider text-white/40 mt-6 mb-2">Director strategy</h2>
                    <p className="text-sm text-white/70">{a.strategy}</p>
                  </>
                )}
                {a.hook?.hook && (
                  <div className="mt-4 bg-panel border border-accent/30 rounded p-3">
                    <span className="font-mono text-[11px] text-accent uppercase">Hook</span>
                    <p className="text-sm text-white/80 mt-0.5">“{a.hook.hook.text}”</p>
                    <p className="font-mono text-[11px] text-white/30 mt-0.5">
                      {Math.floor(a.hook.hook.start)}s–{Math.floor(a.hook.hook.end)}s
                    </p>
                  </div>
                )}
                {a.thumbnail && (
                  <div className="mt-3 bg-panel border border-edge rounded p-3">
                    <span className="font-mono text-[11px] text-signal uppercase">Thumbnail</span>
                    <p className="text-sm text-white/80 mt-0.5">{a.thumbnail.overlayText}</p>
                    <p className="text-xs text-white/50 mt-0.5">{a.thumbnail.concept}</p>
                  </div>
                )}
                <h2 className="font-display text-sm uppercase tracking-wider text-white/40 mt-6 mb-2">Suggested titles</h2>
                <ul className="space-y-1 text-sm text-white/80 list-disc list-inside">
                  {a.suggestedTitles?.map((title: string, i: number) => <li key={i}>{title}</li>)}
                </ul>
              </section>
              <section>
                <h2 className="font-display text-sm uppercase tracking-wider text-white/40 mb-2">Social copy</h2>
                <div className="space-y-2 text-sm">
                  {a.socialCopy &&
                    Object.entries(a.socialCopy).map(([k, v]) => (
                      <div key={k} className="bg-panel border border-edge rounded px-3 py-2">
                        <span className="font-mono text-[11px] text-accent uppercase">{k}</span>
                        <p className="text-white/80 mt-0.5">{v as string}</p>
                      </div>
                    ))}
                </div>
              </section>
            </div>
          )}

          {/* timeline editor + version history */}
          <section className="mt-10">
            <h2 className="font-display text-lg mb-4">Edit timeline</h2>
            {rendering ? (
              <div className="bg-panel border border-edge rounded-lg p-6">
                <p className="text-sm text-white/70 mb-2">
                  Rendering {rendering.status === 'RUNNING' ? '' : '(queued)'}… {rendering.pct}%
                </p>
                <div className="h-2 rounded-full bg-edge overflow-hidden">
                  <div className="h-full bg-accent transition-all" style={{ width: `${rendering.pct}%` }} />
                </div>
              </div>
            ) : (
              t && (
                <div className="grid lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2">
                    <TimelineEditor
                      key={editorKey /* remount only when a restore changes the working ops */}
                      projectId={id}
                      duration={sourceDuration}
                      initialOps={t.operations ?? []}
                      initialEffects={t.effects ?? { subtitles: true, zooms: true, transitions: 'fade', music: false }}
                      silences={((a?.silences as any[]) ?? [])}
                      onRender={(renderId) => setRendering({ id: renderId, pct: 0 })}
                      onVersionCreated={() => setVersionRefresh((k) => k + 1)}
                    />
                  </div>
                  <div className="lg:col-span-1">
                    <VersionSidebar
                      projectId={id}
                      refreshKey={versionRefresh}
                      onRestored={async () => {
                        await load();
                        setVersionRefresh((k) => k + 1);
                        setEditorKey((k) => k + 1);
                      }}
                      onCompare={(aId, bId) => setCompare({ a: aId, b: bId })}
                    />
                  </div>
                </div>
              )
            )}
          </section>

          {compare && (
            <CompareView projectId={id} aId={compare.a} bId={compare.b} onClose={() => setCompare(null)} />
          )}
          {showFeedback && <FeedbackModal projectId={id} onClose={() => setShowFeedback(false)} />}

          {/* one-click repurposing (only for classic upload-analysis projects) */}
          {a && (
            <section className="mt-8">
              <RepurposePanel projectId={id} onQueued={load} />
            </section>
          )}

          {/* completed renders */}
          {completed.length > 0 && (
            <section className="mt-8">
              <h2 className="font-display text-sm uppercase tracking-wider text-white/40 mb-2">Renders</h2>
              <div className="space-y-2">
                {completed.map((r: any) => (
                  <a
                    key={r.id}
                    href={r.outputUrl}
                    target="_blank"
                    className="flex items-center justify-between bg-panel border border-edge rounded px-3 py-2 hover:border-signal/50"
                  >
                    <span className="text-sm capitalize">{r.format}</span>
                    <span className="text-sm text-signal">↓ Download</span>
                  </a>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
