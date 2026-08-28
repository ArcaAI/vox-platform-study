export * from './endpoint.request';
export * from './endpoint.response';

/**
 * The proposal shape the SERVICE works with, structurally compatible with the request DTO but
 * free of decorators — mirrors the `HarnessAssembleRequest`-style split the rest of this folder
 * uses, and keeps `consultation-endpoint.service.ts` importable from a plain unit test.
 */
export interface CorrectionProposal {
  readonly proposalId: string;
  readonly start: number;
  readonly end: number;
  readonly original: string;
  readonly proposed: string;
  readonly category?: string;
  readonly confidence?: number;
  readonly status: string;
}
