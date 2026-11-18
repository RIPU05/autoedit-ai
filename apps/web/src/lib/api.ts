import type {
  ApplyPrivateProjectEditRequest,
  ApplyPrivateProjectEditResponse,
  CancelPrivateRenderResponse,
  CreatePrivateRenderRequest,
  CreateProjectFromSourceRequest,
  CreateProjectFromSourceResponse,
  MediaHighlightItem,
  MediaJobHighlightsResponse,
  MediaJobResponse,
  PrivateRenderJobResponse,
  ProjectSourcePreviewResponse,
  ResolveMediaSourceResponse,
  SubmitMediaJobRequest,
  UniversalMediaInput,
} from '@autoedit/contracts';
import type { EditChange, Version, VersionDiff } from './types';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  (process.env.NODE_ENV === 'production'
    ? 'https://autoedit-ai.onrender.com'
    : 'http://localhost:4000');

export class ApiError extends Error {
  status: number;
  data: any;

  constructor(status: number, message: string, data?: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

async function api<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: init.signal ?? controller.signal,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body.error ?? `request failed: ${res.status}`, body);
    }
    return (await res.json()) as T;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new ApiError(408, 'request timed out. please check your network connection.');
    }
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, err.message || 'network connection failed');
  } finally {
    clearTimeout(timeoutId);
  }
}

export const auth = {
  register: (email: string, password: string, name?: string) =>
    api<{ user: any }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string) =>
    api<{ user: any }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => api('/api/auth/logout', { method: 'POST' }),
  me: () => api<{ user: any }>('/api/auth/me'),
  googleUrl: () => `${API_BASE_URL}/api/auth/google`,
};

export const dashboard = {
  get: () => api<any>('/api/dashboard'),
};

export const creator = {
  profile: () => api<{ profile: any; learnedSignals: any; description: string }>('/api/creator/profile'),
  update: (patch: Record<string, string>) =>
    api<{ profile: any }>('/api/creator/profile', { method: 'PATCH', body: JSON.stringify(patch) }),
};

export const analytics = {
  mine: () => api<{ tracked: any; key: any }>('/api/analytics'),
  global: () => api<{ tracked: any; key: any }>('/api/analytics/global'),
};

export const feedback = {
  submit: (payload: {
    projectId?: string;
    rating: number;
    comment?: string;
    category?: string;
    answers?: { savedTime?: string; confusing?: string; wouldPay?: string; magical?: string };
  }) => api<{ feedback: any }>('/api/feedback', { method: 'POST', body: JSON.stringify(payload) }),
  admin: () => api<{ items: any[]; count: number; avgRating: number }>('/api/feedback/admin'),
};

type IntegrationStatus = {
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | string;
  metadata: Record<string, unknown>;
  lastTestedAt: string | null;
};

