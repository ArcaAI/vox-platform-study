import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { SidebarProvider } from '@arcaai/ui/components/shadcn/sidebar';
import type { PermissionRule } from '@/shared/auth/ability';
import { FEATURE_GATE_KEYS, type FeatureGateMap } from '@/shared/feature-gates/keys';
import { renderWithProviders } from '@/test/render';

/**
 * Shared harness for the two-tier shell tests.
 *
 * Not a test file (the vitest projects include `*.test.ts(x)` only) — it exists
 * so the rail and the scoped sidebar are exercised against the SAME permission
 * fixtures, which is the whole point of AC-3: one ability path, two surfaces.
 */
export const SUPER_ADMIN_RULES: PermissionRule[] = [{ action: 'manage', subject: 'all' }];

/**
 * A deliberately narrow, non-admin caller. Produces exactly the shape the ticket's
 * Open Question is about:
 *   - Clinical -> 1 visible route (/consultations)
 *   - Knowledge & Agents -> 3 visible routes (/agents, /prompt-templates, /knowledge)
 * Nothing else is reachable, and the caller holds no admin role, so the
 * playground tier stays hidden too (its five demo planes carry `required: []`,
 * so only the role check keeps them out).
 */
export const NARROW_TENANT_RULES: PermissionRule[] = [
  { action: 'manage', subject: 'Consultation' },
  { action: 'manage', subject: 'PromptTemplate' },
  { action: 'manage', subject: 'KnowledgeDocument' },
];

export interface NavFixtureOptions {
  rules?: PermissionRule[];
  roles?: string[];
  isElevated?: boolean;
  /**
   * Platform-wide feature-gate resolution (TASK-932 §3.2). Defaults to every
   * key `true` — the rail/sidebar/⌘K specs predate the gate axis and assert
   * the gated entries (MLflow, Agentic policy, Tools & MCP, the whole
   * Workflow & Harness domain) are reachable by ability alone; a test that
   * wants to exercise a CLOSED gate passes its own partial map here.
   */
  gates?: FeatureGateMap;
}

/** Every feature gate open — the harness default so ability remains the only variable most specs vary. */
const ALL_GATES_OPEN: FeatureGateMap = Object.fromEntries(FEATURE_GATE_KEYS.map((key) => [key, true]));

/** The narrow caller, shared so the rail and the sidebar are judged alike. */
export const NARROW_TENANT_FIXTURE: NavFixtureOptions = {
  rules: NARROW_TENANT_RULES,
  roles: ['DEPARTMENT_HEAD'],
  isElevated: false,
};

/** Stubs the three BFF reads (`useSession` + `usePermissions` + `useFeatureGates`) the shell depends on. */
export function stubNavSession({ rules = SUPER_ADMIN_RULES, roles = ['SUPER_ADMIN'], isElevated = true, gates = ALL_GATES_OPEN }: NavFixtureOptions = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/auth/session')) {
        return Response.json({
          user: { id: 'u-1', username: 'root', email: 'root@example.com', roles },
          isElevated,
          workingTenantId: null,
          workingTenantName: null,
          impersonatingUserId: null,
          impersonatingUsername: null,
          // The shell judges tiers on the EFFECTIVE identity (TASK-954); not
          // impersonating here, so it mirrors the operator.
          effectiveUser: { id: 'u-1', username: 'root', email: 'root@example.com', roles, tenantId: isElevated ? null : 'tnt-1', departmentId: null },
          effectiveIsElevated: isElevated,
          effectiveTenantId: isElevated ? null : 'tnt-1',
        });
      }
      if (url.includes('features/effective')) {
        return Response.json({ items: Object.entries(gates).map(([key, value]) => ({ key, value, sourceScope: 'system' })) });
      }
      return Response.json({ userId: 'u-1', tenantId: null, permissions: rules });
    }),
  );
}

/** Desktop viewport by default — `useIsMobile` reads both matchMedia and innerWidth. */
export function mockViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /min-width:\s*(\d+)/.exec(query);
    const max = /max-width:\s*(\d+)/.exec(query);
    const matches = min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false;
    return {
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    } as MediaQueryList;
  });
}

export function renderInShell(ui: ReactElement, options: NavFixtureOptions & { width?: number } = {}) {
  mockViewport(options.width ?? 1440);
  stubNavSession(options);
  return renderWithProviders(<SidebarProvider>{ui}</SidebarProvider>);
}
