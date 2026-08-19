'use client';

import { useState } from 'react';
import { IconPencil, IconPlugConnected, IconPlus, IconShieldLock, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { useSession } from '@/shared/auth';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { etagFromVersion, useDeleteMcpServer, useMcpServers } from '../api';
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
    <Badge variant="secondary" className="text-2xs">
      Configured
    </Badge>
  ) : (
    <Badge variant="outline" className="text-2xs">
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
        <Badge key={tool} variant="outline" className="font-mono text-2xs">
          {tool}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Tools & MCP (/tools-mcp, tier 10-19, SUPER_ADMIN). Writable SYSTEM MCP
 * registry backed `admin/mcp-servers` (list/create + If-Match
 * PATCH/DELETE). authRef shows masked presence only in the table.
 */
export function ToolsMcpScreen() {
  const session = useSession();
  const isElevated = session.data?.isElevated ?? false;

  if (session.isPending) {
    return (
      <ScreenTemplate header={<PageHeader title="Tools & MCP" />}>
        <LoadingTable />
      </ScreenTemplate>
    );
  }

  if (!isElevated) {
    return (
      <ScreenTemplate header={<PageHeader title="Tools & MCP" />}>
        <EmptyState
          icon={IconShieldLock}
          title="Super Admins only"
          description="The MCP external-tools registry is managed by super administrators. Tenant admins cannot register or mutate servers."
        />
      </ScreenTemplate>
    );
  }

  return <ToolsMcpBody />;
}

function ToolsMcpBody() {
  const query = useMcpServers(true);
  const deleteMutation = useDeleteMcpServer();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? items.length;

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
            meta={<span>SYSTEM MCP registry · streamable-HTTP</span>}
            actions={
              <Button onClick={openCreate}>
                <IconPlus aria-hidden data-icon="inline-start" />
                Register server
              </Button>
            }
          />
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
          <ErrorState title={'Couldn\u2019t load the MCP registry'} error={query.error} onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={IconPlugConnected}
            title="No MCP servers registered yet"
            description="Register an external MCP server to expose allowlisted tools to the agentic harness. Servers stay dormant until enabled (and HarnessPolicy.mcpToolsEnabled is on)."
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
                  <TableHead scope="col">Base URL</TableHead>
                  <TableHead scope="col">PHI</TableHead>
                  <TableHead scope="col">Allowlist</TableHead>
                  <TableHead scope="col">Auth</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col" className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((server) => (
                  <TableRow key={server.id}>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium">{server.name}</span>
                        {server.description ? <span className="text-muted-foreground line-clamp-1 text-xs">{server.description}</span> : null}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-xs">{server.baseUrl}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-2xs">
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
                      <Badge variant={server.enabled ? 'secondary' : 'outline'} className="text-2xs">
                        {server.enabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${server.name}`} onClick={() => openEdit(server)}>
                          <IconPencil aria-hidden />
                        </Button>
                        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${server.name}`} onClick={() => setDeleteTarget(server)}>
                          <IconTrash aria-hidden />
                        </Button>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </ScreenTemplate>

      <McpServerFormDialog open={sheetOpen} onOpenChange={setSheetOpen} editingId={editingId} />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        title="Delete MCP server?"
        description={
          deleteTarget ? (
            <>
              Soft-delete <span className="font-medium">{deleteTarget.name}</span> from the SYSTEM registry. Running workflows that already resolved
              this server keep their snapshot.
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
