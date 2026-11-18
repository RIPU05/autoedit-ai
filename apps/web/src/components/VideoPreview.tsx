'use client';

import { useEffect, useRef, useState } from 'react';

interface Seg {
  start: number;
  end: number;
  keep?: boolean;
}

/**
 * Source video preview, two-way synced with the timeline playhead.
 *  - external playhead (scrubbing the timeline) seeks the video
 *  - playing the video reports time back via onTime
 *  - "Preview edit" mode plays only the kept segments back-to-back, so you can
 *    watch the cut before rendering.
 */
export function VideoPreview({
  url,
  unavailableReason,
  onRefreshUrl,
  playhead,
  onTime,
  segments,
}: {
  url: string | null;
  unavailableReason?: string | null;
  onRefreshUrl?: () => void;
  playhead: number;
  onTime: (t: number) => void;
  segments: Seg[];
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [previewEdit, setPreviewEdit] = useState(false);
  const [autoRefreshed, setAutoRefreshed] = useState(false);
  const segIndex = useRef(0);

  useEffect(() => {
    setAutoRefreshed(false);
  }, [url]);

  const kept = segments.filter((s) => s.keep !== false).sort((a, b) => a.start - b.start);

  // seek when the timeline playhead moves and differs from the video's position
  useEffect(() => {
    const v = ref.current;
    if (!v || previewEdit) return;
    if (Math.abs(v.currentTime - playhead) > 0.3) v.currentTime = playhead;
  }, [playhead, previewEdit]);

  // in preview-edit mode, skip across gaps so only kept segments play
  function handleTimeUpdate() {
    const v = ref.current;
    if (!v) return;
    onTime(v.currentTime);
    if (!previewEdit || kept.length === 0) return;
    const seg = kept[segIndex.current];
    if (!seg) return;
    if (v.currentTime >= seg.end - 0.05) {
      const next = kept[segIndex.current + 1];
      if (next) {
        segIndex.current += 1;
        v.currentTime = next.start;
      } else {
        v.pause();
        setPreviewEdit(false);
        segIndex.current = 0;
      }
    }
  }

  function startPreviewEdit() {
    const v = ref.current;
    if (!v || kept.length === 0) return;
    segIndex.current = 0;
    setPreviewEdit(true);
    v.currentTime = kept[0].start;
    v.play();
  }

  if (!url) {
    return (
      <div
        data-testid={unavailableReason ? 'source-preview-unavailable' : 'source-preview-loading'}
        className="aspect-video rounded-lg bg-panel border border-edge px-6 flex flex-col items-center justify-center text-center gap-3 text-sm text-white/55"
      >
        <span>{unavailableReason || 'Loading preview…'}</span>
        {unavailableReason && onRefreshUrl && (
          <button
            type="button"
            onClick={onRefreshUrl}
            className="text-xs px-3 py-1.5 rounded-md border border-edge bg-ink text-white/75 hover:border-accent hover:text-white"
          >
            Retry preview
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <video
        ref={ref}
        src={url}
        controls
        onTimeUpdate={handleTimeUpdate}
        onError={() => {
          if (!autoRefreshed && onRefreshUrl) {
            setAutoRefreshed(true);
            onRefreshUrl();
          }
        }}
        className="w-full rounded-lg border border-edge bg-black"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          onClick={startPreviewEdit}
          disabled={kept.length === 0}
          className="text-sm px-3 py-1.5 rounded-md bg-signal/20 text-signal border border-signal/40 disabled:opacity-50"
        >
          ▶ Preview edit ({kept.length} clips)
        </button>
        {previewEdit && (
          <button onClick={() => { ref.current?.pause(); setPreviewEdit(false); }} className="text-sm text-white/50">
            Stop
          </button>
        )}
        {onRefreshUrl && (
          <button
            type="button"
            onClick={onRefreshUrl}
            className="text-xs text-white/45 hover:text-white"
          >
            Refresh preview link
          </button>
        )}
        <span className="font-mono text-[11px] text-white/30">jumps across cuts to play only kept clips</span>
      </div>
    </div>
  );
}
