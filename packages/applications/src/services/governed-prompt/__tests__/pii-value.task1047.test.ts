/**
 * TASK-1047 (owner decision 2026-10-06: "Validate span values") — an authoring-time PII finding
 * needs an actual VALUE. Instruction text legitimately NAMES PII categories ("replace any … phone
 * number or email"); GLiNER labels those words (email @ 0.968 on the seeded note-finalisation
 * instruction), which blocked the core note agent. A span counts only when it looks like real data.
 */
import { describe, expect, it } from 'vitest';
import { isPiiValue, piiIdentifierClass } from '../pii-value';

describe('isPiiValue', () => {
  it.each([
    ['email', 'email'],
    ['email', 'e-mail address'],
    ['phone_number', 'phone number'],
    ['address', 'address'],
    ['full_name', 'name'],
    ['person', 'patient'],
    ['person', 'Doctor'],
    ['person', '[NAME]'],
    ['government_id', 'identifier'],
    ['date_of_birth', 'date of birth'],
  ])('a category word is not a value: %s %j', (label, text) => {
    expect(isPiiValue(label, text)).toBe(false);
  });

  it.each([
    ['email', 'jane.doe@example.com'],
    ['phone_number', '+91 98470 12345'],
    ['government_id', 'ID 4821-7730'],
    ['medical_record_number', 'MRN 0098812'],
    ['date_of_birth', '12/03/1961'],
    ['address', '14 Marine Drive'],
    ['person', 'Anil Kumar'],
    ['full_name', 'Ms Priya Nair'],
  ])('a real value is a value: %s %j', (label, text) => {
    expect(isPiiValue(label, text)).toBe(true);
  });

  it('an unknown label counts only with a digit or an @', () => {
    expect(isPiiValue('custom_thing', 'something')).toBe(false);
    expect(isPiiValue('custom_thing', 'A-1234')).toBe(true);
  });
});

import { vi } from 'vitest';
import { GuardrailPromptScreenClient } from '../guardrail-prompt-screen.client';

describe('piiIdentifierClass (owner decision "Scope it")', () => {
  it.each(['email', 'phone number', 'person', 'name', 'address', 'medical record number', 'passport', 'id'])('%s is a DIRECT identifier', (label) => {
    expect(piiIdentifierClass(label)).toBe('direct');
  });
  it.each(['date', 'date of birth', 'age', 'city', 'facility', 'location', 'something_new'])('%s is a QUASI-identifier', (label) => {
    expect(piiIdentifierClass(label)).toBe('quasi');
  });
});

describe('GuardrailPromptScreenClient — only VALUE spans become PII findings', () => {
  function client(spans: Array<Record<string, unknown>>) {
    const post = vi.fn(async () => ({ data: { decision: 'allow', reasons: [], checks: [], pii_spans: spans, screened_regions: ['a', 'b'] } }));
    const http = { axiosRef: { post, get: vi.fn() } };
    const config = { get: vi.fn(() => 'http://guardrail:8863') };
    const secrets = { getSecretOptional: vi.fn(async () => 'svc-token') };
    return new GuardrailPromptScreenClient(http as never, config as never, secrets as never);
  }
  const regions = [
    { key: 'a', text: 'Redact any phone number or email you find.' },
    { key: 'b', text: 'Contact jane.doe@example.com for the record.' },
  ];

  it('a category word ("email") in instruction text is not a PII region', async () => {
    const at = regions[0]!.text.indexOf('email');
    const outcome = await client([{ region: 'a', label: 'email', start: at, end: at + 5, score: 0.968 }]).screenRegions('t', regions);
    expect([...outcome.piiRegions]).toEqual([]);
  });

  it('a real email address is a PII region', async () => {
    const start = regions[1]!.text.indexOf('jane');
    const end = regions[1]!.text.indexOf(' for');
    const outcome = await client([{ region: 'b', label: 'email', start, end, score: 0.99 }]).screenRegions('t', regions);
    expect([...outcome.piiRegions]).toEqual(['b']);
  });

  it('a span without offsets falls back to its own text', async () => {
    const outcome = await client([{ region: 'b', label: 'email', text: 'jane.doe@example.com' }]).screenRegions('t', regions);
    expect([...outcome.piiRegions]).toEqual(['b']);
  });

  it('a dated example is a QUASI region, not a direct-PII region', async () => {
    const quasi = [{ key: 'c', text: 'Example: seen on 12-Mar-2026, follow up in 2 weeks.' }];
    const start = quasi[0]!.text.indexOf('12-Mar');
    const outcome = await client([{ region: 'c', label: 'date', start, end: start + 11 }]).screenRegions('t', quasi);
    expect([...outcome.piiRegions]).toEqual([]);
    expect([...outcome.quasiRegions]).toEqual(['c']);
  });

  it('a region with a direct identifier is direct only, even when it also carries a quasi value', async () => {
    const mixed = [{ key: 'd', text: 'Anil Kumar was seen on 12-Mar-2026.' }];
    const date = mixed[0]!.text.indexOf('12-Mar');
    const outcome = await client([
      { region: 'd', label: 'person', start: 0, end: 10 },
      { region: 'd', label: 'date', start: date, end: date + 11 },
    ]).screenRegions('t', mixed);
    expect([...outcome.piiRegions]).toEqual(['d']);
    expect([...outcome.quasiRegions]).toEqual([]);
  });
});
