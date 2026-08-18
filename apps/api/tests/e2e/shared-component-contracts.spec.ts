/**
 * Shared-component BACKEND contract verification.
 *
 * The `@arcaai/ui` shared-component system (VirtualizedDataGrid /
 * HistoryTimelineList / LiveTranscript) is transport-agnostic (decision D5) —
 * it has no backend of its own. The only server contracts it *depends on* are
 * the two that were spawned by its ratified decisions:
 *
 *   - D7  → CURSOR (keyset) pagination   (GET /admin/audit-logs/cursor)
 *           — backs the grid's `pageMode: 'cursor'` + the SDK
 *             `extractCursorPaginated` / `useAuditLog().listByCursor` normalizer.
 *   - D8  → per-user grid-layout persistence under the `ui.data-grid`
 *           user-settings namespace (PATCH /users/me/settings/ui.data-grid/:key).
 *
 * This spec covers ONLY the cursor contract (D7), which is **not** exercised by
 * any sibling spec. The **D8** persistence round-trip (PATCH/GET/upsert + the
 * "value must be a JSON string" wire rule) is already covered end-to-end by
 * `admin-features-contract.spec.ts` — we deliberately do NOT duplicate it; see
 * that file's first describe block.
 *
 * Run: `pnpm test:e2e` (or a dev stack via
 * `SKIP_DB_PRECHECK=true API_URL=http://localhost:8968`). Each flow is a real
 * HTTP round-trip with the seeded `super_admin` (cross-tenant operator), the
 * same persona the audit-log offset suite uses.
 *
 * Source of truth verified live 2026-06-30:
 *   - apps/api/src/modules/audit-log/audit-log.controller.ts:132 (`fetchByCursor`)
 *   - packages/applications/src/common/dto/cursorPaginated.response.ts
 *     (`CursorPaginatedResponse<T>` → { data, nextCursor, hasMore, limit })
 *   - packages/applications/src/common/cursorPagination.ts (keyset engine)
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/** The cursor (keyset) reference endpoint backing the grid's cursor mode. */
const CURSOR_PATH = '/api/v1/admin/audit-logs/cursor';

interface AuditLogRow {
  id: string;
  action?: string;
  resourceType?: string;
  createdAt: string;
}

/** The CursorPaginatedResponse<T> envelope the grid's `extractCursorPaginated` consumes. */
interface CursorPage {
  data: AuditLogRow[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

const authGet = (request: APIRequestContext, path: string, token: string, params?: Record<string, string>) =>
  request.get(path, { headers: { Authorization: `Bearer ${token}` }, params });

const ids = (page: CursorPage): string[] => page.data.map((r) => r.id);

test.describe('shared-component contracts (D7 cursor pagination)', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    // Cross-tenant operator: super_admin logs in WITHOUT a tenantKey — the
    // same persona the offset audit-log suite uses (audit-log.spec.ts).
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(sa, 'super_admin login failed — is the stack seeded?').toBeTruthy();
    token = sa!.token;
  });

  // --- Envelope shape (the client `PageResult` cursor half) ------------------

  test('cursor route returns the { data, nextCursor, hasMore, limit } envelope (NOT offset)', async ({ request }) => {
    const res = await authGet(request, CURSOR_PATH, token, { limit: '5' });
    expect(res.status(), 'super_admin can read the cursor page').toBe(200);

    const page = (await res.json()) as CursorPage & Record<string, unknown>;
    // The cursor half of the client PageResult contract (lib/shared/pagination.ts).
    expect(Array.isArray(page.data), 'data is an array').toBe(true);
    expect(typeof page.hasMore, 'hasMore is a boolean').toBe('boolean');
    expect(page.nextCursor === null || typeof page.nextCursor === 'string', 'nextCursor is string|null').toBe(true);
    expect(typeof page.limit, 'limit is a number').toBe('number');

    // Keyset is count-free by design — the offset-only fields are absent so a
    // client can't accidentally treat a cursor page as an offset page.
    expect('count' in page, 'cursor envelope omits offset `count`').toBe(false);
    expect('page' in page, 'cursor envelope omits offset `page`').toBe(false);
  });