export const integrations = {
  claude: {
    status: () => api<IntegrationStatus>('/api/integrations/claude/status'),
    connect: (apiKey: string) =>
      api<IntegrationStatus>('/api/integrations/claude/connect', {
        method: 'POST',
        body: JSON.stringify({ apiKey }),
      }),
    test: () => api<IntegrationStatus>('/api/integrations/claude/test', { method: 'POST' }),
    disconnect: () => api<{ status: string }>('/api/integrations/claude/disconnect', { method: 'DELETE' }),
  },
  n8n: {
    status: () => api<IntegrationStatus>('/api/integrations/n8n/status'),
    connect: (payload: { webhookUrl: string; workflowName?: string; signingSecret?: string }) =>
      api<IntegrationStatus>('/api/integrations/n8n/connect', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    test: () => api<IntegrationStatus>('/api/integrations/n8n/test', { method: 'POST' }),
    disconnect: () => api<{ status: string }>('/api/integrations/n8n/disconnect', { method: 'DELETE' }),
  },
};

export const projects = {
  list: () => api<{ projects: any[] }>('/api/projects'),
  get: (id: string) => api<{ project: any }>(`/api/projects/${id}`),
  sourceUrl: (id: string) => api<ProjectSourcePreviewResponse>(`/api/projects/${id}/source-url`),
  repurpose: (id: string, platforms: string[]) =>
    api<{ renders: { platform: string; renderId: string; format: string; caption: string }[] }>(
      `/api/projects/${id}/repurpose`,
      { method: 'POST', body: JSON.stringify({ platforms }) },
    ),
  approveTimeline: (id: string, patch: any) =>
    api(`/api/projects/${id}/timeline`, { method: 'PATCH', body: JSON.stringify(patch) }),
  promptEdit: (id: string, instruction: string) =>
    api<{ timeline: any; version: any; changes: EditChange[]; reasoning: string }>(`/api/projects/${id}/edit`, {
      method: 'POST',
      body: JSON.stringify({ instruction }),
    }),
  versions: (id: string) => api<{ versions: Version[]; headId: string | null }>(`/api/projects/${id}/versions`),
  version: (id: string, versionId: string) => api<{ version: Version }>(`/api/projects/${id}/versions/${versionId}`),
  compareVersions: (id: string, a: string, b: string) =>
    api<{ diff: VersionDiff }>(`/api/projects/${id}/versions/compare?a=${a}&b=${b}`),
  restoreVersion: (id: string, versionId: string) =>
    api<{ version: Version }>(`/api/projects/${id}/versions/${versionId}/restore`, { method: 'POST' }),
  renameVersion: (id: string, versionId: string, name: string) =>
    api<{ version: Version }>(`/api/projects/${id}/versions/${versionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  explainClip: (id: string, start: number, end: number, kept: boolean) =>
    api<{ explanation: string; reasons: string[] }>(`/api/projects/${id}/explain`, {
      method: 'POST',
      body: JSON.stringify({ start, end, kept }),
    }),
  render: (id: string, format: 'reel' | 'short' | 'landscape') =>
    api<{ renderId: string }>(`/api/projects/${id}/render`, { method: 'POST', body: JSON.stringify({ format }) }),
  renderStatus: (id: string, renderId: string) =>
    api<{ render: any }>(`/api/projects/${id}/renders/${renderId}`),
  retryAnalysis: (id: string) =>
    api<{ ok: boolean; reusedExistingJob: boolean; analysisJobId: string; jobStatus: string; workersOnline: number | null }>(
      `/api/projects/${id}/retry-analysis`,
      { method: 'POST' },
    ),
};

export interface CancelMediaJobResponse {
  jobId: string;
  status: 'CANCELLED' | 'READY' | 'FAILED';
  alreadyCompleted?: boolean;
  detachedFromSharedWork: boolean;
  sharedWorkStillActive: boolean;
}

export interface ProjectHighlightsResponse {
  projectId: string;
  mediaSourceId: string;
  highlights: MediaHighlightItem[];
}

export interface ProjectPrivateRendersListResponse {
  projectId: string;
  renders: PrivateRenderJobResponse[];
}

/**
 * Authenticated Universal Media API client (Steps 3B.9 / 3B.9.1 / 3C.1 / 3C.1.1).
 * Never sends client-forged rightsStatus, ownerUserId, workerId, storageKey, or canonicalSourceId.
 * Private MP4 renders execute asynchronously in background workers (no 90s blocking HTTP requests).
 */
export const media = {
  resolveSource: (input: UniversalMediaInput) =>
    api<ResolveMediaSourceResponse>('/api/media/sources/resolve', {
      method: 'POST',
      body: JSON.stringify({ input }),
    }),
  submitJob: (req: SubmitMediaJobRequest) =>
    api<MediaJobResponse>('/api/media/jobs', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
  getJobStatus: (jobId: string) =>
    api<MediaJobResponse>(`/api/media/jobs/${encodeURIComponent(jobId)}`),
  cancelJob: (jobId: string) =>
    api<CancelMediaJobResponse>(`/api/media/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    }),
  getJobHighlights: (jobId: string) =>
    api<MediaJobHighlightsResponse>(`/api/media/jobs/${encodeURIComponent(jobId)}/highlights`),
  createProjectFromSource: (req: CreateProjectFromSourceRequest) =>
    api<CreateProjectFromSourceResponse>(
      '/api/media/projects/from-source',
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
      20_000,
    ),
  getProjectHighlights: (projectId: string) =>
    api<ProjectHighlightsResponse>(`/api/media/projects/${encodeURIComponent(projectId)}/highlights`),
  applyProjectEdit: (projectId: string, req: ApplyPrivateProjectEditRequest) =>
    api<ApplyPrivateProjectEditResponse>(
      `/api/media/projects/${encodeURIComponent(projectId)}/edits`,
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
      20_000,
    ),
  enqueueProjectRender: (projectId: string, req: CreatePrivateRenderRequest) =>
    api<PrivateRenderJobResponse>(
      `/api/media/projects/${encodeURIComponent(projectId)}/renders`,
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
      20_000,
    ),
  listProjectRenders: (projectId: string) =>
    api<ProjectPrivateRendersListResponse>(
      `/api/media/projects/${encodeURIComponent(projectId)}/renders`,
    ),
  getPrivateRenderStatus: (projectId: string, renderJobId: string) =>
    api<PrivateRenderJobResponse>(
      `/api/media/projects/${encodeURIComponent(projectId)}/renders/${encodeURIComponent(renderJobId)}`,
    ),
  cancelPrivateRender: (projectId: string, renderJobId: string) =>
    api<CancelPrivateRenderResponse>(
      `/api/media/projects/${encodeURIComponent(projectId)}/renders/${encodeURIComponent(renderJobId)}/cancel`,
      { method: 'POST' },
    ),
};

