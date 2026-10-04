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
import { PROMPT_TAG_MAX_COUNT, promptTagProblems } from '../dto/prompt-tag';

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
    expect((await errorsFor(UpdatePromptTemplateRequest, { tags: ['UPPER'] })).length).toBeGreaterThan(0);
  });
});
