/**
 * Hope Prompt tag grammar, as enforced by the gateway on create/update
 * (`PROMPT_TAG_PATTERN` in `@arcaai/applications`). It is the agent tag grammar
 * (`AGENT_TAG_PATTERN`, `@arcaai/workflow-contract`) with the `:value` half optional,
 * because the behavioural tags the resolver selects on are bare (`pre-summary`,
 * `text-v1`, `dept-free`) beside the paired `dept:<slug>`. The server stays the authority;
 * this mirror only lets the field explain a refusal before the round trip.
 */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}(?::[a-z0-9][a-z0-9._-]{0,63})?$/;

/** Same ceiling as an agent's tag list. */
export const TAG_MAX_COUNT = 24;

export const TAG_GRAMMAR_MESSAGE =
  'Use lower-case letters, digits, "-" and "_" as `key` or `key:value` (key up to 32, value up to 64 characters; "." is allowed in the value).';

/**
 * What the gateway does to a tag before it validates (TASK-1036 Q16): trim, lower-case. The field
 * does the same first, so `Pre-Summary` is added as `pre-summary` instead of being refused.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** `null` when the tag is well-formed, otherwise the message to show under the field. */
export function validateTag(tag: string): string | null {
  return TAG_PATTERN.test(tag) ? null : `"${tag}" is not a valid tag. ${TAG_GRAMMAR_MESSAGE}`;
}