/**
 * Chunked, resumable-friendly multipart upload straight to S3.
 * The file never streams through our API — only presigned PUTs to S3.
 */
const PART_SIZE = 8 * 1024 * 1024; // 8 MB parts
const UPLOAD_PART_ATTEMPTS = 3;

async function putUploadPart(url: string, blob: Blob, partNumber: number) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_PART_ATTEMPTS; attempt += 1) {
    try {
      const put = await fetch(url, { method: 'PUT', body: blob });
      if (!put.ok) throw new Error(`part ${partNumber} failed: ${put.status}`);
      const etag = put.headers.get('ETag');
      if (!etag) throw new Error(`part ${partNumber} missing ETag; check S3 CORS ExposeHeaders`);
      return etag.replaceAll('"', '');
    } catch (err) {
      lastError = err;
      if (attempt < UPLOAD_PART_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`part ${partNumber} failed`);
}

export async function uploadVideo(file: File, onProgress: (pct: number) => void) {
  const start = await api<{ projectId: string; key: string; uploadId: string }>('/api/upload/start', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, contentType: file.type, title: file.name }),
  });

  const partCount = Math.ceil(file.size / PART_SIZE);
  const parts: { ETag: string; PartNumber: number }[] = [];

  for (let i = 0; i < partCount; i++) {
    const partNumber = i + 1;
    const blob = file.slice(i * PART_SIZE, (i + 1) * PART_SIZE);
    const { url } = await api<{ url: string }>('/api/upload/part', {
      method: 'POST',
      body: JSON.stringify({ key: start.key, uploadId: start.uploadId, partNumber }),
    });
    const etag = await putUploadPart(url, blob, partNumber);
    parts.push({ ETag: etag, PartNumber: partNumber });
    onProgress(Math.round((partNumber / partCount) * 100));
  }

  return api<{ projectId: string; analysisJobId: string }>(
    '/api/upload/complete',
    {
      method: 'POST',
      body: JSON.stringify({
        projectId: start.projectId,
        key: start.key,
        uploadId: start.uploadId,
        contentType: file.type,
        sizeBytes: file.size,
        parts,
      }),
    },
    30_000,
  );
}
