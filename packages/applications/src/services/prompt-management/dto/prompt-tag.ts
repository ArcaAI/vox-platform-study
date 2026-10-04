import { Transform } from 'class-transformer';
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
 * changes, change this one. Enforced on WRITE only.
 *
 * A request is NORMALISED (trim + lower-case, {@link normalisePromptTags}) before this grammar
 * runs (TASK-1036 Q16): `Pre-Summary` is stored as `pre-summary` instead of being refused. Only
 * what normalisation cannot fix is refused — illegal characters, too many tags, and duplicates,
 * including those that only appear after normalising. Rows written before this rule are
 * lower-cased by `sql/task_1036_prompt_tags_lowercase_backfill.sql` (TASK-1036 ticket folder).
 */
export const PROMPT_TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}(?::[a-z0-9][a-z0-9._-]{0,63})?$/;

/** Same ceiling as an agent's tag list. */
export const PROMPT_TAG_MAX_COUNT = AGENT_TAG_MAX_COUNT;

export const PROMPT_TAG_FORMAT_MESSAGE =
  'Tags are lower-case `key` or `key:value` (letters, digits, `-`, `_`; `.` allowed in the value), key up to 32 and value up to 64 characters.';

/**
 * Trim and lower-case every string tag. Anything that is not an array of strings is returned
 * unchanged, so {@link promptTagProblems} still reports it. Duplicates are KEPT so the validator
 * refuses them by name — never silently collapsed.
 */
export function normalisePromptTags(tags: unknown): unknown {
  if (!Array.isArray(tags)) return tags;
  return tags.map((tag) => (typeof tag === 'string' ? tag.trim().toLowerCase() : tag));
}

/** Every problem with an ALREADY-NORMALISED tag list — empty when valid. */
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

/**
 * The `tags` property decorator: normalise on the way in ({@link normalisePromptTags}, a
 * class-transformer `@Transform`, which the global `ValidationPipe` applies before validating),
 * then the whole array must satisfy {@link promptTagProblems}. Applying both from one decorator
 * keeps every DTO that carries prompt tags on the same rule.
 */
export function IsPromptTags(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    Transform(({ value }) => normalisePromptTags(value), { toClassOnly: true })(object, propertyName);
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
