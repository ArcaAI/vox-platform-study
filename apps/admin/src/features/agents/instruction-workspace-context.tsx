import type { PromptTemplate, PromptVersion } from '@arcaai/vox';
import { createContext, useContext, type ReactNode } from 'react';

export interface InstructionWorkspaceValue {
  prompt: PromptTemplate;
  versions: PromptVersion[];
  versionsLoading: boolean;
  /** Refetch the prompt + its versions (after save / activate). */
  reload: () => void;
}

const InstructionWorkspaceContext = createContext<InstructionWorkspaceValue | null>(null);

/**
 * Shares the loaded prompt + version history across the Editor / Version-diff /
 * Playground leaf routes so the `$promptId` layout fetches them once. The layout
 * gates on load, so consumers always receive a non-null `prompt`.
 */
export function InstructionWorkspaceProvider({ value, children }: { value: InstructionWorkspaceValue; children: ReactNode }) {
  return <InstructionWorkspaceContext.Provider value={value}>{children}</InstructionWorkspaceContext.Provider>;
}

export function useInstructionWorkspace(): InstructionWorkspaceValue {
  const ctx = useContext(InstructionWorkspaceContext);
  if (!ctx) throw new Error('useInstructionWorkspace must be used within an InstructionWorkspaceProvider');
  return ctx;
}
