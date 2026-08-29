import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import { Waveform, type WaveformProps } from '../../elevenlabs/waveform';

afterEach(() => {
  cleanup();
});

// `Waveform` is a static, data-driven renderer with no live/active concept (that
// behavior belongs to `MicrophoneWaveform` / `LiveMicrophoneWaveform`, which declare
// and consume their own `active` prop). `WaveformProps` used to also declare `active`
// without the component ever reading it, so a caller-supplied value fell through
// `...props` onto the root <div> — an invalid DOM attribute React warns about at
// runtime. The fix is at the type level: `WaveformProps` must not offer a prop the
// component cannot honor, so passing `active` should be a compile error (verified by
// `pnpm --filter @arcaai/ui typecheck`, which type-checks this file per
// packages/ui/tsconfig.json's `include`; `vitest run` alone does not type-check).
describe('WaveformProps', () => {
  it('does not accept an `active` prop', () => {
    // @ts-expect-error `active` is not part of WaveformProps — Waveform never reads it.
    const element = <Waveform active={false} data={[0.2, 0.5, 0.8]} />;
    expect(element).toBeTruthy();
  });

  it('renders its declared props without an unknown-DOM-attribute warning', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const props: WaveformProps = { data: [0.2, 0.5, 0.8] };

    render(<Waveform {...props} />);

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
