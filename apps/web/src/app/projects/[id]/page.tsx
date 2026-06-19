'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { projects as api } from '@/lib/api';
import { TimelineEditor } from '@/components/TimelineEditor';
import { VersionSidebar } from '@/components/VersionSidebar';
import { CompareView } from '@/components/CompareView';
import { RepurposePanel } from '@/components/RepurposePanel';
import { FeedbackModal } from '@/components/FeedbackModal';

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<any>(null);
  const [rendering, setRendering] = useState<{ id: string; pct: number; status?: string } | null>(null);
  const [versionRefresh, setVersionRefresh] = useState(0); // sidebar reload (prompt edits + restores)
  const [editorKey, setEditorKey] = useState(0); // remount editor only when working ops change (restore)
  const [compare, setCompare] = useState<{ a: string; b: string } | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);

  async function load() {
    const { project } = await api.get(id);
    setProject(project);
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 5000); // refresh while analysis runs
    return () => clearInterval(t);
  }, [id]);

  // poll a render once started
  useEffect(() => {
    if (!rendering) return;
    const t = setInterval(async () => {
      const { render } = await api.renderStatus(id, rendering.id);
      setRendering((r) => (r ? { ...r, pct: render.progress, status: render.status } : r));
      if (render.status === 'COMPLETED' || render.status === 'FAILED') {
        clearInterval(t);
        await load();
        setRendering(null);
        if (render.status === 'COMPLETED') setShowFeedback(true);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [rendering?.id, id]);

  if (!project) return <main className="p-8 text-white/50">Loading…</main>;
  const a = project.analysis;
  const t = project.timeline;
  const completed = (project.renders ?? []).filter((r: any) => r.status === 'COMPLETED');

  return (
    <main className="max-w-5xl mx-auto px-6 py-8">
      <a href="/dashboard" className="text-sm text-white/40 hover:text-white">← Dashboard</a>
      <h1 className="font-display text-2xl mt-2">{project.title}</h1>
      <p className="font-mono text-xs text-white/40 mt-1">status: {project.status}</p>

      {!a && project.status !== 'FAILED' && (
        <p className="mt-8 text-white/60">Claude is analyzing your video… this page updates automatically.</p>
      )}
      {project.status === 'FAILED' && (
        <p className="mt-8 text-warn">Something failed during processing. Check the worker logs and re-upload.</p>
      )}

      {a && (
        <>
          {/* analysis summary */}
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
                      duration={project.sourceAsset?.durationSec ?? 0}
                      initialOps={t.operations ?? []}
                      initialEffects={t.effects ?? { subtitles: true, zooms: true, transitions: 'fade', music: false }}
                      silences={(a.silences as any[]) ?? []}
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
                      onCompare={(a, b) => setCompare({ a, b })}
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

          {/* one-click repurposing */}
          <section className="mt-8">
            <RepurposePanel projectId={id} onQueued={load} />
          </section>

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
