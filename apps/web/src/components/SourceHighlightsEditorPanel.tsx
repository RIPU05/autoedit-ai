'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaHighlightItem } from '@autoedit/contracts';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Scissors,
  Sparkles,
} from 'lucide-react';
import { media as mediaApi } from '@/lib/api';
import {
  formatMediaApiError,
  formatTimestampRange,
} from '@/lib/media-workspace';
import { cn } from '@/lib/utils';

type EditMode = 'auto' | 'prompt' | 'reference' | 'manual';

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

  const [applying, setApplying] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [latestEdit, setLatestEdit] = useState<{
    versionId: string;
    customEditHash: string;
    downloadUrl?: string;
    downloadUrlExpiresInSec?: number;
  } | null>(null);

  const retriedUrlsRef = useRef<Set<string>>(new Set());

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
      setError(formatMediaApiError(err).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, initialHighlightId, selectedId]);

  useEffect(() => {
    void loadHighlights();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function selectHighlight(hl: MediaHighlightItem) {
    setSelectedId(hl.highlightId);
    setWindowStartSec(Number(hl.windowStartSec.toFixed(1)));
    setWindowEndSec(Number(hl.windowEndSec.toFixed(1)));
    setVersionName(`Cut ${formatTimestampRange(hl.windowStartSec, hl.windowEndSec)}`);
  }

  async function applyPrivateEdit(renderOutput: boolean) {
    if (applying) return;
    if (!Number.isFinite(windowStartSec) || !Number.isFinite(windowEndSec) || windowEndSec <= windowStartSec) {
      setEditError('End time must be greater than start time.');
      return;
    }
    setApplying(true);
    setEditError(null);
    try {
      const res = await mediaApi.applyProjectEdit(projectId, {
        mode,
        versionName: versionName.trim() || `${mode.toUpperCase()} private cut`,
        userPrompt: userPrompt.trim() || undefined,
        windowStartSec,
        windowEndSec,
        effects: { subtitles, zooms, transitions, music },
        renderOutput,
      });
      setLatestEdit({
        versionId: res.versionId,
        customEditHash: res.customEditHash,
        downloadUrl: res.downloadUrl,
        downloadUrlExpiresInSec: res.downloadUrlExpiresInSec,
      });
      onVersionCreated?.();
    } catch (err: any) {
      setEditError(formatMediaApiError(err).message);
    } finally {
      setApplying(false);
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

      {/* 4 Editing Modes (Auto / Prompt / Reference / Manual) + Private MP4 Export */}
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
              onClick={() => setMode(m.id)}
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
              onChange={(e) => setVersionName(e.target.value)}
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
              onChange={(e) => setWindowStartSec(Number(e.target.value))}
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
              onChange={(e) => setWindowEndSec(Number(e.target.value))}
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
              onChange={(e) => setUserPrompt(e.target.value)}
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
            <input type="checkbox" checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} />
            Subtitles
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={zooms} onChange={(e) => setZooms(e.target.checked)} />
            Zooms
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={transitions === 'fade'}
              onChange={(e) => setTransitions(e.target.checked ? 'fade' : 'none')}
            />
            Fade transitions
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={music} onChange={(e) => setMusic(e.target.checked)} />
            Music bed
          </label>
        </div>

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
            {applying ? 'Rendering private MP4…' : 'Save Version & Render Private MP4'}
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

        {latestEdit && (
          <div
            data-testid="private-edit-result"
            className="rounded-lg border border-signal/40 bg-signal/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
          >
            <div className="flex items-center gap-2 text-xs sm:text-sm text-signal">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>Private edit version saved to your timeline history.</span>
            </div>
            {latestEdit.downloadUrl && (
              <a
                href={latestEdit.downloadUrl}
                download={`autoedit-private-clip-${latestEdit.customEditHash.slice(0, 8)}.mp4`}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="private-edit-download-link"
                className="inline-flex items-center gap-1.5 rounded-lg bg-signal px-3.5 py-1.5 text-xs font-medium text-ink shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                Download Private MP4
              </a>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
