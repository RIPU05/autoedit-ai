export interface EditChange {
  action: 'kept' | 'removed' | 'trimmed' | 'reordered' | 'added' | 'effect';
  target: string;
  reasons: string[];
}

export interface Version {
  id: string;
  name: string;
  userPrompt: string | null;
  aiExplanation: string | null;
  changes: EditChange[];
  parentVersionId: string | null;
  createdAt: string;
  timelineJson?: { operations: any[]; effects: any };
}

export interface VersionDiff {
  clipsAdded: string[];
  clipsRemoved: string[];
  durationChangeSec: number;
  effectChanges: { field: string; from: unknown; to: unknown }[];
  from: { id: string; name: string; durationSec: number };
  to: { id: string; name: string; durationSec: number };
}
