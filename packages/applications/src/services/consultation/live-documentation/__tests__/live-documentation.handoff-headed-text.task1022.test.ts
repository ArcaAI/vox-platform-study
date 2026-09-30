/**
 * TASK-1022 — the handoff hands the finalizer a HEADED note.
 *
 * The durable finalizer (`n_finalize`) binds a summary node's `out` socket, and the `core.agent`
 * registry entry declares `out -> "text"` (`apps/harness/.../interpreter/registry.py`). So the
 * finalizer sees `outputs.<summary>.text` — a flat string — and never the `sections` beside it.
 * The live lane's `text` is the unlabelled join of the section BODIES (the NER offset base), so
 * the finalizer was told to keep headings it was never shown (TASK-1022 replay run3, `p10.txt`).
 *
 * `persistLiveHandoff` therefore writes the HEADED rendering as the persisted copy's `text`, by
 * the SAME rules as the harness `_render_input_for_generation` / `_headed_note`
 * (`apps/harness/.../interpreter/nodes/core.py`; these cases are ported from its tests):
 *
 *  - `## <title>\n<content>` per section, in list (template) order;
 *  - the literal `Not discussed` under an empty section (OD-1 (b));
 *  - the parser fallback (a single `Running Summary` / untitled section) without a heading;
 *  - no titled section, or nothing said at all → the flat `text` is kept.
 *
 * The LIVE session's own outputs are never touched: `text` there is the NER offset base.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';

const TENANT = 'tenant-headed';
const CID = 'consultation-headed-001';

function buildService() {
  const stored = new Map<string, string>();
  const cache = {
    get: vi.fn(async (key: string) => stored.get(key) ?? null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      stored.set(key, value);
    }),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
  const args: unknown[] = new Array(28).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  args[15] = {
    findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, doctorId: null, departmentId: null, status: 'DRAINING', metadata: null })),
  };
  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, stored };
}

type Outputs = Record<string, Record<string, unknown>>;
type SessionShape = { consultationId: string; tenantId: string; liveNodeOutputs?: Outputs };

async function persist(outputs: Outputs): Promise<{ persisted: Outputs; session: SessionShape; service: LiveDocumentationService }> {
  const { service, stored } = buildService();
  const session: SessionShape = { consultationId: CID, tenantId: TENANT, liveNodeOutputs: outputs };
  await (service as unknown as { persistLiveHandoff(s: SessionShape): Promise<void> }).persistLiveHandoff(session);
  const persisted = (JSON.parse(stored.get(`live-doc:handoff:${CID}`)!) as { outputs: Outputs }).outputs;
  return { persisted, session, service };
}

function note(sections: Array<[string, string]>, text = 'flat body join'): Record<string, unknown> {
  return { text, sections: sections.map(([title, content]) => ({ title, content })), stats: { turns: 3 }, repaired: false };
}

/** The persisted `text` of a single summary output built from `value`. */
async function persistedText(value: Record<string, unknown>): Promise<unknown> {
  return (await persist({ n_summary: value })).persisted.n_summary.text;
}

describe('TASK-1022 — persistLiveHandoff writes the headed note as the handoff `text`', () => {
  it('renders sections as `## title` blocks in list order', async () => {
    expect(
      await persistedText(
        note([
          ['New Complaints', 'Chest pain on exertion.'],
          ['Current Diagnosis', 'Stable angina.'],
          ['Treatment Plan', 'Aspirin 75 mg OD.'],
        ]),
      ),
    ).toBe('## New Complaints\nChest pain on exertion.\n\n## Current Diagnosis\nStable angina.\n\n## Treatment Plan\nAspirin 75 mg OD.');
  });

  it('keeps an empty section’s heading with the literal `Not discussed` marker', async () => {
    expect(
      await persistedText(
        note([
          ['New Complaints', 'Cough.'],
          ['Investigations', ''],
          ['Plan', '  \n'],
        ]),
      ),
    ).toBe('## New Complaints\nCough.\n\n## Investigations\nNot discussed\n\n## Plan\nNot discussed');
  });

  it('renders the parser fallback (`Running Summary`) without a heading', async () => {
    expect(await persistedText(note([['Running Summary', 'Everything said, unpartitioned.\n']]))).toBe('Everything said, unpartitioned.');
  });

  it('renders a single untitled section without a heading', async () => {
    expect(await persistedText(note([['', 'Unlabelled body.']]))).toBe('Unlabelled body.');
  });

  it('keeps the flat text when every section is empty', async () => {
    expect(
      await persistedText(
        note(
          [
            ['New Complaints', ''],
            ['Plan', ''],
          ],
          'flat',
        ),
      ),
    ).toBe('flat');
  });

  it('keeps the flat text when no section carries a title', async () => {
    expect(await persistedText({ text: 'no titles anywhere', sections: [{ content: 'x' }, { content: 'y' }] })).toBe('no titles anywhere');
  });

  it('renders an untitled section with a body inline, without a heading, among titled ones', async () => {
    expect(
      await persistedText(
        note([
          ['A', 'a.'],
          ['', 'loose'],
          ['', ''],
        ]),
      ),
    ).toBe('## A\na.\n\nloose');
  });

  it.each([
    ['a dict with text only', { text: 'a dict with text only' }],
    ['sections that is not a list', { text: 'sections is not a list', sections: 'nope' }],
    ['empty sections', { text: 'empty sections', sections: [] }],
  ])('leaves an output with %s exactly as it was', async (_label, value) => {
    const { persisted } = await persist({ n_summary: value as Record<string, unknown> });
    expect(persisted.n_summary).toEqual(value);
  });

  it('changes only `text`, and only on outputs that carry sections', async () => {
    const summary = note([
      ['A', 'a.'],
      ['B', ''],
    ]);
    const ner = { text: 'ner base', entities: [{ text: 'a', start: 0, end: 1 }] };
    const asr = { transcript: 'the said words' };

    const { persisted } = await persist({ n_summary_new: summary, n_ner: ner, n_asr: asr });

    expect(persisted.n_summary_new).toEqual({ ...summary, text: '## A\na.\n\n## B\nNot discussed' });
    expect(persisted.n_ner).toEqual(ner);
    expect(persisted.n_asr).toEqual(asr);
  });

  it('leaves the LIVE session’s outputs untouched (their `text` is the NER offset base)', async () => {
    const summary = note(
      [
        ['A', 'a.'],
        ['B', ''],
      ],
      'a.',
    );
    const { session } = await persist({ n_summary: summary });

    expect(session.liveNodeOutputs!.n_summary).toBe(summary);
    expect(summary.text).toBe('a.');
  });

  it('is what the durable interpreter reads back', async () => {
    const { service } = await persist({
      n_summary: note([
        ['A', 'a.'],
        ['B', ''],
      ]),
    });

    const answer = await service.readLiveHandoff(CID, ['n_summary']);

    expect(answer.outputs.n_summary.text).toBe('## A\na.\n\n## B\nNot discussed');
  });
});
