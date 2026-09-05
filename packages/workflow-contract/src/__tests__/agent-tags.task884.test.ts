import { describe, expect, it } from 'vitest';
import { AGENT_TAG_MAX_COUNT, agentTagProblems, agentTagsSatisfy, canonicalAgentTags, parseAgentTag } from '../agent-schemas';

describe('TASK-884 agent tag grammar (owner decision #6 — key:value alignment, no conditions)', () => {
  it('parses a well-formed pair', () => {
    expect(parseAgentTag('specialty:rheumatology')).toEqual({ key: 'specialty', value: 'rheumatology' });
    expect(parseAgentTag('tier:platform-default')).toEqual({ key: 'tier', value: 'platform-default' });
    expect(parseAgentTag('model:whisper-large-v3.1')).toEqual({ key: 'model', value: 'whisper-large-v3.1' });
  });

  it('REFUSES a bare key, and says what the pair should look like', () => {
    const problems = agentTagProblems(['rheumatology']);
    expect(problems).toHaveLength(1);
    expect(problems[0].severity).toBe('ERROR');
    expect(problems[0].path).toBe('tags[0]');
    expect(problems[0].message).toContain('bare tag');
    expect(problems[0].message).toContain('specialty:rheumatology');
  });

  it('refuses upper case, whitespace, a second colon and an empty half', () => {
    for (const tag of ['Specialty:cardiology', 'specialty: cardiology', 'a:b:c', 'specialty:', ':cardiology', '']) {
      expect(agentTagProblems([tag]), tag).toHaveLength(1);
    }
    expect(parseAgentTag(42)).toBeNull();
  });

  it('refuses duplicates and an over-long list', () => {
    expect(agentTagProblems(['a:b', 'a:b']).map((p) => p.message)).toEqual(['Duplicate tag `a:b`.']);
    const many = Array.from({ length: AGENT_TAG_MAX_COUNT + 1 }, (_, i) => `k:v${i}`);
    expect(agentTagProblems(many)[0].message).toContain(`At most ${AGENT_TAG_MAX_COUNT} tags`);
  });

  it('treats absent tags as no opinion, and a non-array as an error', () => {
    expect(agentTagProblems(undefined)).toEqual([]);
    expect(agentTagProblems(null)).toEqual([]);
    expect(agentTagProblems('specialty:cardiology')[0].path).toBe('tags');
  });

  it('canonicalises to a de-duplicated, sorted list so {a,b} and {b,a} are ONE selector', () => {
    expect(canonicalAgentTags(['b:2', 'a:1', 'b:2'])).toEqual(['a:1', 'b:2']);
    expect(canonicalAgentTags([])).toEqual([]);
  });

  it('matches by SUBSET, AND-joined — and an empty selector matches everything', () => {
    const agent = ['tier:platform', 'specialty:rheumatology', 'lang:en'];
    expect(agentTagsSatisfy(agent, [])).toBe(true);
    expect(agentTagsSatisfy(agent, ['specialty:rheumatology'])).toBe(true);
    expect(agentTagsSatisfy(agent, ['specialty:rheumatology', 'lang:en'])).toBe(true);
    expect(agentTagsSatisfy(agent, ['specialty:cardiology'])).toBe(false);
    expect(agentTagsSatisfy(agent, ['specialty:rheumatology', 'lang:ml'])).toBe(false);
    expect(agentTagsSatisfy([], ['specialty:rheumatology'])).toBe(false);
  });

  it('reports the offending index, not just "invalid tags"', () => {
    const problems = agentTagProblems(['ok:1', 'bad', 'ok:2']);
    expect(problems.map((p) => p.path)).toEqual(['tags[1]']);
  });
});
