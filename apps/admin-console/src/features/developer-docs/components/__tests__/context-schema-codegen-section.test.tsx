/**
 * The "Context schema & codegen" section of `/developer`.
 *
 * Both tables are RENDERED FROM `@arcaai/types` — `OPEN_REFUSAL_CODES` and
 * `API_KEY_SCOPE_PRESETS` — and not from a copy typed into this file. The tests
 * therefore iterate the constants: a code added to the union appears here
 * without anyone remembering to add it, and a code removed cannot linger in the
 * docs the console serves.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { API_KEY_SCOPE_PRESETS, OPEN_REFUSAL_CODES } from '@arcaai/types';
import { renderWithProviders } from '@/test/render';
import { ContextSchemaCodegenSection } from '../context-schema-codegen-section';

afterEach(cleanup);

describe('ContextSchemaCodegenSection', () => {
  it('lists every open refusal code the platform declares', () => {
    renderWithProviders(<ContextSchemaCodegenSection />);

    for (const code of OPEN_REFUSAL_CODES) {
      expect(screen.getByText(code)).toBeDefined();
    }
    expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(OPEN_REFUSAL_CODES.length);
  });

  it('lists every scope preset with its label, its description and its scopes', () => {
    renderWithProviders(<ContextSchemaCodegenSection />);

    for (const preset of API_KEY_SCOPE_PRESETS) {
      expect(screen.getByText(preset.label)).toBeDefined();
      expect(screen.getByText(preset.description)).toBeDefined();
      for (const scope of preset.scopes) {
        expect(screen.getAllByText(scope).length).toBeGreaterThan(0);
      }
    }
  });

  it('gives one command per credential and the CI drift check', () => {
    renderWithProviders(<ContextSchemaCodegenSection />);

    expect(screen.getByText(/--api-key/)).toBeDefined();
    expect(screen.getByText(/--client-id/)).toBeDefined();
    expect(screen.getAllByText(/--check/).length).toBeGreaterThan(0);
  });

  it('names the generated open-context type and the per-workflow provenance tag', () => {
    renderWithProviders(<ContextSchemaCodegenSection />);

    expect(screen.getAllByText(/OpenConsultationContext/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/@contextSchema/).length).toBeGreaterThan(0);
  });

  it('links to both guides by path', () => {
    renderWithProviders(<ContextSchemaCodegenSection />);

    expect(screen.getByText('docs/guides/client-integration-guide.md')).toBeDefined();
    expect(screen.getByText('docs/guides/tenant-admin-user-guide.md')).toBeDefined();
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(<ContextSchemaCodegenSection />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
