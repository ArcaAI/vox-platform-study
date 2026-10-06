/**
 * TASK-1047 FC-3 — the governed-prompt registry contract (frozen by the orchestrator; Lane L3
 * implements it, Lane L2 consumes it).
 *
 * A system-message PIECE is static prompt text (a template body, a composite fragment, a platform
 * constant). It is screened ONCE, at authoring time, by guardrail; the verdict is recorded against
 * `sha256(text)` and the guardrail policy version. At call time a system message is GOVERNED only if
 * every one of its piece digests is registered PASS under the CURRENT policy version — then
 * `apps/text` skips the per-call ML screen for it (FC-4). Anything else is screened as untrusted data.
 */
import type { GovernedPieceKind } from '@arcaai/workflow-contract';

export const IGovernedPromptRegistry = Symbol('IGovernedPromptRegistry');

export type GovernedPromptSourceKind = 'PROMPT_VERSION' | 'AGENT' | 'PLATFORM';

/** One static piece offered for authoring-time screening. `text` is never stored. */
export interface GovernedPieceInput {
  readonly kind: GovernedPieceKind;
  readonly sourceType: GovernedPromptSourceKind;
  readonly sourceId: string | null;
  readonly sourceKey: string | null;
  readonly text: string;
}

/** One authoring-time finding (codes only — never the screened text). */
export interface GovernedPieceFinding {
  readonly code: 'PROMPT_SCREENING_UNSAFE' | 'PROMPT_SCREENING_INJECTION' | 'PROMPT_CONTAINS_PII' | 'PROMPT_SCREENING_UNAVAILABLE';
  readonly pieceKind: GovernedPieceKind;
  readonly pieceKey: string | null;
  readonly digest: string;
  readonly reason: string;
}

export interface GovernedScreeningResult {
  readonly passed: boolean;
  readonly policyVersion: string | null;
  readonly digests: readonly string[];
  readonly findings: readonly GovernedPieceFinding[];
}

export interface IGovernedPromptRegistry {
  /** Authoring time: screen every piece (guardrail regions, FC-5) and register PASS/FAIL. Fail-closed. */
  screenAndRegister(tenantId: string, pieces: readonly GovernedPieceInput[]): Promise<GovernedScreeningResult>;
  /** Call time: true iff EVERY digest is registered PASS under the current policy version ([tenant, SYSTEM]). */
  areGoverned(tenantId: string, digests: readonly string[]): Promise<boolean>;
  /** The guardrail policy version verdicts are currently valid under (cached). `null` when unknown. */
  currentPolicyVersion(): Promise<string | null>;
}
