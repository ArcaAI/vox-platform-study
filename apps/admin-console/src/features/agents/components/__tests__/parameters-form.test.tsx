/**
 * TASK-863 — the schema-driven Parameters step renders `AGENT_PARAMETER_SCHEMAS[task]` as
 * labelled fields (the same contract the gateway validates) and writes ONLY the knobs the
 * admin touched — untouched knobs stay absent so the runtime default wins.
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParametersForm } from '../parameters-form';

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

afterEach(cleanup);

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

  it('TEXT_GENERATION: exposes the generation hyper-parameters and the free-form responseSchema as JSON', () => {
    render(<ParametersForm task="TEXT_GENERATION" value={{ generation: { temperature: 0.2 } }} onChange={() => undefined} />);
    expect((screen.getByLabelText('Temperature') as HTMLInputElement).value).toBe('0.2');
    expect(screen.getByLabelText('Max Tokens')).toBeTruthy();
    expect(screen.getByLabelText('Response Schema')).toBeTruthy();
  });
});
