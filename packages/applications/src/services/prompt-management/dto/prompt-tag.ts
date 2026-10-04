import { registerDecorator, ValidationOptions } from 'class-validator';
import { AGENT_TAG_MAX_COUNT } from '@arcaai/workflow-contract';

/**
 * Prompt tag grammar (TASK-1036 R4) — the agent tag grammar
 * (`AGENT_TAG_PATTERN`, `@arcaai/workflow-contract`) with the `:value` half
 * OPTIONAL, because the tags the resolver already selects on are bare
 * (`pre-summary`, `text-v1`, `dept-free`) beside the paired `dept:<slug>`.
 *
 *   key   — 1–32 chars, `[a-z0-9]` then `[a-z0-9_-]`
 *   value — 1–64 chars, `[a-z0-9]` then `[a-z0-9._-]`   (optional, exactly one colon)
 *
 * Lower-case only; a tag is compared by equality everywhere (list facet, selector, console
 * filter). The key/value character classes mirror the agent rule EXACTLY — if that rule
 * changes, change this one. Enforced on WRITE only; rows written earlier keep their tags.
 */
export const PROMPT_TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}(?::[a-z0-9][a-z0-9._-]{0,63})?$/;

/** Same ceiling as an agent's tag list. */
export const PROMPT_TAG_MAX_COUNT = AGENT_TAG_MAX_COUNT;

export const PROMPT_TAG_FORMAT_MESSAGE =
  'Tags are lower-case `key` or `key:value` (letters, digits, `-`, `_`; `.` allowed in the value), key up to 32 and value up to 64 characters.';

/** Every problem with a tag list — empty when valid. */
export function promptTagProblems(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) return ['`tags` must be an array of strings.'];
  const problems: string[] = [];
  if (tags.length > PROMPT_TAG_MAX_COUNT) problems.push(`At most ${PROMPT_TAG_MAX_COUNT} tags; this list has ${tags.length}.`);
  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== 'string' || !PROMPT_TAG_PATTERN.test(tag)) {
      problems.push(`"${String(tag)}" is not a valid tag. ${PROMPT_TAG_FORMAT_MESSAGE}`);
      continue;
    }
    if (seen.has(tag)) problems.push(`Duplicate tag "${tag}".`);
    seen.add(tag);
  }
  return problems;
}

/** class-validator decorator: the whole `tags` array must satisfy {@link promptTagProblems}. */
export function IsPromptTags(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isPromptTags',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => promptTagProblems(value).length === 0,
        defaultMessage: (args) => promptTagProblems(args?.value).join(' '),
      },
    });
  };
}
