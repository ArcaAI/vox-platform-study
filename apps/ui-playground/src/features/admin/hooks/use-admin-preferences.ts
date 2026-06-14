import { useCallback, useEffect, useRef, useState } from 'react';
import { useGlobalSettings, useUserSettings } from '@arcaai/vox';
import { toast } from 'sonner';
import { useAuthStore } from '@/store/auth-store';

/**
 * TASK-327 T2 — admin console menu-order preference.
 *
 * Precedence on resolve: USER setting → TENANT default → hardcoded DEFAULT.
 * Persisted per-user via the SDK's `PATCH /user/me/settings/:ns/:key` under
 * the server-owned `arcaai-admin` namespace (no DB migration — the namespace
 * already exists, see packages/applications userPreferences). Reorders are
 * optimistic and reverted on failure.
 */
export const ADMIN_MENU_NAMESPACE = 'arcaai-admin';
export const ADMIN_MENU_ORDER_KEY = 'menuOrder';

/** Canonical id + order of the admin console menu (shared with the sidebar). */
export const DEFAULT_ADMIN_MENU_ORDER: readonly string[] = [
  'overview',
  'dna-reports',
  'tenants',
  'users',
  'prompts',
  'departments',
  'audio-pipelines',
  // TASK-356 Phase 1 — tenant AI model catalog.
  'ai-models',
  'storage',
  'configurations',
  'audit-logs',
  // TASK-336 — new admin ops surfaces. `jobs` is tenant-scoped; `system-health`,
  // `rate-limits` and `queues` (OB-03) are global-scope ops. Prisma Studio stays
  // segregated last.
  'jobs',
  // TASK-330 Phase 6 — clinical documentation harness console.
  'harness',
  'system-health',
  'rate-limits',
  'queues',
  'studio',
];

type SettingLike = { key?: string; value?: unknown; namespace?: string; [k: string]: unknown };

function coerceOrder(value: unknown): string[] | undefined {
  let arr: unknown = value;
  // The setting value may round-trip as a JSON string depending on the
  // backend's column type — accept both a real array and a JSON-encoded one.
  if (typeof value === 'string') {
    try {
      arr = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(arr) && arr.every((v) => typeof v === 'string')) {
    return arr as string[];
  }
  return undefined;
}

/**
 * Pull the persisted menu-order array out of a settings list. Defensive: the
 * returned settings may only reliably expose `key`/`value`, so we match on
 * `key` and only enforce the namespace when it is actually present.
 */
export function extractMenuOrder(settings: SettingLike[] | undefined | null): string[] | undefined {
  if (!Array.isArray(settings)) return undefined;
  const match = settings.find((s) => s?.key === ADMIN_MENU_ORDER_KEY && (s.namespace === undefined || s.namespace === ADMIN_MENU_NAMESPACE));
  if (!match) return undefined;
  return coerceOrder(match.value);
}

/** Pure precedence resolver (USER → TENANT → DEFAULT). Unit tested directly. */
export function resolveMenuOrder(opts: {
  userSettings?: SettingLike[] | null;
  tenantSettings?: SettingLike[] | null;
  defaultOrder?: readonly string[];
}): string[] {
  const fallback = [...(opts.defaultOrder ?? DEFAULT_ADMIN_MENU_ORDER)];
  return extractMenuOrder(opts.userSettings ?? undefined) ?? extractMenuOrder(opts.tenantSettings ?? undefined) ?? fallback;
}

/**
 * Order a set of `{ id }` items by a saved id order. Items missing from the
 * saved order keep their original relative position at the end, so a
 * newly-introduced menu never disappears because the saved order predates it.
 */
export function orderItemsById<T extends { id: string }>(items: T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i] as const));
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ra = rank.get(a.item.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.item.id) ?? Number.MAX_SAFE_INTEGER;
      return ra === rb ? a.i - b.i : ra - rb;
    })
    .map(({ item }) => item);
}

export interface UseAdminPreferencesReturn {
  order: string[];
  isLoading: boolean;
  reorder: (nextOrder: string[]) => Promise<void>;
}

export function useAdminPreferences(): UseAdminPreferencesReturn {
  const { list: listUserSettings, updateByKey } = useUserSettings();
  const { getByTenant } = useGlobalSettings();
  const tenantId = useAuthStore((s) => s.tenantId);

  const [order, setOrder] = useState<string[]>(() => [...DEFAULT_ADMIN_MENU_ORDER]);
  const [isLoading, setIsLoading] = useState(true);

  // Mirror the latest order in a ref so an optimistic reorder can revert to
  // the exact pre-reorder value without depending on a (possibly stale)
  // render closure.
  const orderRef = useRef(order);
  orderRef.current = order;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      let userSettings: SettingLike[] | undefined;
      let tenantSettings: SettingLike[] | undefined;
      try {
        userSettings = (await listUserSettings()) as SettingLike[];
      } catch {
        userSettings = undefined;
      }
      // Only consult the tenant default when the user has no personal order.
      if (!extractMenuOrder(userSettings) && tenantId) {
        try {
          tenantSettings = (await getByTenant(tenantId)) as SettingLike[];
        } catch {
          tenantSettings = undefined;
        }
      }
      if (cancelled) return;
      setOrder(resolveMenuOrder({ userSettings, tenantSettings }));
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [listUserSettings, getByTenant, tenantId]);

  const reorder = useCallback(
    async (nextOrder: string[]) => {
      const previous = orderRef.current;
      setOrder(nextOrder);
      orderRef.current = nextOrder;
      try {
        await updateByKey(ADMIN_MENU_NAMESPACE, ADMIN_MENU_ORDER_KEY, nextOrder);
        toast.success('Menu order saved');
      } catch {
        setOrder(previous);
        orderRef.current = previous;
        toast.error('Failed to save menu order');
      }
    },
    [updateByKey],
  );

  return { order, isLoading, reorder };
}
