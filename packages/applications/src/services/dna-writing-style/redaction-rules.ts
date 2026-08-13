// DNA redaction/rewrite rule shape + a strict JSON-shape validator.
//
// The rules are authored by a doctor (or an admin on their behalf) and persisted
// encrypted-at-rest on their DNA report. They are later decrypted gateway-side and
// threaded to the harness `apply_redaction` activity, whose Pydantic `RedactionRule`
// is the runtime authority. This validator is the WRITE-PATH gate: it rejects a
// malformed rule set at the API boundary (a 400) rather than letting a bad rule reach
// the workflow and fail closed to a FLAG mid-consultation.

import { BadRequestException } from '@nestjs/common';

/** Rule action: delete the match (`remove`) or replace it (`rewrite`). */
export type RedactionRuleType = 'remove' | 'rewrite';
/** How `pattern` is interpreted. */
export type RedactionMatchKind = 'literal' | 'regex' | 'category';

export interface RedactionRule {
  id: string;
  type: RedactionRuleType;
  match: RedactionMatchKind;
  pattern: string;
  /**
   * For `rewrite` rules: the literal replacement. A `rewrite` rule with NO
   * `replacement` is a *semantic* rewrite handled by the harness SMR pass — valid
   * here, resolved there.
   */
  replacement?: string;
  note?: string;
}

/** The persisted container shape (`{ rules: [...] }`) — matches the encrypted JSON. */
export interface RedactionRuleSet {
  rules: RedactionRule[];
}

const RULE_TYPES: readonly RedactionRuleType[] = ['remove', 'rewrite'];
const MATCH_KINDS: readonly RedactionMatchKind[] = ['literal', 'regex', 'category'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an arbitrary payload as a {@link RedactionRuleSet}, throwing
 * `BadRequestException` on any structural violation. Returns a normalized copy
 * (unknown keys dropped) safe to persist. A `regex`-match rule's pattern is
 * compiled to reject an invalid regex up front (so it never fails closed later).
 */
export function validateRedactionRuleSet(payload: unknown): RedactionRuleSet {
  if (!isPlainObject(payload) || !Array.isArray((payload as { rules?: unknown }).rules)) {
    throw new BadRequestException('redaction rules must be an object of shape { rules: [...] }');
  }

  const rawRules = (payload as { rules: unknown[] }).rules;
  const seenIds = new Set<string>();
  const rules: RedactionRule[] = rawRules.map((raw, i) => {
    if (!isPlainObject(raw)) {
      throw new BadRequestException(`rule[${i}] must be an object`);
    }
    const { id, type, match, pattern, replacement, note } = raw as Record<string, unknown>;

    if (typeof id !== 'string' || id.trim() === '') {
      throw new BadRequestException(`rule[${i}].id is required`);
    }
    if (seenIds.has(id)) {
      throw new BadRequestException(`duplicate rule id ${JSON.stringify(id)}`);
    }
    seenIds.add(id);

    if (typeof type !== 'string' || !RULE_TYPES.includes(type as RedactionRuleType)) {
      throw new BadRequestException(`rule ${JSON.stringify(id)}: type must be one of ${RULE_TYPES.join(' | ')}`);
    }
    if (typeof match !== 'string' || !MATCH_KINDS.includes(match as RedactionMatchKind)) {
      throw new BadRequestException(`rule ${JSON.stringify(id)}: match must be one of ${MATCH_KINDS.join(' | ')}`);
    }
    if (typeof pattern !== 'string' || pattern === '') {
      throw new BadRequestException(`rule ${JSON.stringify(id)}: pattern is required`);
    }
    if (match === 'regex') {
      try {
        new RegExp(pattern);
      } catch {
        throw new BadRequestException(`rule ${JSON.stringify(id)}: pattern is not a valid regular expression`);
      }
    }
    if (replacement !== undefined && typeof replacement !== 'string') {
      throw new BadRequestException(`rule ${JSON.stringify(id)}: replacement must be a string`);
    }
    if (note !== undefined && typeof note !== 'string') {
      throw new BadRequestException(`rule ${JSON.stringify(id)}: note must be a string`);
    }

    const normalized: RedactionRule = { id, type: type as RedactionRuleType, match: match as RedactionMatchKind, pattern };
    if (replacement !== undefined) normalized.replacement = replacement as string;
    if (note !== undefined) normalized.note = note as string;
    return normalized;
  });

  return { rules };
}
