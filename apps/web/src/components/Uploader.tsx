'use client';

import { useCallback, useRef, useState } from 'react';
import { uploadVideo } from '@/lib/api';
import { cn } from '@/lib/utils';

export function Uploader({ onDone }: { onDone: (projectId: string) => void }) {
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      if (!file.type.startsWith('video/')) return setError('Please choose a video file.');
      setProgress(0);
      try {
        const res = await uploadVideo(file, setProgress);
        setProgress(100);
        onDone(res.projectId);
      } catch (e: any) {
        setError(e.message);
        setProgress(null);
      }
    },
    [onDone],
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) handleFile(f);
      }}
      onClick={() => inputRef.current?.click()}
      className={cn(
        'cursor-pointer rounded-xl border-2 border-dashed p-12 text-center transition-colors',
        dragging ? 'border-accent bg-accent/5' : 'border-edge hover:border-accent/50',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />
      {progress === null ? (
        <>
          <p className="font-display text-lg">Drop a video to start</p>
          <p className="text-sm text-white/50 mt-1">MP4, MOV, up to 5 GB. Uploads straight to S3.</p>
        </>
      ) : (
        <div className="max-w-md mx-auto">
          <p className="text-sm text-white/70 mb-2">
            {progress < 100 ? `Uploading… ${progress}%` : 'Uploaded — Claude is analyzing.'}
          </p>
          <div className="h-2 rounded-full bg-edge overflow-hidden">
            <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-warn">{error}</p>}
    </div>
  );
}
