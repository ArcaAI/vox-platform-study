import type { DnaSampleSource } from '@arcaai/domains';

/**
 * TASK-1034 — the in-process event a clinical write emits AFTER it has committed, asking the DNA
 * memory to capture the clinician's edited / signed note. An event (not a direct call) so the
 * consultation modules take no dependency on the DNA module, and so a capture problem can never
 * reach the clinical action: the listener swallows every error.
 */
export const DNA_MEMORY_CAPTURE_EVENT = 'dna.memory.capture-requested';

export interface DnaMemoryCaptureRequest {
  tenantId: string;
  consultationId: string;
  contextItemId: string;
  source: DnaSampleSource.EDIT | DnaSampleSource.SIGNOFF | 'EDIT' | 'SIGNOFF';
}
