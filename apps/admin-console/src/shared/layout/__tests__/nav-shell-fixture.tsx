import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { SidebarProvider } from '@arcaai/ui/components/shadcn/sidebar';
import type { PermissionRule } from '@/shared/auth/ability';
import { renderWithProviders } from '@/test/render';

/**
 * Shared harness for the TASK-788 two-tier shell tests.
 *
 * Not a test file (the vitest projects include `*.test.ts(x)` only) — it exists
 * so the rail and the scoped sidebar are exercised against the SAME permission
 * fixtures, which is the whole point of AC-3: one ability path, two surfaces.
 */
export const SUPER_ADMIN_RULES: PermissionRule[] = [{ action: 'manage', subject: 'all' }];

/**
 * A deliberately narrow, non-admin caller. Produces exactly the shape the ticket's
 * Open Question is about:
 *   - Clinical      -> 1 visible route  (/consultations)
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
}

/** The narrow caller, shared so the rail and the sidebar are judged alike. */
export const NARROW_TENANT_FIXTURE: NavFixtureOptions = {
  rules: NARROW_TENANT_RULES,
  roles: ['DEPARTMENT_HEAD'],
  isElevated: false,
};

/** Stubs the two BFF reads (`useSession` + `usePermissions`) the shell depends on. */
export function stubNavSession({ rules = SUPER_ADMIN_RULES, roles = ['SUPER_ADMIN'], isElevated = true }: NavFixtureOptions = {}) {
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
        });
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
