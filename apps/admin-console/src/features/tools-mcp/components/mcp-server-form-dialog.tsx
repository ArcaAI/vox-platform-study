'use client';

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useCreateMcpServer, useMcpServer, useUpdateMcpServer } from '../api';
import type { CreateMcpServerRequest, McpPhiBoundary, McpServer, UpdateMcpServerRequest } from '../api';

interface FormValues {
    name: string;
    description: string;
    baseUrl: string;
    authRef: string;
    toolAllowlist: string;
    phiBoundary: McpPhiBoundary;
    enabled: boolean;
}

const EMPTY: FormValues = {
    name: '',
    description: '',
    baseUrl: '',
    authRef: '',
    toolAllowlist: '',
    phiBoundary: 'external',
    enabled: false,
};

function toValues(server?: McpServer): FormValues {
    if (!server) return EMPTY;
    return {
        name: server.name,
        description: server.description ?? '',
        baseUrl: server.baseUrl,
        authRef: '',
        toolAllowlist: (server.toolAllowlist ?? []).join(', '),
        phiBoundary: server.phiBoundary === 'in-boundary' ? 'in-boundary' : 'external',
        enabled: server.enabled,
    };
}

function parseAllowlist(raw: string): string[] | undefined {
    const items = raw
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
    return items.length ? items : undefined;
}

function toCreateBody(values: FormValues): CreateMcpServerRequest {
    return {
        name: values.name.trim(),
        baseUrl: values.baseUrl.trim(),
        transport: 'streamable-http',
        phiBoundary: values.phiBoundary,
        enabled: values.enabled,
        ...(values.description.trim() ? { description: values.description.trim() } : {}),
        ...(values.authRef.trim() ? { authRef: values.authRef.trim() } : {}),
        ...(parseAllowlist(values.toolAllowlist) ? { toolAllowlist: parseAllowlist(values.toolAllowlist) } : {}),
    };
}

function toUpdateBody(values: FormValues): UpdateMcpServerRequest {
    const body: UpdateMcpServerRequest = {
        name: values.name.trim(),
        baseUrl: values.baseUrl.trim(),
        phiBoundary: values.phiBoundary,
        enabled: values.enabled,
        description: values.description.trim() || undefined,
        toolAllowlist: parseAllowlist(values.toolAllowlist) ?? [],
    };
    // Leave blank on edit = do not rotate the Vault path.
    if (values.authRef.trim()) body.authRef = values.authRef.trim();
    return body;
}

/**
 * Form body remounts via `key` when the loaded server changes — field state
 * initializes once from props (no setState-in-effect).
 */
