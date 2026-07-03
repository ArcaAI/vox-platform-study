import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Separator } from '@arcaai/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@arcaai/ui/sheet';
import { Spinner } from '@arcaai/ui/spinner';
import type { Policy } from '@arcaai/vox';
import { Plus, ShieldCheck, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { isProtectedSystemPolicy, PROTECTED_POLICY_REASON } from './protected-policies';
import { rolePolicies, type RoleWithPolicies } from './types';

/**
 * Role ↔ policy assignment drawer (TASK-374). Attached policies come straight off
 * the role object (`policies[]`, returned by the RBAC roles endpoint — see
 * {@link rolePolicies}); attach/detach call the SDK `useRoles().assignPolicy` /
 * `removePolicy` methods (no raw apiClient needed). The parent refreshes the role
 * list after each mutation so this view reflects the new state.
 *
 * TASK-409 — detaching a protected system policy is absolutely blocked
 * server-side (anti-lockout, 403 even with break-glass), so the detach button
 * is disabled for those; all other detaches go through the parent's
 * break-glass dialog.
 */
export function RolePoliciesSheet({
  role,
  allPolicies,
  open,
  onOpenChange,
  onAttach,
  onDetach,
  busyPolicyId,
}: {
  role: RoleWithPolicies | null;
  allPolicies: Policy[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAttach: (policyId: string) => Promise<void>;
  onDetach: (policyId: string) => Promise<void>;
  busyPolicyId: string | null;
}) {
  const [search, setSearch] = useState('');

  const attached = role ? rolePolicies(role) : [];
  const attachedIds = useMemo(() => new Set(attached.map((p) => p.id)), [attached]);

  const available = useMemo(() => {
    const term = search.trim().toLowerCase();
    return allPolicies.filter((p) => !attachedIds.has(p.id)).filter((p) => (term ? (p.name ?? '').toLowerCase().includes(term) : true));
  }, [allPolicies, attachedIds, search]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Manage policies</SheetTitle>
          <SheetDescription>
            Attach or detach CASL policies for <span className="font-medium text-foreground">{role?.name ?? 'role'}</span>.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-2">
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Attached ({attached.length})</h3>
            {attached.length === 0 ? (
              <p className="text-sm text-muted-foreground">No policies attached yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {attached.map((p) => {
                  const protectedPolicy = isProtectedSystemPolicy(p);
                  return (
                    <li key={p.id} className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-medium">{p.name || p.id}</span>
                        {typeof p.priority === 'number' ? (
                          <Badge variant="outline" className="shrink-0 text-xs">
                            p{p.priority}
                          </Badge>
                        ) : null}
                        {protectedPolicy ? (
                          <Badge variant="outline" className="shrink-0 text-xs" title={PROTECTED_POLICY_REASON}>
                            Protected
                          </Badge>
                        ) : null}
                      </div>
                      <span title={protectedPolicy ? PROTECTED_POLICY_REASON : undefined} className="inline-flex shrink-0">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0 text-muted-foreground hover:text-destructive max-sm:size-11"
                          onClick={() => void onDetach(p.id)}
                          disabled={busyPolicyId === p.id || protectedPolicy}
                          aria-label={
                            protectedPolicy ? `Detach ${p.name || p.id} (protected system policy — cannot be detached)` : `Detach ${p.name || p.id}`
                          }
                        >
                          {busyPolicyId === p.id ? <Spinner className="size-4" /> : <X className="size-4" />}
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <Separator />

          <section className="flex min-h-0 flex-1 flex-col gap-2">
            <h3 className="text-sm font-medium">Available</h3>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search policies…"
              className="h-9 max-sm:min-h-11"
              aria-label="Search available policies"
            />
            {available.length === 0 ? (
              <p className="text-sm text-muted-foreground">{allPolicies.length === 0 ? 'No policies exist yet.' : 'No more policies to attach.'}</p>
            ) : (
              <ul className="space-y-1.5">
                {available.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{p.name}</span>
                      {p.scope ? <span className="truncate text-xs text-muted-foreground">{p.scope}</span> : null}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 max-sm:h-11"
                      onClick={() => void onAttach(p.id)}
                      disabled={busyPolicyId === p.id}
                      aria-label={`Attach ${p.name}`}
                    >
                      {busyPolicyId === p.id ? <Spinner className="size-4" /> : <Plus className="size-4" />}
                      Attach
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
