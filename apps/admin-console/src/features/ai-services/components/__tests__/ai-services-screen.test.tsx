/**
 * TDD screen tests for TASK-532 B-4 (AI services, tier 10-19): the three tabs
 * — Guardrail (status + config), NLP (per-model status) and Instructions (the
 * working-tenant-scoped agentic instruction set). The guardrail/NLP documents
 * are UPSTREAM-OWNED, so the fixtures deliberately mix recognizable status
 * fields with arbitrary keys: the panels must badge what they recognize and
 * fall back to key/value for the rest, never crash on an unknown shape.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { AgenticInstructions, GuardrailConfig } from '../../api/types';
import { AiServicesScreen } from '../ai-services-screen';


const SESSION = {
    user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'] },
    isElevated: true,
    workingTenantId: 'tnt-1' as string | null,
    workingTenantName: 'Sunrise Medical Group' as string | null,
    impersonatingUserId: null,
    impersonatingUsername: null,
    effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'], tenantId: null, departmentId: null },
    effectiveIsElevated: true,
    effectiveTenantId: 'tnt-1' as string | null,
};

/** Upstream guardrail `GET /api/health`, proxied verbatim (shape not ours). */
const GUARDRAIL_STATUS: Record<string, unknown> = {
    status: 'healthy',
    version: '2.4.1',
    components: {
        engine: { status: 'healthy', model: 'llama-guard-3-8b' },
        gliner: { status: 'degraded', detail: 'model warming' },
        redis: { status: 'unhealthy', detail: 'connection refused' },
    },
    uptimeSeconds: 91_845,
};

const GUARDRAIL_CONFIG: GuardrailConfig = {
    medicalValidation: {
        provider: 'lmstudio',
        model: 'medgemma-27b',
        enabled: true,
        confidenceThreshold: 0.82,
    },
    analysisTypes: {
        pii: { description: 'Detects PII spans' },
        toxicity: { description: 'Flags toxic content' },
    },
};

/** Upstream NLP `GET /api/v1/health`, proxied verbatim. */
const NLP_STATUS: Record<string, unknown> = {
    status: 'healthy',
    components: {
        ner: { status: 'healthy', loaded: true },
        classifier: { status: 'unhealthy', loaded: false, detail: 'weights missing' },
    },
};

const INSTRUCTIONS: AgenticInstructions = {
    tenantId: 'tnt-1',
    policySource: 'tenant',
    promptTier: {
        template: 'SOAP',
        promptId: 'prm-1042',
        resolvedFrom: 'department',
        departmentId: 'dep-7',
        promptType: 'new-patient',
    },
    judgePrompt: {
        instrument: 'PDSQI-9',
        version: '1.0.0',
        promptHash: 'sha256:abc123def456',
        source: 'epic-open-source/evaluation-instruments',
        license: 'Apache-2.0',
        paperDoi: '10.1093/jamia/ocaf068',
        rubricDimensions: ['accurate', 'thorough', 'useful'],
        editable: false,
    },
    sensorThresholds: {
        entityFaithfulnessThreshold: 1,
        coverageThreshold: 0.8,
        citationPresenceThreshold: 1,
        numericDoseThreshold: 1,
        groundednessThreshold: 0.8,
    },
    safetyCriteria: [
        { key: 'safety', label: 'Content-safety guardrail', enabled: true, detail: 'lmstudio / llama-guard-3-8b' },
        { key: 'phi', label: 'PHI redaction', enabled: false, detail: null },
    ],
};

interface RecordedCall {
    url: string;
    method: string;
}

interface StubOptions {
    session?: typeof SESSION;
    custom?: (call: RecordedCall) => Response | undefined;
}

