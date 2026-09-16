/**
 * TASK-979 — the enum branch of `ScalarField` (`parameters-form.tsx`) rendered a bare
 * `placeholder="Default"` whenever the stored value was `undefined`, even when the JSON Schema
 * declares a real `default` the gateway resolver actually applies (e.g.
 * `audioFrontEnd.diarization.backend` defaults to `'embedding'` server-side). The boolean branch
 * of the same component was fixed for this exact class of bug under TASK-977; this pins the
 * equivalent fix for enums: display the EFFECTIVE value (explicit when present, else the
 * schema's own `default`), and keep the "Default" placeholder unchanged where no default exists.
 */
import { useState } from 'react';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ParametersForm } from '../parameters-form';

function stubRegistry() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ providers: [], models: [] })),
  );
}

const render = (ui: React.ReactElement) => renderWithProviders(ui);

/** A controlled host, so a picked value really re-renders (React skips a no-op change). */
function Host({ task, onChange, value: initial = {} }: { task: 'TEXT_GENERATION' | 'SPEECH_TO_TEXT' | 'TEXT_TO_SPEECH'; onChange: (next: Record<string, unknown>) => void; value?: Record<string, unknown> }) {
  const [value, setValue] = useState<Record<string, unknown>>(initial);
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

describe('ParametersForm enum defaults (TASK-979)', () => {
  it('TEXT_GENERATION: responseFormat and memory render their schema defaults when unset', () => {
    render(<ParametersForm task="TEXT_GENERATION" value={{}} onChange={() => undefined} />);
    expect(screen.getByLabelText('Response Format').textContent).toContain('text');
    expect(screen.getByLabelText('Memory').textContent).toContain('none');
  });

  it('SPEECH_TO_TEXT: audioFrontEnd.diarization.backend renders its schema default ("embedding") when unset', () => {
    render(<ParametersForm task="SPEECH_TO_TEXT" value={{}} onChange={() => undefined} />);
    expect(screen.getByLabelText('Backend').textContent).toContain('embedding');
  });

  it('an explicit stored enum value wins over the schema default', () => {
    render(<ParametersForm task="TEXT_GENERATION" value={{ responseFormat: 'json' }} onChange={() => undefined} />);
    expect(screen.getByLabelText('Response Format').textContent).toContain('json');
    expect(screen.getByLabelText('Response Format').textContent).not.toContain('text');
  });

  it('an enum with no schema default (TEXT_TO_SPEECH.format) still shows the "Default" placeholder when unset', () => {
    render(<ParametersForm task="TEXT_TO_SPEECH" value={{}} onChange={() => undefined} />);
    expect(screen.getByLabelText('Format').textContent).toBe('Default');
  });

  it('picking an enum value writes it explicitly', () => {
    const onChange = vi.fn();
    render(<Host task="TEXT_GENERATION" onChange={onChange} />);
    fireEvent.keyDown(screen.getByLabelText('Response Format'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByText('json'));
    expect(onChange).toHaveBeenLastCalledWith({ responseFormat: 'json' });
  });
});
