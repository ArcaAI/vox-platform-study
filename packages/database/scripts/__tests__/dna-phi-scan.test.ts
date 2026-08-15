// Unit tests for the READ-ONLY dna-phi-scan CLI (scripts/dna-phi-scan.ts).
// Covers ONLY the pure heuristic-scan + arg-parsing helpers — no live
// Vault/Postgres (mirrors decrypt-row.test.ts). The Vault + Prisma round-trip
// (`main`) is integration-only and, per the ticket, is never exercised here —
// execution against a real database is HUMAN-GATED.
import { describe, it, expect } from 'vitest';
import { scanText, countDrugDoseCoOccurrence, isClean, parseScanArgs, validateScanInvocation, EMPTY_SCAN_COUNTS } from '../dna-phi-scan';

describe('scanText', () => {
  it('returns all-zero counts for null/undefined/empty input', () => {
    expect(scanText(null)).toEqual(EMPTY_SCAN_COUNTS);
    expect(scanText(undefined)).toEqual(EMPTY_SCAN_COUNTS);
    expect(scanText('')).toEqual(EMPTY_SCAN_COUNTS);
  });

  it('returns all-zero counts for a clean, closed-vocabulary style description', () => {
    const clean =
      'Sentence structure: active. Verbosity: terse. Lists vs narrative: narrative. Preferred section order: Subjective, Objective, Assessment, Plan. Abbreviation frequency: high. Tone: formal.';
    expect(isClean(scanText(clean))).toBe(true);
  });

  it('detects an MRN-shaped token', () => {
    const counts = scanText('Patient chart references MRN: 998877 in the note.');
    expect(counts.mrnShaped).toBe(1);
    expect(isClean(counts)).toBe(false);
  });

  it('detects an MRN token without a colon or with a hash', () => {
    expect(scanText('See MRN 12345 for details').mrnShaped).toBe(1);
    expect(scanText('See MRN#12345 for details').mrnShaped).toBe(1);
  });

  it('does not false-positive MRN on unrelated text or a too-short digit run', () => {
    expect(scanText('Confidence 0.9, section v2').mrnShaped).toBe(0);
    expect(scanText('MRN 12 is too short to count').mrnShaped).toBe(0);
  });

  it('detects a DOB-shaped date', () => {
    expect(scanText('DOB: 03/14/1985 noted in the chart.').dobShaped).toBeGreaterThan(0);
    expect(scanText('Born 1985-03-14 per intake.').dobShaped).toBeGreaterThan(0);
  });

  it('detects drug-name + dose co-occurrence', () => {
    const counts = scanText('Patient prescribed metformin 500mg twice daily.');
    expect(counts.drugDoseCoOccurrence).toBe(1);
  });

  it('does not count a drug name with no nearby dose', () => {
    expect(scanText('Doctor discussed metformin as a treatment option.').drugDoseCoOccurrence).toBe(0);
  });

  it('does not count a dose with no known drug name nearby', () => {
    expect(scanText('Administer 500mg of the study compound.').drugDoseCoOccurrence).toBe(0);
  });

  it('counts multiple distinct drug+dose occurrences', () => {
    const counts = scanText('Started on lisinopril 10mg and atorvastatin 20mg.');
    expect(counts.drugDoseCoOccurrence).toBe(2);
  });

  it('detects a name-proxy sequence after Patient/Mr./Mrs./Ms./Dr.', () => {
    expect(scanText('Patient John Doe was seen today.').nameProxy).toBe(1);
    expect(scanText('Mr. James Smith reported improvement.').nameProxy).toBe(1);
    expect(scanText('Dr. Alice Nguyen signed the note.').nameProxy).toBe(1);
  });

  it('does not false-positive name-proxy on a single capitalized word', () => {
    expect(scanText('Patient reported improvement today.').nameProxy).toBe(0);
  });

  it('aggregates multiple categories in one pass', () => {
    const dirty = 'Patient John Doe, MRN: 12345, DOB 01/02/1970, started metformin 500mg.';
    const counts = scanText(dirty);
    expect(counts.mrnShaped).toBeGreaterThan(0);
    expect(counts.dobShaped).toBeGreaterThan(0);
    expect(counts.drugDoseCoOccurrence).toBeGreaterThan(0);
    expect(counts.nameProxy).toBeGreaterThan(0);
    expect(isClean(counts)).toBe(false);
  });

  it('never returns anything other than counts (no substrings, no source text) on the result shape', () => {
    const counts = scanText('Patient John Doe, MRN: 12345.');
    for (const value of Object.values(counts)) {
      expect(typeof value).toBe('number');
    }
  });
});

describe('countDrugDoseCoOccurrence', () => {
  it('is case-insensitive on the drug name', () => {
    expect(countDrugDoseCoOccurrence('Prescribed METFORMIN 500mg.')).toBe(1);
  });

  it('returns 0 for text with no known drug names', () => {
    expect(countDrugDoseCoOccurrence('The patient felt better after rest.')).toBe(0);
  });
});

describe('isClean', () => {
  it('is true only when every category is zero', () => {
    expect(isClean(EMPTY_SCAN_COUNTS)).toBe(true);
    expect(isClean({ ...EMPTY_SCAN_COUNTS, mrnShaped: 1 })).toBe(false);
    expect(isClean({ ...EMPTY_SCAN_COUNTS, dobShaped: 1 })).toBe(false);
    expect(isClean({ ...EMPTY_SCAN_COUNTS, drugDoseCoOccurrence: 1 })).toBe(false);
    expect(isClean({ ...EMPTY_SCAN_COUNTS, nameProxy: 1 })).toBe(false);
  });
});

describe('parseScanArgs', () => {
  it('parses --tenantId and --json', () => {
    const out = parseScanArgs(['tsx', 'dna-phi-scan.ts', '--tenantId', 'tenant-1', '--json']);
    expect(out.tenantId).toBe('tenant-1');
    expect(out.json).toBe(true);
    expect(out.help).toBe(false);
  });

  it('accepts the --tenant-id kebab-case alias and --k=v form', () => {
    const out = parseScanArgs(['tsx', 'd.ts', '--tenant-id=tenant-2']);
    expect(out.tenantId).toBe('tenant-2');
  });

  it('defaults to the dedicated PHI transit key (hope-phi) + transit mount', () => {
    const out = parseScanArgs(['tsx', 'd.ts']);
    expect(out.transitKey).toBe('hope-phi');
    expect(out.transitMount).toBe('transit');
    expect(out.tenantId).toBeNull();
  });

  it('honors --help', () => {
    expect(parseScanArgs(['tsx', 'd.ts', '--help']).help).toBe(true);
  });
});

describe('validateScanInvocation', () => {
  const base = { help: false, json: false, tenantId: 'tenant-1', transitMount: 't', transitKey: 'k' };

  it('returns ok with vault + tenantId', () => {
    expect(validateScanInvocation(base, { SECRETS_PROVIDER: 'vault' } as NodeJS.ProcessEnv)).toEqual({ ok: true });
  });

  it('rejects a non-vault SECRETS_PROVIDER', () => {
    const result = validateScanInvocation(base, { SECRETS_PROVIDER: 'env' } as NodeJS.ProcessEnv);
    expect(result).toEqual({ ok: false, code: 2, message: expect.stringContaining('SECRETS_PROVIDER=vault') });
  });

  it('rejects a missing --tenantId', () => {
    const result = validateScanInvocation({ ...base, tenantId: null }, { SECRETS_PROVIDER: 'vault' } as NodeJS.ProcessEnv);
    expect(result).toEqual({ ok: false, code: 2, message: expect.stringContaining('--tenantId') });
  });
});
