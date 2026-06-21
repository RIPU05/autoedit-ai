import { vi } from 'vitest';

type Row = Record<string, any>;

let seq = 0;
const id = (prefix: string) => `${prefix}_${++seq}`;

export const db = {
  users: [] as Row[],
  projects: [] as Row[],
  assets: [] as Row[],
  jobs: [] as Row[],
  renders: [] as Row[],
  integrationAccounts: [] as Row[],
  activityLogs: [] as Row[],
  transcripts: [] as Row[],
  analyses: [] as Row[],
  timelines: [] as Row[],
  versions: [] as Row[],
  errorEvents: [] as Row[],
};

export function resetDb() {
  seq = 0;
  for (const value of Object.values(db)) value.splice(0, value.length);
}

function selectRow(row: Row | null, select?: Row) {
  if (!row || !select) return row;
  return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]));
}

function matches(row: Row, where: Row = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('userId_provider' in where && key === 'userId_provider') {
        return row.userId === value.userId && row.provider === value.provider;
      }
      return matches(row[key] ?? {}, value);
    }
    return row[key] === value;
  });
}

function makeModel(table: Row[], prefix: string) {
  return {
    findUnique: vi.fn(async (args: Row) => selectRow(table.find((row) => matches(row, args.where)) ?? null, args.select)),
    findFirst: vi.fn(async (args: Row = {}) => selectRow(table.find((row) => matches(row, args.where)) ?? null, args.select)),
    findMany: vi.fn(async (args: Row = {}) => table.filter((row) => matches(row, args.where)).map((row) => selectRow(row, args.select))),
    count: vi.fn(async (args: Row = {}) => table.filter((row) => matches(row, args.where)).length),
    create: vi.fn(async (args: Row) => {
      const row = { id: id(prefix), createdAt: new Date(), updatedAt: new Date(), ...args.data };
      table.push(row);
      return row;
    }),
    createMany: vi.fn(async (args: Row) => {
      for (const item of args.data ?? []) table.push({ id: id(prefix), createdAt: new Date(), updatedAt: new Date(), ...item });
      return { count: args.data?.length ?? 0 };
    }),
    update: vi.fn(async (args: Row) => {
      const row = table.find((item) => matches(item, args.where));
      if (!row) throw new Error(`${prefix} not found`);
      Object.assign(row, args.data, { updatedAt: new Date() });
      return selectRow(row, args.select);
    }),
    upsert: vi.fn(async (args: Row) => {
      const row = table.find((item) => matches(item, args.where));
      if (row) {
        Object.assign(row, args.update, { updatedAt: new Date() });
        return selectRow(row, args.select);
      }
      const created = { id: id(prefix), createdAt: new Date(), updatedAt: new Date(), ...args.create };
      table.push(created);
      return selectRow(created, args.select);
    }),
  };
}

export const prismaMock = {
  user: makeModel(db.users, 'user'),
  project: makeModel(db.projects, 'project'),
  asset: makeModel(db.assets, 'asset'),
  job: makeModel(db.jobs, 'job'),
  render: makeModel(db.renders, 'render'),
  integrationAccount: makeModel(db.integrationAccounts, 'integration'),
  activityLog: makeModel(db.activityLogs, 'activity'),
  transcript: makeModel(db.transcripts, 'transcript'),
  analysis: makeModel(db.analyses, 'analysis'),
  editTimeline: makeModel(db.timelines, 'timeline'),
  editVersion: makeModel(db.versions, 'version'),
  errorEvent: makeModel(db.errorEvents, 'error'),
  n8nConnection: { findUnique: vi.fn(async () => null) },
  workflowRun: {
    findMany: vi.fn(async () => []),
    create: vi.fn(async (args: Row) => ({ id: id('workflow'), createdAt: new Date(), updatedAt: new Date(), ...args.data })),
  },
  stageTiming: { create: vi.fn(async (args: Row) => ({ id: id('stage'), ...args.data })) },
  $queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
  $disconnect: vi.fn(async () => undefined),
};

export const queueAdds = {
  analysis: [] as Row[],
  render: [] as Row[],
  n8n: [] as Row[],
};

export function resetQueues() {
  for (const value of Object.values(queueAdds)) value.splice(0, value.length);
}
