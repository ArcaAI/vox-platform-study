/**
 * TASK-1036 R4 — prompt tags share the agent tag grammar (lower-case, 1-32 key,
 * optional `:value`, max 24), validated on create AND update. The behavioural
 * tags the resolver selects on must stay valid.
 */
import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreatePromptTemplateRequest } from '../dto/create-prompt-template.request';
import { UpdatePromptTemplateRequest } from '../dto/update-prompt-template.request';
import { PROMPT_TAG_MAX_COUNT, normalisePromptTags, promptTagProblems } from '../dto/prompt-tag';

const base = { name: 'n', content: 'c', category: 'CUSTOM' };

async function errorsFor<T extends object>(cls: new () => T, data: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, data));
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('prompt tag grammar', () => {
  it.each(['pre-summary', 'text-v1', 'dept-free', 'dept:cardiology', 'specialty:rheumatology', 'tier:v2.1', 'en-vi'])(
    'accepts behavioural/vocabulary tag %s',
    (tag) => {
      expect(promptTagProblems([tag])).toEqual([]);
    },
  );

  it.each([
    'Cardiology',
    'dept:Cardiology',
    'a:b:c',
    ' padded',
    '-lead',
    'dept:',
    ':value',
    'x'.repeat(33) + ':v',
    'k:' + 'v'.repeat(65),
    'has space',
  ])('rejects malformed tag %j', (tag) => {
    expect(promptTagProblems([tag]).length).toBeGreaterThan(0);
  });

  it('rejects more than the agent maximum and duplicates', () => {
    const many = Array.from({ length: PROMPT_TAG_MAX_COUNT + 1 }, (_, i) => `t${i}`);
    expect(promptTagProblems(many).length).toBeGreaterThan(0);
    expect(promptTagProblems(['a', 'a']).length).toBeGreaterThan(0);
  });

  it('create DTO validates tags', async () => {
    expect(await errorsFor(CreatePromptTemplateRequest, { ...base, tags: ['pre-summary', 'dept:cardiology'] })).toEqual([]);
    expect((await errorsFor(CreatePromptTemplateRequest, { ...base, tags: ['Bad Tag'] })).length).toBeGreaterThan(0);
  });

  it('update DTO validates tags', async () => {
    expect(await errorsFor(UpdatePromptTemplateRequest, { tags: ['text-v1'] })).toEqual([]);
    expect((await errorsFor(UpdatePromptTemplateRequest, { tags: ['up per'] })).length).toBeGreaterThan(0);
  });
});

describe('prompt tags are normalised (trim + lower-case) BEFORE the grammar runs (TASK-1036 Q16)', () => {
  it('normalisePromptTags trims and lower-cases strings and leaves anything else for the validator', () => {
    expect(normalisePromptTags([' Pre-Summary ', 'DEPT:Cardiology', 'text-v1'])).toEqual(['pre-summary', 'dept:cardiology', 'text-v1']);
    expect(normalisePromptTags([1, null])).toEqual([1, null]);
    expect(normalisePromptTags(undefined)).toBeUndefined();
    expect(normalisePromptTags('Pre-Summary')).toBe('Pre-Summary');
  });

  it("'Pre-Summary' on create is stored as 'pre-summary'", async () => {
    const dto = plainToInstance(CreatePromptTemplateRequest, { ...base, tags: ['Pre-Summary', ' Dept:Cardiology '] });
    expect(dto.tags).toEqual(['pre-summary', 'dept:cardiology']);
    expect(await validate(dto)).toEqual([]);
  });

  it('update normalises the same way', async () => {
    const dto = plainToInstance(UpdatePromptTemplateRequest, { tags: ['UPPER'] });
    expect(dto.tags).toEqual(['upper']);
    expect(await validate(dto)).toEqual([]);
  });

  it('still refuses illegal characters, over-limit lists, and duplicates that only appear after normalisation', async () => {
    expect((await errorsFor(CreatePromptTemplateRequest, { ...base, tags: ['Has Space'] })).join(' ')).toContain('not a valid tag');
    expect((await errorsFor(CreatePromptTemplateRequest, { ...base, tags: ['Pre-Summary', 'pre-summary'] })).join(' ')).toContain(
      'Duplicate tag "pre-summary"',
    );
    const many = Array.from({ length: PROMPT_TAG_MAX_COUNT + 1 }, (_, i) => `T${i}`);
    expect((await errorsFor(CreatePromptTemplateRequest, { ...base, tags: many })).join(' ')).toContain('At most');
  });
});
