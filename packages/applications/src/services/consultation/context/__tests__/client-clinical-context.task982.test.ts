/**
 * The ONE reader of the client-supplied clinical kinds.
 *
 * These two kinds — `vitals` and `previous_case_notes` — are stated by the client at `open`,
 * validated against the tenant's own consultation-context schema and persisted as context items.
 * Until this module existed, exactly one surface could read them: the realtime lane, through four
 * functions private to a 7000-line service file. Every other prompt the platform composes — the
 * warm-start pre-summary, the authoritative summary, the harness handoff, both job processors and
 * the chain summary — rendered `Not available` and `''` for a consultation whose clinic had
 * measured the readings and sent the history.
 *
 * What this file pins is the module's CONTRACT, so the six consumers can rely on it:
 *   • the kind keys are named once;
 *   • the two renderers are the realtime lane's, verbatim — a reader who was getting
 *     `BP 128/82 mmHg · HR 88 bpm` must keep getting exactly that;
 *   • the decrypt is INJECTED, so this module never reaches for a SecretsService of its own and a
 *     caller cannot accidentally read PHI ciphertext as if it were text;
 *   • the read is memoised per consultation id, because a flush every few seconds must not re-read
 *     and re-decrypt two rows that cannot have moved;
 *   • the read NEVER throws. A missing repository, an unreadable row, a body that will not decrypt
 *     and a payload of the wrong shape all mean "the client sent nothing", which is the state every
 *     consultation opened before the schema existed is in. Raising instead would refuse a clinical
 *     note over context that is by definition supplementary.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CLIENT_PREVIOUS_CASE_NOTES_KIND_KEY,
  CLIENT_VITALS_KIND_KEY,
  ClientClinicalContextReader,
  clientCaseNoteRenderings,
  contextItemDecryptor,
  formatClientVitalsForPrompt,
  formatPreviousVisitsForPrompt,
  latestContextItemOfKind,
} from '../client-clinical-context';

const CID = 'consultation-982';

interface ItemFixture {
  id: string;
  kindKey: string | null;
  content?: string | null;
  encryptedContent?: Buffer | null;
  createdAt: Date;
}

const item = (kindKey: string, payload: unknown, over: Partial<ItemFixture> = {}): ItemFixture => ({
  id: `ci-${kindKey}`,
  kindKey,
  content: payload === null ? null : JSON.stringify(payload),
  createdAt: new Date('2026-09-16T08:00:00.000Z'),
  ...over,
});

/** A repository double whose `findLatestByKindKey` serves the newest fixture of that kind. */
function repoOf(items: ItemFixture[]) {
  return {
    findLatestByKindKey: vi.fn(async (_consultationId: string, kindKey: string) => latestContextItemOfKind(items as never, kindKey)),
  };
}

/**
 * The decrypt the production wiring builds ({@link contextItemDecryptor}): ciphertext goes through
 * the repository, a row that carries none answers its transient plaintext.
 */
const plainDecrypt = async (entity: ItemFixture) => entity.content ?? null;

const VITALS = { bloodPressure: '128/82', heartRate: 88, temperature: 36.8, oxygenSaturation: 97, weightKg: 81.5 };
const NOTES = {
  notes: [
    {
      date: '2026-01-14',
      department: 'General Medicine',
      doctor: 'Dr. Bren',
      title: 'Hypertension review',
      text: 'PRIOR-NOTE-ALPHA: blood pressure controlled on amlodipine 5 mg.',
    },
    { date: '2026-03-02', title: 'Lipid panel follow-up', text: 'PRIOR-NOTE-BRAVO: LDL 3.9 mmol/L.' },
  ],
};

describe('the client clinical-context kinds are named once', () => {
  it('names the two kind keys the tenant schema declares', () => {
    expect(CLIENT_VITALS_KIND_KEY).toBe('vitals');
    expect(CLIENT_PREVIOUS_CASE_NOTES_KIND_KEY).toBe('previous_case_notes');
  });
});