function McpServerForm({
    initial,
    etag,
    authConfigured,
    onDone,
    onCancel,
    onReloadLatest,
}: {
    initial?: McpServer;
    etag?: string;
    authConfigured: boolean;
    onDone: () => void;
    onCancel: () => void;
    onReloadLatest?: () => void;
}) {
    const uid = useId();
    const isEdit = Boolean(initial);
    const createMutation = useCreateMcpServer();
    const updateMutation = useUpdateMcpServer();
    const [values, setValues] = useState<FormValues>(() => toValues(initial));
    const pending = createMutation.isPending || updateMutation.isPending;
    const mutationError = isEdit ? updateMutation.error : createMutation.error;

    function setField<K extends keyof FormValues>(key: K, value: FormValues[K]) {
        setValues((prev) => ({ ...prev, [key]: value }));
    }

    function handleSubmit(event: FormEvent) {
        event.preventDefault();
        if (!values.name.trim() || !values.baseUrl.trim()) {
            toast.error('Name and base URL are required');
            return;
        }

        if (isEdit && initial) {
            if (!etag) {
                toast.error('Missing ETag — reload and try again');
                return;
            }
            updateMutation.mutate(
                { id: initial.id, patch: toUpdateBody(values), etag },
                {
                    onSuccess: () => {
                        toast.success('Server updated');
                        onDone();
                    },
                    onError: (error) => {
                        if (error instanceof GatewayError && error.status === 412) return;
                        toast.error(error.message);
                    },
                },
            );
            return;
        }

        createMutation.mutate(toCreateBody(values), {
            onSuccess: () => {
                toast.success('Server registered');
                onDone();
            },
            onError: (error) => toast.error(error.message),
        });
    }

    return (
        <form id={`${uid}-form`} onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
            {isEdit && onReloadLatest ? <OccConflictAlert error={mutationError} onReload={onReloadLatest} /> : null}

            <div className="flex flex-col gap-2">
                <Label htmlFor={`${uid}-name`}>
                    Name <span className="text-destructive">*</span>
                </Label>
                <Input
                    id={`${uid}-name`}
                    value={values.name}
                    onChange={(event) => setField('name', event.target.value)}
                    required
                    autoComplete="off"
                />
            </div>

            <div className="flex flex-col gap-2">
                <Label htmlFor={`${uid}-baseUrl`}>
                    Base URL <span className="text-destructive">*</span>
                </Label>
                <Input
                    id={`${uid}-baseUrl`}
                    value={values.baseUrl}
                    onChange={(event) => setField('baseUrl', event.target.value)}
                    required
                    placeholder="https://terminology.internal/mcp"
                    autoComplete="off"
                    className="font-mono text-sm"
                />
            </div>

            <div className="flex flex-col gap-2">
                <Label htmlFor={`${uid}-description`}>Description</Label>
                <Textarea
                    id={`${uid}-description`}
                    value={values.description}
                    onChange={(event) => setField('description', event.target.value)}
                    className="min-h-16 resize-none"
                />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                    <Label htmlFor={`${uid}-phi`}>PHI boundary</Label>
                    <Select value={values.phiBoundary} onValueChange={(next) => setField('phiBoundary', next as McpPhiBoundary)}>
                        <SelectTrigger id={`${uid}-phi`} className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="external">external</SelectItem>
                            <SelectItem value="in-boundary">in-boundary</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                    <Label htmlFor={`${uid}-enabled`}>Enabled</Label>
                    <Switch id={`${uid}-enabled`} checked={values.enabled} onCheckedChange={(next) => setField('enabled', next)} />
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <Label htmlFor={`${uid}-allowlist`}>Tool allowlist</Label>
                <Textarea
                    id={`${uid}-allowlist`}
                    value={values.toolAllowlist}
                    onChange={(event) => setField('toolAllowlist', event.target.value)}
                    placeholder="tool-id-a, tool-id-b"
                    className="min-h-16 resize-none font-mono text-sm"
                />
                <p className="text-muted-foreground text-xs">Comma or newline separated tool ids. Empty = no server-side restriction.</p>
            </div>

            <div className="flex flex-col gap-2">
                <Label htmlFor={`${uid}-authRef`}>Vault auth path</Label>
                {isEdit && authConfigured ? (
                    <p className="text-muted-foreground text-xs">
                        Auth <span className="font-medium text-foreground">Configured</span> — enter a new Vault path below to rotate; leave blank to
                        keep.
                    </p>
                ) : null}
                <Input
                    id={`${uid}-authRef`}
                    value={values.authRef}
                    onChange={(event) => setField('authRef', event.target.value)}
                    placeholder="secret/data/mcp/…"
                    autoComplete="off"
                    className="font-mono text-sm"
                />
                <p className="text-muted-foreground text-xs">Vault path only — never paste credentials.</p>
            </div>

            <DialogFooter className="mt-auto">
                <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
                    Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                    {pending ? <Spinner /> : null}
                    {isEdit ? 'Save changes' : 'Register server'}
                </Button>
            </DialogFooter>
        </form>
    );
}

/**
 * Create / edit dialog for an MCP registry row. Edit path loads GET :id (ETag)
 * and PATCHes with If-Match. authRef is a Vault path — on edit the form shows
 * presence only and treats a blank path field as "leave unchanged".
 */
export function McpServerFormDialog({
    open,
    onOpenChange,
    editingId,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    editingId: string | null;
}) {
    const isEdit = Boolean(editingId);
    const detailQuery = useMcpServer(editingId, open && isEdit);
    const server = detailQuery.data?.data;

    function close() {
        onOpenChange(false);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex h-[70vh] flex-col sm:max-w-[50vw]">
                <DialogHeader>
                    <DialogTitle>{isEdit ? 'Edit MCP server' : 'Register MCP server'}</DialogTitle>
                    <DialogDescription>
                        {isEdit
                            ? 'Sparse patch under If-Match OCC. Vault path left blank stays unchanged.'
                            : 'Registers a SYSTEM-registry row (dormant unless enabled). authRef is a Vault path only.'}
                    </DialogDescription>
                </DialogHeader>

                {!isEdit ? (
                    <McpServerForm onDone={close} onCancel={close} authConfigured={false} />
                ) : detailQuery.isPending ? (
                    <div className="flex min-h-0 flex-1 flex-col gap-3" aria-hidden>
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-20 w-full" />
                    </div>
                ) : detailQuery.error || !server ? (
                    <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
                ) : (
                    <McpServerForm
                        key={server.id}
                        initial={server}
                        etag={detailQuery.data?.etag ?? undefined}
                        authConfigured={Boolean(server.authRef)}
                        onDone={close}
                        onCancel={close}
                        onReloadLatest={() => void detailQuery.refetch()}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
