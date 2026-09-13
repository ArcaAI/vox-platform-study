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
  // TASK-934 — an ASR row carrying a decode profile, for the effective-value hint.
  {
    id: 'm-asr',
    slug: 'arcaai-whisper-large-ml-en-gguf-q8-0',
    name: 'ArcaAI Whisper q8_0',
    taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
    providerId: 'hope',
    provider: 'built-in',
    providerClass: 'platform-self-host',
    readiness: 'ready',
    readinessCheckedAt: null,
    readinessDetail: null,
    usable: true,
    unusableReason: null,
    asrProfile: { maxDecodeWindowSec: 7, partialWindowSec: 15, decoding: { noSpeechThreshold: 0.4 } },
  },
  // TASK-970 — TEXT_GENERATION rows spanning all three reasoning-enforcement classes
  // (`reasoning-support.ts`), plus one provider id the table does not recognise.
  { id: 'm-llm-lmstudio', slug: 'lms-gemma-4-e2b-it-qat', name: 'Gemma 4 E2B', taskType: 'TEXT_GENERATION', providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
  { id: 'm-llm-azure', slug: 'azure-gpt-5.4-mini', name: 'GPT-5.4 mini', taskType: 'TEXT_GENERATION', providerId: 'hope', provider: 'azure', providerClass: 'cloud-platform', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
  { id: 'm-llm-ollama', slug: 'llama3.1-8b', name: 'Llama 3.1 8B', taskType: 'TEXT_GENERATION', providerId: 'hope', provider: 'ollama', providerClass: 'engine-served', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
  { id: 'm-llm-bedrock', slug: 'bedrock-claude', name: 'Claude on Bedrock', taskType: 'TEXT_GENERATION', providerId: 'byo:llm:bedrock', provider: 'bedrock', providerClass: 'cloud-byo', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
  { id: 'm-llm-unknown', slug: 'mystery-engine', name: 'Mystery Engine', taskType: 'TEXT_GENERATION', providerId: 'byo:llm:mystery', provider: 'a-future-engine-nobody-seeded-yet', providerClass: 'cloud-byo', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
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
function Host({
  task,
  onChange,
  modelId,
}: {
  task: 'SPEECH_TO_TEXT' | 'TEXT_GENERATION' | 'TEXT_TO_SPEECH';
  onChange: (next: Record<string, unknown>) => void;
  modelId?: string;
}) {
  const [value, setValue] = useState<Record<string, unknown>>({});
  return (
    <ParametersForm
      task={task}
      value={value}
      modelId={modelId}
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

  /**
   * TASK-970 (L3, F-2/F-4) — the toggle's description used to promise "the engine is
   * instructed not to reason and reasoning tokens are never billed", unconditionally.
   * Measured: that promise reached only 3 of 10 provider adapters. These tests pin the
   * corrected copy and the per-provider support note that replaces the false blanket claim —
   * one case per `ReasoningSupportClass`, plus "no model bound yet" and "provider unrecognised"
   * (neither of which may fabricate a claim), and a check that none of this ever blocks saving.
   */
  describe('TEXT_GENERATION reasoning provider support (TASK-970)', () => {
    it('no longer promises the engine is instructed — states that honouring it depends on the provider', () => {
      render(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} />);
      expect(screen.queryByText(/instructed not to reason/)).toBeNull();
      expect(screen.queryByText(/reasoning tokens are never billed to this agent/)).toBeNull();
      expect(screen.getByText(/depends\s+on the model.s provider/)).toBeTruthy();
    });

    it('shows no per-provider note when no model is bound yet', () => {
      render(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} />);
      expect(screen.queryByText(/has a genuine off-switch/)).toBeNull();
      expect(screen.queryByText(/has no true off-switch/)).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('shows no per-provider note for a provider this table does not recognise', async () => {
      render(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} modelId="m-llm-unknown" />);
      // The catalogue lookup resolves the bound model to a provider this table has no
      // opinion about — wait for that fetch to settle before asserting the (unchanged) absence.
      await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
      expect(screen.queryByText(/has a genuine off-switch/)).toBeNull();
      expect(screen.queryByText(/has no true off-switch/)).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('native-off (Ollama): a quiet note that the posture is fully honoured', async () => {
      render(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} modelId="m-llm-ollama" />);
      await waitFor(() => expect(screen.getByText(/Ollama has a genuine off-switch/)).toBeTruthy());
      // Quiet, not an Alert — this is the "the platform CAN speak to the engine" case.
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('effort-only (LM Studio): a quiet note that "off" is only approximated', async () => {
      // LM Studio is the effort-only case: its documented vocabulary is low|medium|high with no
      // off value, so `enabled: false` can only be approximated by the lowest rung.
      render(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} modelId="m-llm-lmstudio" />);
      await waitFor(() => expect(screen.getByText(/LM Studio has no true off-switch/)).toBeTruthy());
      expect(screen.getByText(/lowest reasoning effort/)).toBeTruthy();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('native-off (Azure OpenAI): reaches the engine as set — verified against openai==3.1.0', async () => {
      // TASK-970 L1 verified `ReasoningEffort` includes a real `'none'` rung, so Azure moved from
      // the seeded `effort-only` guess to `native-off`. This case pins that correction.
      render(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} modelId="m-llm-azure" />);
      await waitFor(() => expect(screen.getByText(/Azure OpenAI has a genuine off-switch/)).toBeTruthy());
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('unsupported (Bedrock): an unmissable but non-destructive Alert, never blocking the toggle', async () => {
      const onChange = vi.fn();
      render(<Host task="TEXT_GENERATION" onChange={onChange} modelId="m-llm-bedrock" />);
      const alert = await waitFor(() => screen.getByRole('status'));
      expect(within(alert).getByText(/Not enforceable on Amazon Bedrock/)).toBeTruthy();
      expect(within(alert).getByText(/engine decides on its own/)).toBeTruthy();
      // A real limitation, not an error — the destructive/red treatment is reserved for actual failures.
      expect(alert.className).not.toContain('destructive');

      // Do not block saving: the toggle still writes normally against an unsupported provider.
      fireEvent.click(screen.getByLabelText('Enable reasoning'));
      expect(onChange).toHaveBeenLastCalledWith({ generation: { reasoning: { enabled: true } } });
    });

    it('has no axe violations with the unsupported-provider Alert showing', async () => {
      const { container } = render(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} modelId="m-llm-bedrock" />);
      await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});

/**
 * TASK-934 (G-4) — the effective-value hint: what the currently ASSIGNED model's
 * `_metadata.asr` decode profile contributes, shown next to the decode fields the
 * agent leaves unset (OD-3: agent → model profile → engine default).
 */
describe('SPEECH_TO_TEXT effective-value hint (TASK-934)', () => {
  it('shows the model profile summary line once the catalogue resolves the selected model', async () => {
    render(<ParametersForm task="SPEECH_TO_TEXT" value={{}} onChange={() => undefined} modelId="m-asr" />);
    await waitFor(() => expect(screen.getByText(/^Model profile:/)).toBeTruthy());
    expect(screen.getByText('Model profile: final window 7 s · partial window 15 s · no-speech 0.4')).toBeTruthy();
  });

  it('shows no summary line when no model is selected', () => {
    render(<ParametersForm task="SPEECH_TO_TEXT" value={{}} onChange={() => undefined} />);
    expect(screen.queryByText(/^Model profile:/)).toBeNull();
  });

  it('shows no summary line for a non-SPEECH_TO_TEXT task even with a modelId', () => {
    render(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} modelId="m-asr" />);
    expect(screen.queryByText(/^Model profile:/)).toBeNull();
  });

  it('names the inherited value on a decoding field the agent leaves empty', async () => {
    render(<ParametersForm task="SPEECH_TO_TEXT" value={{}} onChange={() => undefined} modelId="m-asr" />);
    await waitFor(() => expect(screen.getByText(/^Model profile:/)).toBeTruthy());
    expect(screen.getByText(/inherits 0\.4 from the model profile/)).toBeTruthy();
  });

  it('drops the inherit hint once the agent sets an explicit value for that field', async () => {
    const onChange = vi.fn();
    render(<Host task="SPEECH_TO_TEXT" onChange={onChange} modelId="m-asr" />);
    await waitFor(() => expect(screen.getByText(/^Model profile:/)).toBeTruthy());
    expect(screen.getByText(/inherits 0\.4 from the model profile/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('No Speech Threshold'), { target: { value: '0.7' } });
    expect(screen.queryByText(/inherits 0\.4 from the model profile/)).toBeNull();
  });
});