describe('latestContextItemOfKind', () => {
  it('filters on kindKey alone — an item of another kind is never mistaken for one of these', () => {
    const items = [item('encounter', { doctor_id: 'd1' }), item('work_note', { text: 'noise' }), item('vitals', VITALS)];

    expect(latestContextItemOfKind(items as never, 'vitals')?.id).toBe('ci-vitals');
  });

  it('answers the NEWEST row, not the first — a correction after a re-open must win', () => {
    const older = item('vitals', { heartRate: 60 }, { id: 'older', createdAt: new Date('2026-09-16T08:00:00.000Z') });
    const newer = item('vitals', { heartRate: 88 }, { id: 'newer', createdAt: new Date('2026-09-16T09:00:00.000Z') });

    expect(latestContextItemOfKind([newer, older] as never, 'vitals')?.id).toBe('newer');
    expect(latestContextItemOfKind([older, newer] as never, 'vitals')?.id).toBe('newer');
  });

  it('answers null when nothing carries the kind', () => {
    expect(latestContextItemOfKind([item('vitals', VITALS)] as never, 'previous_case_notes')).toBeNull();
  });
});

describe('formatClientVitalsForPrompt', () => {
  it('renders the readings on one line, in the declared order', () => {
    expect(formatClientVitalsForPrompt(VITALS)).toBe('BP 128/82 mmHg · HR 88 bpm · Temp 36.8 °C · SpO2 97 % · Wt 81.5 kg');
  });

  it('carries `recordedAt` on the same line — an undated set reads as "now" to a model', () => {
    expect(formatClientVitalsForPrompt({ heartRate: 88, recordedAt: '2026-09-16T16:31:48.467Z' })).toBe(
      'HR 88 bpm · recorded 2026-09-16T16:31:48.467Z',
    );
  });

  it('puts free-text notes on a second line so the readings stay parsable', () => {
    expect(formatClientVitalsForPrompt({ heartRate: 88, notes: 'Taken at triage, patient seated.' })).toBe(
      'HR 88 bpm\nTaken at triage, patient seated.',
    );
  });

  it('answers undefined for an object that states no reading — a time on its own is not a vitals set', () => {
    expect(formatClientVitalsForPrompt(undefined)).toBeUndefined();
    expect(formatClientVitalsForPrompt({})).toBeUndefined();
    expect(formatClientVitalsForPrompt({ recordedAt: '2026-09-16T16:31:48.467Z', notes: 'nothing measured' })).toBeUndefined();
  });
});

describe('formatPreviousVisitsForPrompt', () => {
  it('renders newest first, heading then text', () => {
    expect(formatPreviousVisitsForPrompt(NOTES.notes)).toBe(
      [
        '2026-03-02 · Lipid panel follow-up',
        'PRIOR-NOTE-BRAVO: LDL 3.9 mmol/L.',
        '',
        '2026-01-14 · General Medicine · Dr. Bren · Hypertension review',
        'PRIOR-NOTE-ALPHA: blood pressure controlled on amlodipine 5 mg.',
      ].join('\n'),
    );
  });

  it('answers the empty string for an absent or empty history — the declared absence value', () => {
    expect(formatPreviousVisitsForPrompt(undefined)).toBe('');
    expect(formatPreviousVisitsForPrompt([])).toBe('');
    expect(formatPreviousVisitsForPrompt([{ text: '   ' }])).toBe('');
  });
});

describe('clientCaseNoteRenderings', () => {
  it('reproduces exactly what the open-time materializer writes into a CASE_NOTE row', () => {
    const renderings = clientCaseNoteRenderings(NOTES.notes);

    expect(renderings.has('Hypertension review\nPRIOR-NOTE-ALPHA: blood pressure controlled on amlodipine 5 mg.')).toBe(true);
    expect(renderings.has('Lipid panel follow-up\nPRIOR-NOTE-BRAVO: LDL 3.9 mmol/L.')).toBe(true);
  });

  it('also carries the untitled rendering, which is what a note with no title materializes as', () => {
    expect(clientCaseNoteRenderings([{ text: 'Bare note.' }]).has('Bare note.')).toBe(true);
  });

  it('is empty for an absent history, so a caller filters nothing away by accident', () => {
    expect(clientCaseNoteRenderings(undefined).size).toBe(0);
    expect(clientCaseNoteRenderings([]).size).toBe(0);
  });
});

