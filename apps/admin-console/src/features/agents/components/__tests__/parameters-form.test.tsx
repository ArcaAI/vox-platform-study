/**
 * TASK-863 — the schema-driven Parameters step renders `AGENT_PARAMETER_SCHEMAS[task]` as
 * labelled fields (the same contract the gateway validates) and writes ONLY the knobs the
 * admin touched — untouched knobs stay absent so the runtime default wins.
 */
import { useState } from 'react';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { ParametersForm } from '../parameters-form';

/**
 * TASK-887 — a property annotated `modelTaskType` renders a picker over the tenant's catalogue
 * (`GET admin/ai-models/catalogue` — TASK-890: `admin/ai-models` itself is `manage:all` and 403s
 * a tenant admin), so the form now needs a QueryClient. Every test renders through the shared
 * provider harness for that reason; `fetch` is stubbed per test and filters by `taskType` the
 * same way the server does.
 */
const CATALOGUE_MODELS = [
  { id: 'm-1', slug: 'wespeaker-voxceleb-resnet34', name: 'WeSpeaker ResNet34', taskType: 'SPEAKER_EMBEDDING', providerId: 'hope', provider: 'built-in', providerClass: 'platform-self-host', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
  { id: 'm-2', slug: 'ecapa-tdnn-voxceleb', name: 'ECAPA-TDNN', taskType: 'SPEAKER_EMBEDDING', providerId: 'hope', provider: 'built-in', providerClass: 'platform-self-host', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
  { id: 'm-3', slug: 'silero-vad', name: 'Silero VAD', taskType: 'VOICE_ACTIVITY_DETECTION', providerId: 'hope', provider: 'built-in', providerClass: 'platform-self-host', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
];

function stubRegistry(models: unknown[] = CATALOGUE_MODELS) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://test.local');
      const taskType = url.searchParams.get('taskType');
      const rows = models as { taskType: string }[];
      const filtered = taskType ? rows.filter((model) => model.taskType === taskType) : rows;
      const body = { providers: [{ id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, connectionId: null, usable: true, reason: null, modelCount: filtered.length }], models: filtered };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const render = (ui: React.ReactElement) => renderWithProviders(ui);

/** A controlled host, so a cleared field really re-renders as empty (React skips a no-op change). */
function Host({ task, onChange }: { task: 'SPEECH_TO_TEXT' | 'TEXT_GENERATION' | 'TEXT_TO_SPEECH'; onChange: (next: Record<string, unknown>) => void }) {
  const [value, setValue] = useState<Record<string, unknown>>({});
  return (
    <ParametersForm
      task={task}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

beforeEach(() => stubRegistry());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ParametersForm', () => {
  it('TEXT_TO_SPEECH: renders voice/language/speed/format/sampleRate/ssml from the contract schema', () => {
    render(<ParametersForm task="TEXT_TO_SPEECH" value={{}} onChange={() => undefined} />);
    expect(screen.getByLabelText('Voice')).toBeTruthy();
    expect(screen.getByLabelText('Language')).toBeTruthy();
    expect(screen.getByLabelText('Speed').getAttribute('type')).toBe('number');
    expect(screen.getByLabelText('Format')).toBeTruthy();
    expect(screen.getByLabelText('Ssml')).toBeTruthy();
  });

  it('writes only the touched knob (and removes it again when cleared)', () => {
    const onChange = vi.fn();
    render(<Host task="TEXT_TO_SPEECH" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Voice'), { target: { value: 'af_heart' } });
    expect(onChange).toHaveBeenLastCalledWith({ voice: 'af_heart' });
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '1.25' } });
    expect(onChange).toHaveBeenLastCalledWith({ voice: 'af_heart', speed: 1.25 });
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ voice: 'af_heart' });
  });

  it('SPEECH_TO_TEXT: nests the ASR spec blocks as fieldsets and writes deep paths', () => {
    const onChange = vi.fn();
    render(<ParametersForm task="SPEECH_TO_TEXT" value={{}} onChange={onChange} />);
    expect(screen.getByRole('group', { name: 'Audio Front End' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Decoding' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Beam Size'), { target: { value: '5' } });
    expect(onChange).toHaveBeenLastCalledWith({ decoding: { beamSize: 5 } });
  });

  /**
   * TASK-887 — diarization is a declared agent option, and the model it names IS the vector
   * space the tenant's users enrol their voice profiles in. A typo there is not a validation
   * error; it is a silently unmatchable set of profiles. So the slug is PICKED.
   */
  describe('SPEECH_TO_TEXT diarization (TASK-887)', () => {
    it('exposes the whole block, off by default, with the agent-owned match threshold', () => {
      render(<ParametersForm task="SPEECH_TO_TEXT" value={{}} onChange={() => undefined} />);
      const block = within(screen.getByRole('group', { name: 'Diarization' }));
      expect(block.getByLabelText('Enabled')).toBeTruthy();
      expect(block.getByLabelText('Backend')).toBeTruthy();
      expect(block.getByLabelText('Max Speakers').getAttribute('type')).toBe('number');
      // The knob that replaced the platform key `stt.voiceProfile.minSimilarity`.
      expect(block.getByLabelText('Match Threshold').getAttribute('type')).toBe('number');
      // OFF by default: nothing is written until the admin touches it.
      expect(block.getByLabelText('Enabled').getAttribute('aria-checked')).toBe('false');
    });

    it('renders the embedding model as a picker showing the registry row’s name', async () => {
      render(
        <ParametersForm
          task="SPEECH_TO_TEXT"
          value={{ audioFrontEnd: { diarization: { embeddingModelSlug: 'ecapa-tdnn-voxceleb' } } }}
          onChange={() => undefined}
        />,
      );

      // A combobox (Radix Select trigger), not a text input, and it displays what the REGISTRY
      // calls the row — proof the options came from `GET admin/ai-models`, not from the schema.
      await waitFor(() => expect(screen.getByLabelText('Embedding Model Slug').getAttribute('role')).toBe('combobox'));
      expect(screen.getByLabelText('Embedding Model Slug').textContent).toContain('ECAPA-TDNN');
    });

    it('offers SPEAKER_EMBEDDING rows only — a VAD slug is not a selectable option', async () => {
      // `silero-vad` IS in the catalogue, but not as a speaker-embedding model, so it is not an
      // option here and the field degrades to free text rather than silently dropping the value.
      render(
        <ParametersForm
          task="SPEECH_TO_TEXT"
          value={{ audioFrontEnd: { diarization: { embeddingModelSlug: 'silero-vad' } } }}
          onChange={() => undefined}
        />,
      );

      await waitFor(() => expect((screen.getByLabelText('Embedding Model Slug') as HTMLInputElement).value).toBe('silero-vad'));
      expect(screen.getByLabelText('Embedding Model Slug').getAttribute('role')).not.toBe('combobox');
    });

    it('falls back to a free-text field for a slug the catalogue does not contain', async () => {
      // A saved agent referencing a row this tenant can no longer see must stay EDITABLE —
      // silently dropping it would rewrite the agent on the next save.
      render(
        <ParametersForm
          task="SPEECH_TO_TEXT"
          value={{ audioFrontEnd: { diarization: { embeddingModelSlug: 'a-model-that-vanished' } } }}
          onChange={() => undefined}
        />,
      );

      await waitFor(() => expect((screen.getByLabelText('Embedding Model Slug') as HTMLInputElement).value).toBe('a-model-that-vanished'));
    });
  });

  it('TEXT_GENERATION: exposes the generation hyper-parameters and the free-form responseSchema as JSON', () => {
    render(<ParametersForm task="TEXT_GENERATION" value={{ generation: { temperature: 0.2 } }} onChange={() => undefined} />);
    expect((screen.getByLabelText('Temperature') as HTMLInputElement).value).toBe('0.2');
    expect(screen.getByLabelText('Max Tokens')).toBeTruthy();
    expect(screen.getByLabelText('Response Schema')).toBeTruthy();
  });

  /** TASK-890 §3.10/§3.14 (OD-R) — the agent-level guardrail opt-out, ABSENT MEANS ON. */
  describe('TEXT_GENERATION guardrail screening (TASK-890)', () => {
    it('renders as a labelled switch, on by default, with the override copy', () => {
      render(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} />);
      const toggle = screen.getByLabelText('Guardrail screening');
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(screen.getByText(/a node or workflow can override/)).toBeTruthy();
    });

    it('turning it off writes guards.enabled: false; turning it back on removes the key (absent = on)', () => {
      const onChange = vi.fn();
      render(<Host task="TEXT_GENERATION" onChange={onChange} />);
      fireEvent.click(screen.getByLabelText('Guardrail screening'));
      expect(onChange).toHaveBeenLastCalledWith({ guards: { enabled: false } });
      fireEvent.click(screen.getByLabelText('Guardrail screening'));
      expect(onChange).toHaveBeenLastCalledWith({});
    });
  });

  /**
   * TASK-891 C4/OD-4 — per-agent reasoning control, next to temperature/maxTokens inside the
   * same "Generation" fieldset. Unlike guardrail screening, "off" is a real explicit value
   * (`enabled: false` — instruct the engine not to reason), never inferred from absence.
   */
  describe('TEXT_GENERATION reasoning control (TASK-891)', () => {
    it('renders inside the Generation fieldset, off by default, with an effort select', () => {
      render(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} />);
      const generation = within(screen.getByRole('group', { name: 'Generation' }));
      const toggle = generation.getByLabelText('Enable reasoning');
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      const effort = generation.getByLabelText('Reasoning effort') as HTMLButtonElement;
      expect(effort.disabled).toBe(true);
    });

    it('enabling writes an explicit enabled: true; disabling writes an explicit enabled: false', () => {
      const onChange = vi.fn();
      render(<Host task="TEXT_GENERATION" onChange={onChange} />);
      fireEvent.click(screen.getByLabelText('Enable reasoning'));
      expect(onChange).toHaveBeenLastCalledWith({ generation: { reasoning: { enabled: true } } });
      fireEvent.click(screen.getByLabelText('Enable reasoning'));
      expect(onChange).toHaveBeenLastCalledWith({ generation: { reasoning: { enabled: false } } });
    });

    it('picking an effort implies enabled: true', () => {
      const onChange = vi.fn();
      render(<Host task="TEXT_GENERATION" onChange={onChange} />);
      fireEvent.click(screen.getByLabelText('Enable reasoning'));
      fireEvent.keyDown(screen.getByLabelText('Reasoning effort'), { key: 'ArrowDown' });
      fireEvent.click(screen.getByText('Minimal'));
      expect(onChange).toHaveBeenLastCalledWith({ generation: { reasoning: { enabled: true, effort: 'minimal' } } });
    });

    it('SPEECH_TO_TEXT and TEXT_TO_SPEECH agents get no reasoning control — the property only exists on TEXT_GENERATION', () => {
      render(<ParametersForm task="SPEECH_TO_TEXT" value={{}} onChange={() => undefined} />);
      expect(screen.queryByLabelText('Enable reasoning')).toBeNull();
      cleanup();
      render(<ParametersForm task="TEXT_TO_SPEECH" value={{}} onChange={() => undefined} />);
      expect(screen.queryByLabelText('Enable reasoning')).toBeNull();
    });

    it('has no axe violations, off or with the effort select active', async () => {
      const { container } = render(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} />);
      expect(await axe(container)).toHaveNoViolations();
      cleanup();
      const { container: enabledContainer } = render(
        <ParametersForm task="TEXT_GENERATION" value={{ generation: { reasoning: { enabled: true, effort: 'medium' } } }} onChange={() => undefined} />,
      );
      expect(await axe(enabledContainer)).toHaveNoViolations();
    });
  });
});
