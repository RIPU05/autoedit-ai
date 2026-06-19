'use client';

import { useRef, useCallback } from 'react';

export interface VTOp {
  index: number;
  start: number;
  end: number;
  label?: string;
  keep?: boolean;
  zoom?: number;
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

/**
 * Direct-manipulation timeline. Clip blocks can be dragged by their edges to
 * trim, or by their body to move. A draggable playhead scrubs the preview.
 * Fully controlled: emits new ops via onChange and time via onSeek.
 */
export function VisualTimeline({
  ops,
  duration,
  silences,
  playhead,
  selectedIndex,
  onChange,
  onSeek,
  onSelect,
}: {
  ops: VTOp[];
  duration: number;
  silences: { start: number; end: number }[];
  playhead: number;
  selectedIndex: number | null;
  onChange: (ops: VTOp[]) => void;
  onSeek: (t: number) => void;
  onSelect: (index: number | null) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dur = duration || 1;

  const pxToTime = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * dur;
    },
    [dur],
  );

  // generic pointer-drag helper
  function startDrag(e: React.PointerEvent, onMove: (t: number) => void) {
    e.preventDefault();
    e.stopPropagation();
    const move = (ev: PointerEvent) => onMove(pxToTime(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function trimStart(op: VTOp, e: React.PointerEvent) {
    startDrag(e, (t) => {
      const start = Math.min(Math.max(0, t), op.end - 0.2);
      onChange(ops.map((o) => (o.index === op.index ? { ...o, start: +start.toFixed(2) } : o)));
    });
  }
  function trimEnd(op: VTOp, e: React.PointerEvent) {
    startDrag(e, (t) => {
      const end = Math.max(Math.min(dur, t), op.start + 0.2);
      onChange(ops.map((o) => (o.index === op.index ? { ...o, end: +end.toFixed(2) } : o)));
    });
  }
  function moveClip(op: VTOp, e: React.PointerEvent) {
    const grabAt = pxToTime(e.clientX);
    const offset = grabAt - op.start;
    const len = op.end - op.start;
    startDrag(e, (t) => {
      let start = t - offset;
      start = Math.min(Math.max(0, start), dur - len);
      onChange(ops.map((o) => (o.index === op.index ? { ...o, start: +start.toFixed(2), end: +(start + len).toFixed(2) } : o)));
    });
  }

  // ruler ticks every ~1/8 of duration
  const ticks = Array.from({ length: 9 }, (_, i) => (i / 8) * dur);

  return (
    <div className="select-none">
      {/* ruler */}
      <div className="flex justify-between font-mono text-[10px] text-white/30 mb-1">
        {ticks.map((t, i) => (
          <span key={i}>{fmt(t)}</span>
        ))}
      </div>

      {/* track */}
      <div
        ref={trackRef}
        className="relative h-20 rounded-md bg-ink border border-edge overflow-hidden cursor-text"
        onPointerDown={(e) => onSeek(pxToTime(e.clientX))}
      >
        {/* silences */}
        {silences.map((s, i) => (
          <div
            key={`sil-${i}`}
            className="absolute top-0 bottom-0 bg-white/5 pointer-events-none"
            style={{ left: `${(s.start / dur) * 100}%`, width: `${((s.end - s.start) / dur) * 100}%` }}
          />
        ))}

        {/* clips */}
        {ops.map((op) => {
          const left = (op.start / dur) * 100;
          const width = ((op.end - op.start) / dur) * 100;
          const sel = op.index === selectedIndex;
          return (
            <div
              key={op.index}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelect(op.index);
                moveClip(op, e);
              }}
              className={[
                'absolute top-2 bottom-2 rounded-sm flex items-center justify-center cursor-grab active:cursor-grabbing',
                op.keep === false ? 'bg-white/10 border border-white/20' : 'bg-accent/80 border border-accent',
                sel ? 'ring-2 ring-white' : '',
              ].join(' ')}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${op.label ?? 'clip'} (${fmt(op.start)}–${fmt(op.end)})`}
            >
              {/* trim handles */}
              <span
                onPointerDown={(e) => trimStart(op, e)}
                className="absolute left-0 top-0 bottom-0 w-2 bg-white/40 hover:bg-white cursor-ew-resize rounded-l-sm"
              />
              <span className="text-[10px] font-mono text-ink truncate px-2">{op.index + 1}</span>
              <span
                onPointerDown={(e) => trimEnd(op, e)}
                className="absolute right-0 top-0 bottom-0 w-2 bg-white/40 hover:bg-white cursor-ew-resize rounded-r-sm"
              />
            </div>
          );
        })}

        {/* playhead */}
        <div
          onPointerDown={(e) => {
            e.stopPropagation();
            startDrag(e, onSeek);
          }}
          className="absolute top-0 bottom-0 w-0.5 bg-signal cursor-ew-resize z-10"
          style={{ left: `${(playhead / dur) * 100}%` }}
        >
          <span className="absolute -top-0.5 -left-1 w-2.5 h-2.5 rounded-full bg-signal" />
        </div>
      </div>

      <p className="mt-1 font-mono text-[11px] text-white/30">
        drag clip edges to trim · drag body to move · click track or drag the dot to scrub
      </p>
    </div>
  );
}
