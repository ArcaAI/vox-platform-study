/**
 * TASK-327 T2 — admin menu-order preference.
 *
 * Two layers:
 *  1. Pure resolvers (`resolveMenuOrder`, `extractMenuOrder`, `orderItemsById`)
 *     — precedence + defensiveness, tested without React.
 *  2. The hook's persistence contract — `reorder` issues exactly one
 *     `updateByKey('arcaai-admin','menuOrder', newOrder)` and toasts.
 *
 * `@arcaai/vox` is globally stubbed by the vitest config, so the SDK hooks
 * are mocked here; `sonner` is mocked to assert the toast contract.
 */
import { act, renderHook, waitFor } from '@testing-library/react';

// `vi.mock` factories are hoisted above the imports, so the variables they
// close over must be created with `vi.hoisted` (otherwise they are still in
// the temporal dead zone when the mocked module is first imported).
const { mockList, mockUpdateByKey, mockGetByTenant, mockToast } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockUpdateByKey: vi.fn(),
  mockGetByTenant: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@arcaai/vox', () => ({
  useUserSettings: () => ({ list: mockList, updateByKey: mockUpdateByKey, settings: [], isLoading: false, error: null }),
  useGlobalSettings: () => ({ getByTenant: mockGetByTenant }),
}));

vi.mock('sonner', () => ({ toast: mockToast }));

import {
  ADMIN_MENU_NAMESPACE,
  ADMIN_MENU_ORDER_KEY,
  DEFAULT_ADMIN_MENU_ORDER,
  extractMenuOrder,
  orderItemsById,
  resolveMenuOrder,
  useAdminPreferences,
} from '../use-admin-preferences';
import { useAuthStore } from '@/store/auth-store';

describe('resolveMenuOrder precedence (USER → TENANT → DEFAULT)', () => {
  const userOrder = ['users', 'tenants'];
  const tenantOrder = ['tenants', 'prompts'];

  it('uses the USER setting when present (even if a TENANT default exists)', () => {
    const result = resolveMenuOrder({
      userSettings: [{ key: 'menuOrder', namespace: 'arcaai-admin', value: userOrder }],
      tenantSettings: [{ key: 'menuOrder', namespace: 'arcaai-admin', value: tenantOrder }],
    });
    expect(result).toEqual(userOrder);
  });

  it('falls back to the TENANT default when there is no USER setting', () => {
    const result = resolveMenuOrder({
      userSettings: [],
      tenantSettings: [{ key: 'menuOrder', namespace: 'arcaai-admin', value: tenantOrder }],
    });
    expect(result).toEqual(tenantOrder);
  });

  it('falls back to DEFAULT when neither USER nor TENANT has a setting', () => {
    const result = resolveMenuOrder({ userSettings: [], tenantSettings: [] });
    expect(result).toEqual([...DEFAULT_ADMIN_MENU_ORDER]);
  });
});

describe('extractMenuOrder defensiveness', () => {
  it('matches on key alone when namespace is absent', () => {
    expect(extractMenuOrder([{ key: 'menuOrder', value: ['a', 'b'] }])).toEqual(['a', 'b']);
  });

  it('ignores a setting whose namespace is a different one', () => {
    expect(extractMenuOrder([{ key: 'menuOrder', namespace: 'arcaai-sdk', value: ['a'] }])).toBeUndefined();
  });

  it('parses a JSON-string value', () => {
    expect(extractMenuOrder([{ key: 'menuOrder', value: '["x","y"]' }])).toEqual(['x', 'y']);
  });

  it('ignores a non-array / non-string value', () => {
    expect(extractMenuOrder([{ key: 'menuOrder', value: 42 }])).toBeUndefined();
  });

  it('returns undefined when the key is missing', () => {
    expect(extractMenuOrder([{ key: 'somethingElse', value: ['a'] }])).toBeUndefined();
  });
});

describe('orderItemsById', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('orders items by the saved order', () => {
    expect(orderItemsById(items, ['c', 'a', 'b']).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('appends unknown items at the end, preserving their relative order', () => {
    expect(orderItemsById(items, ['b']).map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('useAdminPreferences persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useAuthStore.getState().logout();
    mockList.mockResolvedValue([]);
    mockGetByTenant.mockResolvedValue([]);
    mockUpdateByKey.mockResolvedValue({});
  });

  it('resolves the persisted USER order on mount', async () => {
    mockList.mockResolvedValue([{ key: ADMIN_MENU_ORDER_KEY, namespace: ADMIN_MENU_NAMESPACE, value: ['users', 'tenants'] }]);
    const { result } = renderHook(() => useAdminPreferences());
    await waitFor(() => expect(result.current.order).toEqual(['users', 'tenants']));
  });

  it('reorder persists exactly one updateByKey call with the new order', async () => {
    const { result } = renderHook(() => useAdminPreferences());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const next = ['tenants', 'users', 'overview'];
    await act(async () => {
      await result.current.reorder(next);
    });

    expect(mockUpdateByKey).toHaveBeenCalledTimes(1);
    expect(mockUpdateByKey).toHaveBeenCalledWith(ADMIN_MENU_NAMESPACE, ADMIN_MENU_ORDER_KEY, next);
    expect(result.current.order).toEqual(next);
    expect(mockToast.success).toHaveBeenCalledTimes(1);
  });

  it('reverts the optimistic order and toasts an error when persistence fails', async () => {
    mockList.mockResolvedValue([{ key: ADMIN_MENU_ORDER_KEY, namespace: ADMIN_MENU_NAMESPACE, value: ['users', 'tenants'] }]);
    mockUpdateByKey.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useAdminPreferences());
    await waitFor(() => expect(result.current.order).toEqual(['users', 'tenants']));

    await act(async () => {
      await result.current.reorder(['tenants', 'users']);
    });

    expect(result.current.order).toEqual(['users', 'tenants']);
    expect(mockToast.error).toHaveBeenCalledTimes(1);
  });
});
