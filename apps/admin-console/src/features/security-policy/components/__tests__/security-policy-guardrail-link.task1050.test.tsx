/**
 * TASK-1050 W3c — guardrail availability MOVED into `/guardrails/control` (Rules). For one release the
 * old tab stays as a deep link (rule 13 redirect convention); it no longer reads or writes availability.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { SecurityPolicyScreen } from '../security-policy-screen';

const POLICY = {
  password: {
    minLength: 12,
    maxLength: 128,
    requireUppercase: true,
    requireLowercase: true,
    requireDigit: true,
    requireSpecial: true,
    maxAgeDays: 0,
  },
  secret: { byteLength: 32, encoding: 'hex' },
  bounds: { minByteLength: 16, maxByteLength: 64, pinnedEncodings: {}, governedSurfaces: [] },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/security-policy — Guardrail availability tab (moved)', () => {
  it('is a deep link to /guardrails/control and calls no availability route', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
        return Response.json(POLICY);
      }),
    );
    renderWithProviders(<SecurityPolicyScreen />);
    await screen.findByLabelText('Minimum length');

    const tab = screen.getByRole('tab', { name: 'Guardrail availability' });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);

    const link = await screen.findByRole('link', { name: /Open Guardrail control/ });
    expect(link.getAttribute('href')).toBe('/guardrails/control');
    expect(screen.getByText('Guardrail availability moved to Guardrail control')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save availability' })).toBeNull();
    expect(urls.some((url) => url.includes('admin/guardrail/availability'))).toBe(false);
  });
});