describe('ClientClinicalContextReader', () => {
  it('reads both kinds and renders them for a prompt', async () => {
    const repo = repoOf([item('vitals', VITALS), item('previous_case_notes', NOTES)]);
    const reader = new ClientClinicalContextReader(repo as never, plainDecrypt as never);

    const read = await reader.read(CID);

    expect(read.vitals).toBe('BP 128/82 mmHg · HR 88 bpm · Temp 36.8 °C · SpO2 97 % · Wt 81.5 kg');
    expect(read.previousVisits).toContain('PRIOR-NOTE-ALPHA');
    expect(read.raw.vitals).toEqual(VITALS);
    expect(read.raw.previousVisits).toHaveLength(2);
  });

  it('leaves both formatted values undefined when the consultation carries neither kind', async () => {
    const reader = new ClientClinicalContextReader(repoOf([]) as never, plainDecrypt as never);

    const read = await reader.read(CID);

    expect(read.vitals).toBeUndefined();
    expect(read.previousVisits).toBeUndefined();
    expect(read.raw.previousVisits).toEqual([]);
  });

  it('DECRYPTS through the injected function — the plaintext column was dropped', async () => {
    const repo = repoOf([item('vitals', null, { content: null, encryptedContent: Buffer.from('ciphertext') })]);
    const decrypt = vi.fn(async () => JSON.stringify({ heartRate: 58 }));
    const reader = new ClientClinicalContextReader(repo as never, decrypt as never);

    const read = await reader.read(CID);

    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(read.vitals).toBe('HR 58 bpm');
  });

  it('memoises per consultation id — concurrent and repeated reads cost one round trip', async () => {
    const repo = repoOf([item('vitals', VITALS)]);
    const reader = new ClientClinicalContextReader(repo as never, plainDecrypt as never);

    await Promise.all([reader.read(CID), reader.read(CID)]);
    await reader.read(CID);

    // Two calls: one per kind, for the FIRST resolution only.
    expect(repo.findLatestByKindKey).toHaveBeenCalledTimes(2);
  });

  it('memoises per consultation — a second consultation is read on its own', async () => {
    const repo = repoOf([item('vitals', VITALS)]);
    const reader = new ClientClinicalContextReader(repo as never, plainDecrypt as never);

    await reader.read(CID);
    await reader.read('another-consultation');

    expect(repo.findLatestByKindKey).toHaveBeenCalledTimes(4);
  });

  it('degrades to "the client sent nothing" when the read throws', async () => {
    const repo = {
      findLatestByKindKey: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };
    const reader = new ClientClinicalContextReader(repo as never, plainDecrypt as never);

    await expect(reader.read(CID)).resolves.toEqual({ raw: { previousVisits: [] } });
  });

  it('degrades when a body will not decrypt', async () => {
    const repo = repoOf([item('vitals', null, { content: null, encryptedContent: Buffer.from('ciphertext') })]);
    const reader = new ClientClinicalContextReader(repo as never, async () => {
      throw new Error('transit key unavailable');
    });

    expect((await reader.read(CID)).vitals).toBeUndefined();
  });

  it('ignores a body that is not the JSON object the kind declares', async () => {
    const repo = repoOf([item('vitals', null, { content: 'not json at all' }), item('previous_case_notes', null, { content: '["an array"]' })]);
    const reader = new ClientClinicalContextReader(repo as never, plainDecrypt as never);

    const read = await reader.read(CID);

    expect(read.vitals).toBeUndefined();
    expect(read.previousVisits).toBeUndefined();
  });

  it('answers the empty context when no repository is wired at all', async () => {
    const reader = new ClientClinicalContextReader(undefined as never, plainDecrypt as never);

    await expect(reader.read(CID)).resolves.toEqual({ raw: { previousVisits: [] } });
  });
});

describe('contextItemDecryptor', () => {
  it('names the ONE decrypt path — the repository method, with the secrets service passed in', async () => {
    const decryptContentFromEntity = vi.fn(async () => 'plaintext');
    const secrets = { decrypt: vi.fn() };
    const entity = { id: 'ci-1', encryptedContent: Buffer.from('x'), content: null };

    await expect(contextItemDecryptor({ decryptContentFromEntity } as never, secrets as never)(entity as never)).resolves.toBe('plaintext');
    expect(decryptContentFromEntity).toHaveBeenCalledWith(entity, secrets);
  });

  it('falls back to the transient plaintext when no secrets service is wired (dev / fixtures)', async () => {
    const decryptContentFromEntity = vi.fn();

    await expect(contextItemDecryptor({ decryptContentFromEntity } as never, undefined)({ content: 'already plain' } as never)).resolves.toBe(
      'already plain',
    );
    expect(decryptContentFromEntity).not.toHaveBeenCalled();
  });

  it('never decrypts a row that carries no ciphertext', async () => {
    const decryptContentFromEntity = vi.fn();
    const secrets = { decrypt: vi.fn() };

    await expect(
      contextItemDecryptor({ decryptContentFromEntity } as never, secrets as never)({ content: 'plain', encryptedContent: null } as never),
    ).resolves.toBe('plain');
    expect(decryptContentFromEntity).not.toHaveBeenCalled();
  });
});