  test('cursor route honours `limit` (page size never exceeds it)', async ({ request }) => {
    const res = await authGet(request, CURSOR_PATH, token, { limit: '3' });
    expect(res.status()).toBe(200);
    const page = (await res.json()) as CursorPage;
    expect(page.limit, 'echoed limit').toBe(3);
    expect(page.data.length, 'page holds at most `limit` rows').toBeLessThanOrEqual(3);
  });

  // --- Keyset forward paging (the real grid "load more") ---------------------

  test('forward paging via nextCursor yields a DISJOINT, monotonically-ordered next slice', async ({ request }) => {
    const first = (await (await authGet(request, CURSOR_PATH, token, { limit: '1' })).json()) as CursorPage;
    test.skip(first.data.length === 0, 'no audit logs seeded — nothing to page through');
    test.skip(!first.hasMore || !first.nextCursor, 'only one audit-log page available; cannot assert forward paging');

    const second = (await (await authGet(request, CURSOR_PATH, token, { limit: '1', cursor: first.nextCursor! })).json()) as CursorPage;

    // Keyset guarantees: page 2 never repeats a page-1 row...
    const overlap = ids(first).filter((id) => ids(second).includes(id));
    expect(overlap, 'cursor pages do not overlap (keyset, not offset)').toEqual([]);

    // ...and the (createdAt, id) DESC order is monotonic across the boundary.
    if (second.data.length > 0) {
      expect(
        new Date(second.data[0].createdAt).getTime(),
        'next page continues the createdAt DESC keyset (older-or-equal than the previous page tail)',
      ).toBeLessThanOrEqual(new Date(first.data[first.data.length - 1].createdAt).getTime());
    }
  });

  test('the terminal page reports hasMore=false WITH nextCursor=null', async ({ request }) => {
    // Walk the keyset to the end (bounded so a large cross-tenant trail can't
    // hang the suite). The invariant under test is the terminal contract:
    // hasMore=false ⇔ nextCursor=null.
    const MAX_PAGES = 50;
    const LIMIT = 50;
    let cursor: string | null = null;
    let reachedEnd = false;

    for (let i = 0; i < MAX_PAGES; i++) {
      const params: Record<string, string> = { limit: String(LIMIT) };
      if (cursor) params.cursor = cursor;
      const page = (await (await authGet(request, CURSOR_PATH, token, params)).json()) as CursorPage;

      // Per-page invariant: hasMore and a non-null cursor agree.
      expect(page.hasMore, 'hasMore agrees with nextCursor presence').toBe(page.nextCursor !== null);

      if (!page.hasMore) {
        expect(page.nextCursor, 'terminal page has a null cursor').toBeNull();
        reachedEnd = true;
        break;
      }
      cursor = page.nextCursor;
    }

    test.skip(!reachedEnd, `audit trail exceeds ${MAX_PAGES * LIMIT} rows — terminal page not reached in the bounded walk`);
    expect(reachedEnd).toBe(true);
  });

  // --- Negative / robustness -------------------------------------------------

  test('a malformed cursor is rejected with 400 (opaque, shape-validated token)', async ({ request }) => {
    const res = await authGet(request, CURSOR_PATH, token, { cursor: 'not-a-real-cursor-%%%', limit: '5' });
    expect(res.status(), 'garbage cursor → 400 Invalid cursor').toBe(400);
  });

  test('cursor route requires authentication (401)', async ({ request }) => {
    const res = await request.get(CURSOR_PATH, { params: { limit: '5' } });
    expect(res.status()).toBe(401);
  });

  // --- A8 filter parity (cursor route accepts the same filters as offset) -----

  test('cursor route accepts the A8 filters (action) without a 400 and narrows the page', async ({ request }) => {
    // `READ` rows are produced by the very act of listing/authorizing, so the
    // seeded trail reliably contains them. The contract under test is that the
    // cursor route accepts the same A8 filters as the offset list.
    const res = await authGet(request, CURSOR_PATH, token, { limit: '20', action: 'READ' });
    expect(res.status(), 'action filter accepted on the cursor route (no 400)').toBe(200);
    const page = (await res.json()) as CursorPage;
    for (const row of page.data) {
      expect(row.action, 'every returned row matches the action filter').toBe('READ');
    }
  });
});