function stubFetch({ session = SESSION, custom }: StubOptions = {}): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET' };
            calls.push(call);
            const handled = custom?.(call);
            if (handled) return handled;
            if (call.url === '/api/auth/session') return Response.json(session);
            const url = new URL(call.url, 'http://test');
            if (url.pathname === '/api/hope/admin/ai-services/guardrail/status') return Response.json(GUARDRAIL_STATUS);
            if (url.pathname === '/api/hope/admin/ai-services/guardrail/config') return Response.json(GUARDRAIL_CONFIG);
            if (url.pathname === '/api/hope/admin/ai-services/nlp/status') return Response.json(NLP_STATUS);
            if (url.pathname === '/api/hope/admin/agentic/instructions') return Response.json(INSTRUCTIONS);
            throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
        }),
    );
    return calls;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('AiServicesScreen', () => {
    it('renders the heading and the three governance tabs', async () => {
        stubFetch();
        renderWithProviders(<AiServicesScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'AI services' })).toBeDefined();
        expect(screen.getByRole('tab', { name: 'Guardrail' })).toBeDefined();
        expect(screen.getByRole('tab', { name: 'NLP' })).toBeDefined();
        expect(screen.getByRole('tab', { name: 'Instructions' })).toBeDefined();
        await screen.findAllByText('healthy');
    });

    it('shows content-shaped skeletons while the guardrail reads are in flight', () => {
        stubFetch({ custom: () => undefined });
        const { container } = renderWithProviders(<AiServicesScreen />);

        expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    });

    describe('Guardrail tab', () => {
        it('badges recognizable component statuses and key/values the rest of the upstream document', async () => {
            stubFetch();
            renderWithProviders(<AiServicesScreen />);

            // The card keeps its region name while loading, so wait on content.
            await screen.findByText('llama-guard-3-8b');
            const panel = screen.getByRole('region', { name: 'Guardrail service status' });
            // Recognized status-ish fields become badges.
            expect(within(panel).getAllByText('healthy').length).toBeGreaterThan(0);
            expect(within(panel).getByText('degraded')).toBeDefined();
            expect(within(panel).getByText('unhealthy')).toBeDefined();
            // Component names and unrecognized scalars still render readably.
            expect(within(panel).getByText('gliner')).toBeDefined();
            expect(within(panel).getByText('uptimeSeconds')).toBeDefined();
            expect(within(panel).getByText('91845')).toBeDefined();
            expect(within(panel).getByText('llama-guard-3-8b')).toBeDefined();
        });

        it('renders the medical-validation and analysis-type config documents', async () => {
            stubFetch();
            renderWithProviders(<AiServicesScreen />);

            await screen.findByText('medgemma-27b');
            const panel = screen.getByRole('region', { name: 'Guardrail configuration' });
            expect(within(panel).getByText('medgemma-27b')).toBeDefined();
            expect(within(panel).getByText('confidenceThreshold')).toBeDefined();
            expect(within(panel).getByText('0.82')).toBeDefined();
            expect(within(panel).getByText('toxicity')).toBeDefined();
            expect(within(panel).getByText('Flags toxic content')).toBeDefined();
        });

        it('degrades instead of crashing when the upstream shape is not what we expect', async () => {
            stubFetch({
                custom: (call) => {
                    const url = new URL(call.url, 'http://test');
                    if (url.pathname === '/api/hope/admin/ai-services/guardrail/status') {
                        return Response.json({ totally: { different: ['shape', 42] }, status: null });
                    }
                    return undefined;
                },
            });
            renderWithProviders(<AiServicesScreen />);

            await screen.findByText('totally');
            const panel = screen.getByRole('region', { name: 'Guardrail service status' });
            expect(within(panel).getByText('totally')).toBeDefined();
            expect(screen.queryByRole('alert')).toBeNull();
        });

        it('surfaces an error state with retry when the proxy returns 503', async () => {
            let attempts = 0;
            stubFetch({
                custom: (call) => {
                    const url = new URL(call.url, 'http://test');
                    if (url.pathname === '/api/hope/admin/ai-services/guardrail/status') {
                        attempts += 1;
                        if (attempts === 1) return Response.json({ message: 'guardrail service unavailable' }, { status: 503 });
                    }
                    return undefined;
                },
            });
            renderWithProviders(<AiServicesScreen />);

            expect(await screen.findByRole('alert')).toBeDefined();
            expect(screen.getByText('guardrail service unavailable')).toBeDefined();

            fireEvent.click(screen.getByRole('button', { name: /retry/i }));
            await waitFor(() => expect(screen.getByRole('region', { name: 'Guardrail service status' })).toBeDefined());
        });
    });

    describe('NLP tab', () => {
        it('renders per-model component checks with status badges', async () => {
            stubFetch();
            // The active tab is nuqs-backed; the testing adapter renders from
            // the initial searchParams (sibling pattern: pipeline-policy).
            renderWithProviders(<AiServicesScreen />, { searchParams: '?tab=nlp' });

            await screen.findByText('weights missing');
            const panel = screen.getByRole('region', { name: 'NLP service status' });
            expect(within(panel).getByText('classifier')).toBeDefined();
            expect(within(panel).getByText('unhealthy')).toBeDefined();
            expect(within(panel).getByText('weights missing')).toBeDefined();
        });

        it('surfaces an error state with retry when the NLP proxy returns 503', async () => {
            stubFetch({
                custom: (call) => {
                    const url = new URL(call.url, 'http://test');
                    if (url.pathname === '/api/hope/admin/ai-services/nlp/status') {
                        return Response.json({ message: 'nlp service unavailable' }, { status: 503 });
                    }
                    return undefined;
                },
            });
            renderWithProviders(<AiServicesScreen />, { searchParams: '?tab=nlp' });

            expect(await screen.findByRole('alert')).toBeDefined();
            expect(screen.getByText('nlp service unavailable')).toBeDefined();
        });
    });

    describe('Instructions tab', () => {
        it('renders the resolved prompt tier, judge pin, thresholds and safety criteria', async () => {
            stubFetch();
            renderWithProviders(<AiServicesScreen />, { searchParams: '?tab=instructions' });

            await screen.findByText('SOAP');
            const panel = screen.getByRole('region', { name: 'Agentic instruction set' });
            expect(within(panel).getByText('SOAP')).toBeDefined();
            expect(within(panel).getByText('department')).toBeDefined();
            expect(within(panel).getByText('PDSQI-9')).toBeDefined();
            expect(within(panel).getByText('sha256:abc123def456')).toBeDefined();
            expect(within(panel).getByText('coverageThreshold')).toBeDefined();
            expect(within(panel).getByText('Content-safety guardrail')).toBeDefined();
            expect(within(panel).getByText('PHI redaction')).toBeDefined();
        });

        /**
         * M-01 sub-pattern: a (global)-tier screen reading per-tenant data —
         * the tab is gated on a working tenant, the rest of the screen is not.
         */
        it('gates the tab behind the working-tenant empty state when no tenant is selected', async () => {
            stubFetch({ session: { ...SESSION, workingTenantId: null, workingTenantName: null, effectiveTenantId: null } });
            renderWithProviders(<AiServicesScreen />, { searchParams: '?tab=instructions' });

            expect(await screen.findByText('Select a working tenant')).toBeDefined();
            expect(screen.queryByRole('region', { name: 'Agentic instruction set' })).toBeNull();
        });

        it('surfaces an error state when the instructions read fails', async () => {
            stubFetch({
                custom: (call) => {
                    const url = new URL(call.url, 'http://test');
                    if (url.pathname === '/api/hope/admin/agentic/instructions') {
                        return Response.json({ message: 'instructions unavailable' }, { status: 503 });
                    }
                    return undefined;
                },
            });
            renderWithProviders(<AiServicesScreen />, { searchParams: '?tab=instructions' });

            expect(await screen.findByRole('alert')).toBeDefined();
            expect(screen.getByText('instructions unavailable')).toBeDefined();
        });
    });

    it('has no axe violations with the guardrail panels rendered', async () => {
        stubFetch();
        const { container } = renderWithProviders(<AiServicesScreen />);
        await screen.findByText('llama-guard-3-8b');
        expect(await axe(container)).toHaveNoViolations();
    });

    it('has no axe violations on the Instructions tab', async () => {
        stubFetch();
        const { container } = renderWithProviders(<AiServicesScreen />, { searchParams: '?tab=instructions' });
        await screen.findByText('SOAP');
        expect(await axe(container)).toHaveNoViolations();
    });
});
