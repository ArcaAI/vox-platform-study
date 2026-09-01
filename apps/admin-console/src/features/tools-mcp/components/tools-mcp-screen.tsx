'use client';

import { useState } from 'react';
import { IconAlertTriangle, IconPencil, IconPlugConnected, IconPlus, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { useSession } from '@/shared/auth';
import { SYSTEM_TENANT_ID } from '@/shared/catalog';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { etagFromVersion, useDeleteMcpServer, useMcpGate, useMcpServers } from '../api';
import type { McpServer } from '../api';
import { McpServerFormDialog } from './mcp-server-form-dialog';

function LoadingTable() {
  return (
    <div className="rounded-md border" aria-hidden>
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-4 w-48" />
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

function AuthPresence({ authRef }: { authRef?: string | null }) {
  return authRef ? (
    <Badge variant="secondary" className="text-xs">
      Configured
    </Badge>
  ) : (
    <Badge variant="outline" className="text-xs">
      None
    </Badge>
  );
}

function AllowlistCell({ allowlist }: { allowlist?: string[] | null }) {
  if (!allowlist?.length) {
    return <span className="text-muted-foreground text-xs">unrestricted</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {allowlist.map((tool) => (
        <Badge key={tool} variant="outline" className="font-mono text-xs">
          {tool}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Tools & MCP (`/tools-mcp`) — the MCP connector registry, full CRUD under
 * If-Match OCC against `admin/mcp-servers`.
 *
 * TIER 20-29 (shared audience) since OWNER DECISION **OD-7** (2026-09-01):
 * tenant admins may configure MCP connectors, so this is no longer a
 * `(global)` super-admin screen. It renders in BOTH modes, and the difference
 * is per ROW rather than per screen:
 *
 *   - **Super admin** — cross-tenant. With no working tenant selected the
 *     gateway serves the SYSTEM registry; with one selected it serves that
 *     tenant's rows plus SYSTEM. Every row is writable.
 *   - **Tenant admin** — pinned to its own tenant by the gateway, and sees its
 *     own connectors PLUS the read-only SYSTEM-shared registry. Own rows are
 *     writable; SYSTEM rows are not (the gateway answers 403), so their
 *     controls are disabled with a stated reason rather than failing on click.
 *
 * The screen is advisory about `mcpToolsEnabled` (OD-11, per-tenant): a
 * connector registered while the gate is off is configured but never invocable,
 * which the user should learn here and not at runtime.
 *
 * SECURITY: `authRef` is a Vault path; the table shows presence only.
 */
export function ToolsMcpScreen() {
  const session = useSession();

  if (session.isPending) {
    return (
      <ScreenTemplate header={<PageHeader title="Tools & MCP" />}>
        <LoadingTable />
      </ScreenTemplate>
    );
  }

  const isElevated = session.data?.effectiveIsElevated ?? false;
  const callerTenantId = session.data?.effectiveTenantId ?? null;

  return <ToolsMcpBody isElevated={isElevated} callerTenantId={callerTenantId} />;
}

function ToolsMcpBody({ isElevated, callerTenantId }: { isElevated: boolean; callerTenantId: string | null }) {
  const query = useMcpServers(true);
  const gate = useMcpGate(true);
  const deleteMutation = useDeleteMcpServer();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? items.length;
  // `null` (no opinion in either tier) resolves to OFF — assert it, don't assume.
  const toolsEnabled = gate.data?.mcpToolsEnabled === true;
  // Advisory only: a caller without `read:HarnessPolicy` gets no banner rather
  // than a false "disabled" claim we cannot substantiate.
  const gateKnown = gate.isSuccess;

  /**
   * A SYSTEM-registry row is the shared platform tier: readable by every tenant,
   * writable only by a platform admin. This mirrors the gateway's split gate —
   * the UI must not offer an action the server will refuse.
   */
  function canWrite(server: McpServer): boolean {
    return isElevated || (server.tenantId !== SYSTEM_TENANT_ID && server.tenantId === callerTenantId);
  }

  function openCreate() {
    setEditingId(null);
    setSheetOpen(true);
  }

  function openEdit(server: McpServer) {
    setEditingId(server.id);
    setSheetOpen(true);
  }

  function handleDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(
      { id: deleteTarget.id, etag: etagFromVersion(deleteTarget.version) },
      {
        onSuccess: () => {
          toast.success('Server deleted');
          setDeleteTarget(null);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <>
      <ScreenTemplate
        header={
          <PageHeader
            title="Tools & MCP"
            meta={<span>{isElevated ? 'Platform + tenant registry' : 'Your connectors + the shared platform registry'} · streamable-HTTP</span>}
            actions={
              <Button onClick={openCreate}>
                <IconPlus aria-hidden data-icon="inline-start" />
                Register server
              </Button>
            }
          />
        }
        statusBanner={
          gateKnown && !toolsEnabled ? (
            <Alert>
              <IconAlertTriangle aria-hidden />
              <AlertTitle>MCP tools are turned off for this tenant</AlertTitle>
              <AlertDescription>
                Connectors below can be registered and edited, but the agentic harness will not call any of them until{' '}
                <span className="font-mono">mcpToolsEnabled</span> is turned on in the harness policy.
              </AlertDescription>
            </Alert>
          ) : undefined
        }
        footer={
          <StatusFooter
            end={
              <span aria-hidden className="font-mono">
                GET /admin/mcp-servers · {total} server{total === 1 ? '' : 's'}
              </span>
            }
          />
        }
      >
        {query.isPending ? (
          <LoadingTable />
        ) : query.error ? (
          <ErrorState title={'Couldn’t load the MCP registry'} error={query.error} onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={IconPlugConnected}
            title="No MCP servers registered yet"
            description="Register an external MCP server to expose allowlisted tools to the agentic harness. Servers stay dormant until enabled."
            action={
              <Button onClick={openCreate}>
                <IconPlus aria-hidden data-icon="inline-start" />
                Register server
              </Button>
            }
          />
        ) : (
          <div className="rounded-md border">
            <Table aria-label="MCP servers">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Name</TableHead>
                  <TableHead scope="col">Owner</TableHead>
                  <TableHead scope="col">Base URL</TableHead>
                  <TableHead scope="col">PHI</TableHead>
                  <TableHead scope="col">Allowlist</TableHead>
                  <TableHead scope="col">Auth</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col" className="text-right">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((server) => {
                  const writable = canWrite(server);
                  const isPlatformRow = server.tenantId === SYSTEM_TENANT_ID;
                  // A disabled control states WHY (rule 11 §5); the reason also
                  // becomes the accessible name so it is not colour/state-only.
                  const lockedReason = 'Platform connector — managed by super administrators';
                  return (
                    <TableRow key={server.id}>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium">{server.name}</span>
                          {server.description ? <span className="text-muted-foreground line-clamp-1 text-xs">{server.description}</span> : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={isPlatformRow ? 'outline' : 'secondary'} className="text-xs">
                          {isPlatformRow ? 'Platform' : 'This tenant'}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate font-mono text-xs">{server.baseUrl}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-xs">
                          {server.phiBoundary}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <AllowlistCell allowlist={server.toolAllowlist} />
                      </TableCell>
                      <TableCell>
                        <AuthPresence authRef={server.authRef} />
                      </TableCell>
                      <TableCell>
                        <Badge variant={server.enabled ? 'secondary' : 'outline'} className="text-xs">
                          {server.enabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="inline-flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={!writable}
                            aria-label={writable ? `Edit ${server.name}` : `Edit ${server.name} — unavailable: ${lockedReason}`}
                            onClick={() => openEdit(server)}
                          >
                            <IconPencil aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={!writable}
                            aria-label={writable ? `Delete ${server.name}` : `Delete ${server.name} — unavailable: ${lockedReason}`}
                            onClick={() => setDeleteTarget(server)}
                          >
                            <IconTrash aria-hidden />
                          </Button>
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </ScreenTemplate>

      <McpServerFormDialog open={sheetOpen} onOpenChange={setSheetOpen} editingId={editingId} isElevated={isElevated} />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        title="Delete MCP server?"
        description={
          deleteTarget ? (
            <>
              Soft-delete <span className="font-medium">{deleteTarget.name}</span> from the registry. Running workflows that already resolved this
              server keep their snapshot.
            </>
          ) : null
        }
        confirmLabel="Delete server"
        destructive
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </>
  );
}
