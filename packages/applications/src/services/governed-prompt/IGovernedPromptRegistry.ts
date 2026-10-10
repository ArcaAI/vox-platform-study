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
  readonly code:
    | 'PROMPT_SCREENING_UNSAFE'
    | 'PROMPT_SCREENING_INJECTION'
    | 'PROMPT_CONTAINS_PII'
    | 'PROMPT_SCREENING_UNAVAILABLE'
    | 'PROMPT_SAFETY_ADVISORY'
    | 'PROMPT_INJECTION_ADVISORY'
    | 'PROMPT_QUASI_IDENTIFIER_ADVISORY';
  readonly pieceKind: GovernedPieceKind;
  readonly pieceKey: string | null;
  readonly digest: string;
  readonly reason: string;
  /** TASK-1059 C-3: the guardrail check behind a refusal when it is not a screen check (`medical_scope`). */
  readonly check?: string;
  /** TASK-1059 C-3: the off-scope region keys (digest prefixes, never text) behind a `medical_scope` refusal. */
  readonly regions?: readonly string[];
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
  /**
   * The guardrail policy version verdicts are currently valid under (cached per tenant). `null` when
   * unknown. Guardrail resolves it PER TENANT (tenant → SYSTEM cascade of its selections), so the
   * version is the one for `tenantId`; omitted ⇒ SYSTEM's. (TASK-1047 L3: `tenantId` added
   * additively after L5 made the route tenant-resolved.)
   */
  currentPolicyVersion(tenantId?: string): Promise<string | null>;
  /**
   * Platform pieces (platform rules, platform CONTRACT constants, LANGUAGE sentences) seen by a
   * composer: register any not yet registered under SYSTEM, screening them in the background.
   * Idempotent and non-blocking for the caller; until a piece is registered its calls take the
   * full-screening path.
   *
   * Rows are always OWNED by SYSTEM; they are screened and recorded under the policy version of
   * `tenantId` (the request tenant whose call emitted them — omitted ⇒ SYSTEM), because a tenant that
   * overrides a guardrail selection has a different version and the platform pieces must be
   * registered under it too. (`tenantId` added additively by L3 after L5.)
   */
  registerPlatformPieces(pieces: readonly GovernedPieceInput[], tenantId?: string): Promise<void>;
  /**
   * TASK-1050 / TASK-1049 F2 — `tenantId`'s guardrail policy changed, so its policy version moved and
   * every verdict under the old one is void. Re-screen that tenant's governed sources in the background
   * (bounded concurrency > 1); SYSTEM re-screens every tenant. Coalesced and never throws.
   * Optional so a test double of the original four methods still satisfies the contract.
   */
  scheduleTenantRescreen?(tenantId: string): void;
  /**
   * TASK-1049 F11 — screen authored text WITHOUT registering it (a source with no governed-piece row
   * type, such as a workflow node's binding template). Fail-closed like `screenAndRegister`.
   */
  validateAuthoredPieces?(tenantId: string, pieces: readonly GovernedPieceInput[]): Promise<GovernedScreeningResult>;
}

/**
 * TASK-1047 (owner decision 2026-10-06, "Scope it"): an authoring-time finding BLOCKS only for
 * injection/jailbreak, direct-identifier PII values and an unavailable screen. Safety/toxicity
 * categories and quasi-identifiers (dates, ages, places) with no direct identifier are ADVISORY:
 * reported to the author, the piece still registered — clinical instruction language trips the
 * toxicity/safety models (e.g. a same-day-return fragment flagged `prompt_toxicity`) and a format
 * example such as "12-Mar-2026" is not personal data on its own.
 */
export const ADVISORY_PROMPT_FINDINGS: ReadonlySet<GovernedPieceFinding['code']> = new Set([
  'PROMPT_SAFETY_ADVISORY',
  'PROMPT_INJECTION_ADVISORY',
  'PROMPT_QUASI_IDENTIFIER_ADVISORY',
]);

export function isBlockingPromptFinding(finding: Pick<GovernedPieceFinding, 'code'>): boolean {
  return !ADVISORY_PROMPT_FINDINGS.has(finding.code);
}
