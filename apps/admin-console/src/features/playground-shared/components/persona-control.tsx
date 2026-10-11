'use client';

import { useEffect, useState } from 'react';
import { IconChevronDown, IconInfoCircle, IconSpy } from '@tabler/icons-react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@arcaai/ui/components/shadcn/command';
import { Popover, PopoverContent, PopoverTrigger } from '@arcaai/ui/components/shadcn/popover';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { getJson, type Paginated } from '@/shared/api';
import { isTenantAdmin } from '@/shared/auth/ability';
import type { SafeSession } from '@/shared/auth/hooks';
import { invalidateGridLayoutCache } from '@/shared/data/grid-persistence';

/** Minimal user shape for the picker — persona-control stays self-contained
 *  (features never import each other; rule 13). Users list via the BFF proxy. */
interface PersonaUser {
  id: string;
  username: string;
  email?: string;
}

/**
 * Omni search targets (→ gateway `searchFields`) — stable ref, matching the
 * verified reference in `features/users/components/users-list-screen.tsx`.
 * `email` is NOT a column on `User` (it lives on the related `UserProfile`
 * model — `packages/database/src/prisma/db_main/user.prisma`), so including
 * it here would make `formatFindAllProps`'s per-field Prisma `contains`
 * throw at runtime the moment a caller typed anything.
 */
const PERSONA_SEARCH_FIELDS = 'username,externalId';

/** Users per page; BUG-023 — further pages load on demand ("Load more"). */
const PERSONA_PAGE_SIZE = 8;

/**
 * BUG-023 D2 — overlay scrollbars (macOS) stay invisible until scrolled, so a long list read
 * as complete. Styled here only, not on the shared `CommandList` (~20 other consumers).
 * Deliberately NO `scrollbar-width`: once that standard property is set, Chromium ignores
 * `::-webkit-scrollbar` and falls back to the hidden overlay scrollbar.
 */
const VISIBLE_SCROLLBAR =
  '[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/40';

/**
 * Playground persona control (artboard 4a). The playground runs
 * end-user planes under the caller's account; a SUPER_ADMIN impersonates any
 * non-admin user cross-tenant, and — D-25 — a TENANT_ADMIN impersonates a
 * clinician within its OWN tenant, so the OD-2 "clinical usage is a tenant
 * admin impersonating a clinician" premise has a working affordance. Both
 * routes to the BFF (`POST /api/auth/impersonate`) resolve to the endpoint
 * that already enforces the right scope server-side — see the route's own
 * doc comment. The bearer swap invalidates every query, so a switch/stop must
 * refetch the whole cache and refresh the server layout.
 *
 * A caller holding neither role degrades to "yourself" with the reason.
 * "under {admin}" is always shown.
 */
export function PersonaControl({ session }: { session: SafeSession }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Debounced (300ms, house value — `departments-screen.tsx`) — `search`
  // hits the server on every change (GET admin/users?search=…).
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const [pending, setPending] = useState(false);

  const canImpersonate = session.isElevated || isTenantAdmin(session.user.roles);
  const impersonating = !!session.impersonatingUserId;
  const targetLabel = session.impersonatingUsername ?? session.impersonatingUserId ?? 'yourself';
  const admin = session.user.username;

  // After a bearer swap every query is stale; refetch all + refresh the
  // server layout so the sealed session projection re-reads. Mirrors the
  // global session banners' invalidation.
  async function runSessionAction(url: string, body?: Record<string, unknown>) {
    setPending(true);
    try {
      await fetch(url, {
        method: 'POST',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      invalidateGridLayoutCache();
      await queryClient.invalidateQueries();
      router.refresh();
      setOpen(false);
    } finally {
      setPending(false);
    }
  }

  // BUG-023 D1 — paged. `page` is 1-BASED in practice: the repository skips `(page - 1) * limit`
  // (`repository.helpers.ts`), so 0 and 1 are the same first page whatever `PaginatedQuery`'s
  // doc says. The next page comes from the envelope's `count`, never its echoed `limit` (F-02).
  const usersQuery = useInfiniteQuery({
    queryKey: ['playground', 'persona', 'user-search', debouncedSearch],
    queryFn: ({ pageParam }) =>
      getJson<Paginated<PersonaUser>>('admin/users', {
        search: debouncedSearch || undefined,
        searchFields: PERSONA_SEARCH_FIELDS,
        page: pageParam,
        limit: PERSONA_PAGE_SIZE,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) => (pages.length * PERSONA_PAGE_SIZE < lastPage.count ? pages.length + 1 : undefined),
    enabled: open && canImpersonate,
    staleTime: 30_000,
  });
  const users = usersQuery.data?.pages.flatMap((page) => page.data) ?? [];
  const totalUsers = usersQuery.data?.pages.at(-1)?.count ?? 0;

  const underAdmin = <span className="text-muted-foreground shrink-0 truncate text-xs">under {admin}</span>;

  // Neither SUPER_ADMIN nor TENANT_ADMIN: impersonation is unavailable.
  if (!canImpersonate) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm">
          <IconSpy className="text-muted-foreground size-4 shrink-0" aria-hidden />
          Acting as yourself
        </span>
        <span className="text-muted-foreground hidden items-center gap-1 text-xs sm:inline-flex">
          <IconInfoCircle className="size-3.5 shrink-0" aria-hidden />
          Impersonation requires an admin role
        </span>
        {underAdmin}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="min-w-0 gap-1.5" disabled={pending}>
            <IconSpy className="size-4 shrink-0" aria-hidden />
            <span className="truncate">
              Acting as <span className="font-medium">{targetLabel === 'yourself' ? 'yourself' : `«${targetLabel}»`}</span>
            </span>
            <IconChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search users to act as…" value={search} onValueChange={setSearch} />
            <CommandList className={VISIBLE_SCROLLBAR}>
              <CommandEmpty>{usersQuery.isFetching ? 'Searching…' : 'No users found.'}</CommandEmpty>
              {users.map((user) => (
                <CommandItem
                  key={user.id}
                  value={user.id}
                  disabled={pending || user.id === session.impersonatingUserId}
                  onSelect={() => void runSessionAction('/api/auth/impersonate', { userId: user.id })}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{user.username}</span>
                    {user.email ? <span className="text-muted-foreground truncate text-xs">{user.email}</span> : null}
                  </div>
                </CommandItem>
              ))}
              {usersQuery.hasNextPage ? (
                <>
                  <p className="text-muted-foreground px-2 pt-1.5 text-xs">
                    Showing {users.length} of {totalUsers} — type to narrow
                  </p>
                  <CommandItem
                    value="__load-more__"
                    disabled={usersQuery.isFetchingNextPage}
                    onSelect={() => void usersQuery.fetchNextPage()}
                    className="justify-center"
                  >
                    {usersQuery.isFetchingNextPage ? <Spinner /> : null}
                    Load more
                  </CommandItem>
                </>
              ) : null}
            </CommandList>
            {impersonating ? (
              <div className="border-t p-1.5">
                <Button
                  variant="destructive"
                  size="sm"
                  className="w-full"
                  disabled={pending}
                  onClick={() => void runSessionAction('/api/auth/revoke-impersonation')}
                >
                  Stop acting
                </Button>
              </div>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>
      {underAdmin}
    </div>
  );
}
