/**
 * TASK-1047 FC-4 — what a gateway composer hands the egress enrichment about the system message it
 * composed, and the wire field the enrichment derives from it.
 *
 * The composer knows two things the enrichment cannot reconstruct: the composed `governance`
 * (piece digests + `composedDigest`, from `composeMessages`) and the TEXT of the platform-owned
 * pieces it emitted (platform rules, the output-language sentence, each output-contract part). The
 * first decides whether `system_governance` may be sent; the second is offered to the registry
 * (`registerPlatformPieces`) so those pieces become governed once screened. Neither ever carries a
 * runtime value — after FC-1 the system message is static text by construction.
 */
import { createHash } from 'node:crypto';
import { PLATFORM_RULES_VERSION, outputLanguageStep, type GovernedPieceKind, type SystemGovernance } from '@arcaai/workflow-contract';
import type { GovernedPieceInput } from '../governed-prompt/IGovernedPromptRegistry';

/** One static output-contract part, as `composeMessages`' `outputContractParts` takes it. */
export interface OutputContractPart {
  readonly key: string;
  readonly text: string;
}

/** The composer's half of FC-4, carried on `TextEgressHints.systemGovernance`. */
export interface SystemGovernanceHint {
  /** `composeMessages`' `governance`; absent ⇒ the system prompt is screened as untrusted. */
  readonly governance?: SystemGovernance | null;
  /** The PLATFORM / LANGUAGE / CONTRACT pieces the composer emitted, for background registration. */
  readonly platformPieces?: readonly GovernedPieceInput[];
  /** The tenant the call runs for, when the caller knows it better than CLS does. */
  readonly tenantId?: string | null;
}

/** The FC-4 body field on `/api/v1/generate`. */
export interface SystemGovernanceWire {
  composed_digest: string;
  pieces: Array<{ kind: GovernedPieceKind; key: string; digest: string }>;
  policy_version: string;
}

/**
 * The platform-owned pieces a composer emitted, keyed as FC-2 keys them (`platform-rules@<v>`,
 * `language:<name>`, the contract part's own key). Empty texts are what the composer did NOT emit,
 * so they are left out.
 */
export function platformPiecesOf(input: {
  platformRules?: string | null;
  platformRulesVersion?: string;
  outputLanguageName?: string | null;
  /** The sentence the composer emitted for the language; defaults to the contract's own step. */
  outputLanguageSentence?: string;
  contractParts?: readonly OutputContractPart[];
}): GovernedPieceInput[] {
  const pieces: GovernedPieceInput[] = [];
  const piece = (kind: GovernedPieceKind, sourceKey: string, text: string): GovernedPieceInput => ({
    kind,
    sourceType: 'PLATFORM',
    sourceId: null,
    sourceKey,
    text,
  });
  if (input.platformRules)
    pieces.push(piece('PLATFORM', `platform-rules@${input.platformRulesVersion ?? PLATFORM_RULES_VERSION}`, input.platformRules));
  if (input.outputLanguageName) {
    pieces.push(
      piece('LANGUAGE', `language:${input.outputLanguageName}`, input.outputLanguageSentence ?? outputLanguageStep(input.outputLanguageName)),
    );
  }
  for (const part of input.contractParts ?? []) {
    if (part.text.length > 0) pieces.push(piece('CONTRACT', part.key, part.text));
  }
  return pieces;
}

/** The registry calls `governedSystemWire` makes (a structural subset of `IGovernedPromptRegistry`). */
export interface GovernedSystemVerifier {
  areGoverned(tenantId: string, digests: readonly string[]): Promise<boolean>;
  currentPolicyVersion(tenantId?: string): Promise<string | null>;
}

/**
 * TASK-1047 FC-4 — the `system_governance` object for `system`, or `null` when it may not be sent:
 * no governance, a system that no longer hashes to `composedDigest`, a piece the registry does not
 * vouch for under the REQUEST tenant's current policy version, or an unknown policy version.
 * Registry errors propagate — each caller decides how to degrade (always: send nothing).
 */
export async function governedSystemWire(
  registry: GovernedSystemVerifier,
  input: { system: string; governance: SystemGovernance | null | undefined; tenantId: string },
): Promise<SystemGovernanceWire | null> {
  const { system, governance, tenantId } = input;
  if (!governance || system.length === 0) return null;
  if (createHash('sha256').update(system, 'utf8').digest('hex') !== governance.composedDigest) return null;
  if (
    !(await registry.areGoverned(
      tenantId,
      governance.pieces.map((piece) => piece.digest),
    ))
  )
    return null;
  const policyVersion = await registry.currentPolicyVersion(tenantId);
  if (!policyVersion) return null;
  return {
    composed_digest: governance.composedDigest,
    pieces: governance.pieces.map(({ kind, key, digest }) => ({ kind, key, digest })),
    policy_version: policyVersion,
  };
}
