import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// sonner renders nothing here — stub to keep the suite hermetic.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The panel reads the live hypothesis from the console-wide session context
// . Mock the hook rather than standing up the whole provider:
// this suite is about scoring + presentation, not session wiring.
let mockLineTexts: string[] = [];
// Lane A's `audio` group — the export's `run.audioSource` is derived from it
// (had to leave that field `null`).
let mockAudio: { mode: string; sources: Array<{ id: string; micLabel: string; sourceLabel: string; gain: number }> } = {
  mode: 'single-mic',
  sources: [],
};
vi.mock('../../context/playground-session', () => ({
  usePlaygroundSession: () => ({
    config: { pipelineId: 'pipeline-abc' },
    session: { id: 'consultation-1', isPreSession: false },
    transcript: { lineTexts: mockLineTexts },
    language: { mode: 'ml-en' },
    audio: mockAudio,
  }),
}));

// Import AFTER the mocks are registered.
import { describeAudioSource, ScorecardPanel } from '../ScorecardPanel';
import { toast } from 'sonner';

const REFERENCE_LABEL = 'Reference transcript';

beforeEach(() => {
  mockLineTexts = [];
  mockAudio = { mode: 'single-mic', sources: [] };
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ScorecardPanel', () => {
  it('shows no scores until a reference is supplied', () => {
    mockLineTexts = ['the patient has fever'];
    render(<ScorecardPanel />);

    expect(screen.getByText(/Scores appear once a reference is supplied/i)).toBeInTheDocument();
    expect(screen.queryByText('WER')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export run/i })).toBeDisabled();
  });

  it('scores the live transcript against a pasted reference', async () => {
    const user = userEvent.setup();
    mockLineTexts = ['the patient has', 'fewer'];
    render(<ScorecardPanel />);

    await user.type(screen.getByLabelText(REFERENCE_LABEL), 'the patient has fever');

    // ref: the patient has fever / hyp: the patient has fewer → 1 substitution.
    expect(screen.getByText('WER')).toBeInTheDocument();
    expect(screen.getByText('CER')).toBeInTheDocument();
    expect(screen.getByText('25.0%')).toBeInTheDocument(); // WER = 1/4
    expect(screen.getByText('1/0/0')).toBeInTheDocument(); // S / I / D
  });

  it('marks every diff op with a text marker and a screen-reader label, not colour alone', async () => {
    const user = userEvent.setup();
    // vs the reference below this forces one of each op: "clearly" inserted,
    // "severe"→"mild" substituted, "today" deleted.
    mockLineTexts = ['the patient clearly has mild fever'];
    render(<ScorecardPanel />);

    await user.type(screen.getByLabelText(REFERENCE_LABEL), 'the patient has severe fever today');

    const diff = screen.getByTestId('scorecard-diff');
    expect(within(diff).getAllByText(/^substitution:$/)).toHaveLength(1);
    expect(within(diff).getAllByText(/^insertion:$/)).toHaveLength(1);
    expect(within(diff).getAllByText(/^deletion:$/)).toHaveLength(1);
    expect(diff.textContent).toContain('severe → mild');
    // Markers carry the same meaning for sighted users without relying on colour.
    expect(diff.textContent).toContain('~');
    expect(diff.textContent).toContain('+');
    expect(diff.textContent).toContain('−');
  });

  it('parses an uploaded .srt down to spoken text', async () => {
    const user = userEvent.setup();
    mockLineTexts = [];
    render(<ScorecardPanel />);

    const srt = ['1', '00:00:01,000 --> 00:00:03,000', 'the patient has fever', ''].join('\n');
    const file = new File([srt], 'clip-01.srt', { type: 'text/plain' });
    await user.upload(screen.getByLabelText(/Upload a reference transcript file/i), file);

    await waitFor(() => {
      expect(screen.getByLabelText(REFERENCE_LABEL)).toHaveValue('the patient has fever');
    });
    expect(screen.getByText('source: clip-01.srt')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('clip-01.srt'));
  });

  it('exports the run as JSON carrying the scores and the run context', async () => {
    const user = userEvent.setup();
    mockLineTexts = ['the patient has fewer'];

    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:scorecard';
    });
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<ScorecardPanel />);
    await user.type(screen.getByLabelText(REFERENCE_LABEL), 'the patient has fever');
    await user.click(screen.getByRole('button', { name: /Export run/i }));

    expect(clickSpy).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();

    const payload = JSON.parse(await blobs[0].text());
    expect(payload.schema).toBe('arcaai.compat-playground.scorecard/v1');
    expect(payload.reference).toBe('the patient has fever');
    expect(payload.hypothesis).toBe('the patient has fewer');
    expect(payload.run).toMatchObject({ pipelineId: 'pipeline-abc', languageMode: 'ml-en', sessionId: 'consultation-1' });
    expect(payload.scores.substitutions).toBe(1);
    expect(payload.scoringReference).toContain('mlen_scorecard.py');
    expect(toast.success).toHaveBeenCalledWith('Scorecard run exported.');

    vi.unstubAllGlobals();
  });

  it('records the configured audio source in the exported run', async () => {
    mockLineTexts = ['the patient has fewer'];
    mockAudio = {
      mode: 'file-multi',
      sources: [
        { id: 'file-0', micLabel: 'mic 1', sourceLabel: 'left.wav', gain: 1 },
        { id: 'file-1', micLabel: 'mic 2', sourceLabel: 'right.wav', gain: 0.6 },
      ],
    };
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    vi.stubGlobal(
      'Blob',
      class extends globalThis.Blob {
        constructor(parts: BlobPart[], options?: BlobPropertyBag) {
          super(parts, options);
          blobs.push(this);
        }
      },
    );
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<ScorecardPanel />);
    await user.type(screen.getByLabelText(REFERENCE_LABEL), 'the patient has fever');
    await user.click(screen.getByRole('button', { name: /Export run/i }));

    const payload = JSON.parse(await blobs[0].text());
    expect(payload.run.audioSource).toBe('file-multi — mic 1: left.wav + mic 2: right.wav @0.60×');

    vi.unstubAllGlobals();
  });
});

describe('describeAudioSource', () => {
  it('describes each source in mixer order and only spells out non-unity gain', () => {
    expect(
      describeAudioSource({
        mode: 'multi-mic',
        sources: [
          { id: 'a', micLabel: 'mic 1', sourceLabel: 'Built-in Microphone', gain: 1 },
          { id: 'b', micLabel: 'mic 2', sourceLabel: 'USB headset', gain: 1.25 },
        ],
      }),
    ).toBe('multi-mic — mic 1: Built-in Microphone + mic 2: USB headset @1.25×');
  });

  it('names the implicit system default when a mic mode has no explicit selection', () => {
    expect(describeAudioSource({ mode: 'single-mic', sources: [] })).toBe('single-mic — system default microphone');
  });

  it('stays null for a file mode with nothing loaded rather than inventing a source', () => {
    expect(describeAudioSource({ mode: 'file-single', sources: [] })).toBeNull();
  });
});
