import type {
  EditChange,
  VersionDiff,
  ProjectStatus,
  OutputFormat,
  EditOperation,
} from '@autoedit/contracts';

export type { EditChange, VersionDiff, ProjectStatus, OutputFormat, EditOperation };

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
