/**
 * ConsultationPage — gate copy + live-snippet reactivity (TASK-331 doc-06)
 *
 * F5 — the "Tenant Required" guard must point at the real control (the header
 *      tenant switcher) instead of the removed on-page tenant card.
 * F6 — the LiveCodePanel snippet must recompute when a *non-tenant* input it
 *      displays changes (here: the impersonated user), not only on `tenantId`.
 *
 * `@arcaai/vox` + `@arcaai/ui/*` are globally stubbed; `consultation-workspace`
 * imports `@arcaai/ui` bare (unstubbed) so it is mocked out. The real
 * `buildConsultationSnippet` is used so recomputation is exercised end-to-end.
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const authState = vi.hoisted(() => ({ tenantId: null as string | null, impersonatedUser: null as { username?: string } | null }));
const doctorCtx = vi.hoisted(() => ({ requiresImpersonation: false, isImpersonated: true, roles: ['DOCTOR'] as string[] }));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: any) => selector({ tenantId: authState.tenantId, impersonatedUser: authState.impersonatedUser }),
}));
vi.mock('@/features/summarization/hooks/use-doctor-context', () => ({
  useDoctorContext: () => doctorCtx,
}));
vi.mock('@/features/summarization/components/impersonation-guard', () => ({
  ImpersonationGuard: () => <div data-testid="impersonation-guard" />,
}));
vi.mock('@/features/consultation/components/consultation-workspace', () => ({
  ConsultationWorkspace: () => <div data-testid="workspace" />,
}));
vi.mock('@/components/layout/main', () => ({ Main: ({ children }: any) => <div>{children}</div> }));
vi.mock('@/components/live-code-panel', () => ({
  LiveCodePanel: ({ code }: any) => <pre data-testid="live-code">{code}</pre>,
}));

vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children }: any) => <span>{children}</span> }));
vi.mock('@arcaai/ui/button', () => ({ Button: ({ children, ...p }: any) => <button {...p}>{children}</button> }));
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children }: any) => <div>{children}</div>,
  CardContent: ({ children }: any) => <div>{children}</div>,
  CardDescription: ({ children }: any) => <div>{children}</div>,
  CardHeader: ({ children }: any) => <div>{children}</div>,
  CardTitle: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: any) => <a>{children}</a> }));

import ConsultationPage from '../index';

describe('ConsultationPage — gate copy (TASK-331 doc-06 F5)', () => {
  beforeEach(() => {
    authState.tenantId = null;
    authState.impersonatedUser = null;
    doctorCtx.requiresImpersonation = false;
    doctorCtx.isImpersonated = true;
    doctorCtx.roles = ['DOCTOR'];
  });

  it('points the no-tenant guard at the header tenant switcher (not a removed on-page card)', () => {
    render(<ConsultationPage />);
    // The real control now lives in the header switcher / impersonation.
    expect(screen.getByText(/tenant switcher in the header/i)).toBeInTheDocument();
    // …and no longer instructs users to "select a tenant from the Playground Overview".
    expect(screen.queryByText(/select a tenant from the playground overview/i)).not.toBeInTheDocument();
  });
});

describe('ConsultationPage — LiveCodePanel reactivity (TASK-331 doc-06 F6)', () => {
  beforeEach(() => {
    authState.tenantId = 'tenant-1';
    authState.impersonatedUser = { username: 'alice' };
    doctorCtx.requiresImpersonation = false;
    doctorCtx.isImpersonated = true;
    doctorCtx.roles = ['DOCTOR'];
  });

  it('recomputes the displayed snippet when a non-tenant input (impersonated user) changes', () => {
    const { rerender } = render(<ConsultationPage />);
    expect(screen.getByTestId('live-code').textContent).toContain('acting as @alice');

    // Same tenant, different impersonated user → the snippet must update.
    authState.impersonatedUser = { username: 'bob' };
    rerender(<ConsultationPage />);

    const code = screen.getByTestId('live-code').textContent ?? '';
    expect(code).toContain('acting as @bob');
    expect(code).not.toContain('acting as @alice');
  });
});
