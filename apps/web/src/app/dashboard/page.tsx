'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { dashboard, projects as projectsApi, auth } from '@/lib/api';
import { Uploader } from '@/components/Uploader';
import { UniversalMediaWorkspace } from '@/components/UniversalMediaWorkspace';

const STATUS_COLOR: Record<string, string> = {
  RENDERED: 'text-signal',
  RENDERING: 'text-accent',
  ANALYZING: 'text-accent',
  ANALYZED: 'text-white/80',
  FAILED: 'text-warn',
};

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [list, setList] = useState<any[]>([]);
  const uploaderSectionRef = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const [d, p] = await Promise.all([dashboard.get(), projectsApi.list()]);
      setData(d);
      setList(p.projects);
    } catch {
      router.push('/login');
    }
  }
  useEffect(() => {
    load();
  }, []);

  return (
    <main className="min-h-screen max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3 mb-8">
        <span className="font-display text-lg">AutoEdit<span className="text-accent">.AI</span></span>
        <nav className="flex flex-wrap items-center gap-4 text-sm">
          <a href="/media" className="text-accent hover:text-white">Media Hub</a>
          <a href="/analytics" className="text-white/50 hover:text-white">Analytics</a>
          <a href="/settings" className="text-white/50 hover:text-white">Preferences</a>
          <a href="/settings/integrations" className="text-white/50 hover:text-white">Integrations</a>
          <button
            onClick={async () => {
              await auth.logout();
              router.push('/login');
            }}
            className="text-white/50 hover:text-white"
          >
            Sign out
          </button>
        </nav>
      </header>

      <div ref={uploaderSectionRef}>
        <Uploader onDone={(id) => router.push(`/projects/${id}`)} />
      </div>

      <div className="mt-6">
        <UniversalMediaWorkspace
          uploadedProjects={list}
          onRequestNewUpload={() => {
            uploaderSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-6 mt-10">
        {/* recent projects */}
        <section className="lg:col-span-2">
          <h2 className="font-display text-sm uppercase tracking-wider text-white/40 mb-3">Recent projects</h2>
          <div className="space-y-2">
            {list.length === 0 && <p className="text-sm text-white/40">No projects yet — upload a video above.</p>}
            {list.map((p) => (
              <button
                key={p.id}
                onClick={() => router.push(`/projects/${p.id}`)}
                className="w-full text-left bg-panel border border-edge rounded-lg p-4 hover:border-accent/50 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{p.title}</p>
                  <p className="text-xs text-white/40 mt-0.5">
                    {new Date(p.createdAt).toLocaleString()}
                  </p>
                </div>
                <span className={`text-xs font-mono shrink-0 ${STATUS_COLOR[p.status] ?? 'text-white/50'}`}>{p.status}</span>
              </button>
            ))}
          </div>
        </section>

        {/* activity feed */}
        <section>
          <h2 className="font-display text-sm uppercase tracking-wider text-white/40 mb-3">AI activity</h2>
          <div className="space-y-3">
            {data?.activity?.map((a: any) => (
              <div key={a.id} className="text-sm border-l-2 border-edge pl-3">
                <p className="text-white/80">{a.message}</p>
                <p className="text-[11px] text-white/30 mt-0.5 font-mono">
                  {a.kind} · {new Date(a.createdAt).toLocaleTimeString()}
                </p>
              </div>
            ))}
            {!data?.activity?.length && <p className="text-sm text-white/40">Nothing yet.</p>}
          </div>
        </section>
      </div>
    </main>
  );
}
