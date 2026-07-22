'use client';

import { useState, type FormEvent } from 'react';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@arcaai/ui/components/shadcn/select';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { useCreateIdentityProvider, useDepartments, useRoles, useUpdateIdentityProvider } from '../api/hooks';
import type { OidcProviderConfig, TenantIdpConfig } from '../api/types';
import { TestConnectionSection } from './test-connection-section';

/**
 * F-036: `federated-auth.service.ts` hard-blocks `GLOBAL_ADMIN` at JIT
 * provisioning (`role.name === 'GLOBAL_ADMIN'` -> 403) and `SERVICE_ACCOUNT`
 * users can never sign in interactively — offering either as a default role
 * lets a config save cleanly and fail every subsequent IdP login instead.
 * Keep the backend as the enforcement point; this only removes dead/unsafe
 * choices from the picker.
 */
const DEFAULT_ROLE_EXCLUDED_NAMES = new Set(['GLOBAL_ADMIN', 'SERVICE_ACCOUNT']);

function RequiredMark() {
    return (
        <span aria-hidden className="text-destructive">
            *
        </span>
    );
}

function FormActions({ children }: { children: React.ReactNode }) {
    return <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>;
}

function DefaultRoleDepartmentFields({
    defaultRoleId,
    onRoleChange,
    defaultDepartmentId,
    onDepartmentChange,
}: {
    defaultRoleId: string;
    onRoleChange: (value: string) => void;
    defaultDepartmentId: string;
    onDepartmentChange: (value: string) => void;
}) {
    const rolesQuery = useRoles();
    const departmentsQuery = useDepartments();
    const roles = (rolesQuery.data ?? []).filter((role) => !DEFAULT_ROLE_EXCLUDED_NAMES.has(role.name));
    const departments = departmentsQuery.data ?? [];

    return (
        <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
                <Label htmlFor="idp-default-role">
                    Default role <RequiredMark />
                </Label>
                <Select value={defaultRoleId} onValueChange={onRoleChange}>
                    <SelectTrigger id="idp-default-role" className="w-full">
                        <SelectValue placeholder={rolesQuery.isPending ? 'Loading roles…' : 'Pick a role…'} />
                    </SelectTrigger>
                    <SelectContent>
                        {roles.map((role) => (
                            <SelectItem key={role.id} value={role.id}>
                                {role.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">Assigned to a just-in-time-provisioned user with no group-map match.</p>
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="idp-default-department">
                    Default department <RequiredMark />
                </Label>
                <Select value={defaultDepartmentId} onValueChange={onDepartmentChange}>
                    <SelectTrigger id="idp-default-department" className="w-full">
                        <SelectValue placeholder={departmentsQuery.isPending ? 'Loading departments…' : 'Pick a department…'} />
                    </SelectTrigger>
                    <SelectContent>
                        {departments.map((department) => (
                            <SelectItem key={department.id} value={department.id}>
                                {department.code ?? department.name ?? department.id}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
        </div>
    );
}

/** Inline editor for `groupToRoleMap`: IdP group claim value -> HOPE Role.externalName. */
function GroupRoleMappingEditor({ value, onChange }: { value: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
    const rows = Object.entries(value);

    function updateRow(index: number, group: string, roleExternalName: string) {
        const next = [...rows];
        next[index] = [group, roleExternalName];
        onChange(Object.fromEntries(next.filter(([g]) => g.trim().length > 0)));
    }

    function removeRow(index: number) {
        onChange(Object.fromEntries(rows.filter((_, i) => i !== index)));
    }

    function addRow() {
        onChange({ ...value, '': '' });
    }

    return (
        <div className="flex flex-col gap-2">
            <Label>Group &rarr; role mapping</Label>
            <p className="text-muted-foreground text-xs">
                IdP group claim value &rarr; HOPE <span className="font-mono">Role.externalName</span>. GLOBAL_ADMIN can never be assigned this way.
            </p>
            {rows.length === 0 ? <p className="text-muted-foreground text-xs">No mappings — every JIT user gets the default role above.</p> : null}
            {rows.map(([group, role], index) => (
                <div key={index} className="flex items-center gap-2">
                    <Input
                        aria-label="IdP group claim value"
                        value={group}
                        onChange={(event) => updateRow(index, event.target.value, role)}
                        placeholder="acme-clinicians"
                        className="font-mono text-xs"
                    />
                    <span aria-hidden className="text-muted-foreground">
                        &rarr;
                    </span>
                    <Input
                        aria-label="HOPE role externalName"
                        value={role}
                        onChange={(event) => updateRow(index, group, event.target.value)}
                        placeholder="DOCTOR"
                        className="font-mono text-xs"
                    />
                    <Button type="button" variant="ghost" size="icon" aria-label="Remove mapping" onClick={() => removeRow(index)}>
                        <IconTrash aria-hidden />
                    </Button>
                </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="self-start" onClick={addRow}>
                <IconPlus aria-hidden />
                Add mapping
            </Button>
        </div>
    );
}

/** Create form body — hosted in the console-wide DetailDrawer create mode. POST /admin/tenant-idp-config. */
export function CreateProviderForm({ onCreated, onCancel }: { onCreated: (provider: TenantIdpConfig) => void; onCancel: () => void }) {
    const createProvider = useCreateIdentityProvider();
    const [displayName, setDisplayName] = useState('');
    const [issuer, setIssuer] = useState('');
    const [clientId, setClientId] = useState('');
    const [clientSecret, setClientSecret] = useState('');
    const [defaultRoleId, setDefaultRoleId] = useState('');
    const [defaultDepartmentId, setDefaultDepartmentId] = useState('');

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const config: OidcProviderConfig = { issuer: issuer.trim(), clientId: clientId.trim(), defaultRoleId, defaultDepartmentId };
        createProvider.mutate(
            { protocol: 'OIDC', displayName: displayName.trim(), config, clientSecret: clientSecret.trim() },
            {
                onSuccess: (provider) => {
                    toast.success(`Identity provider "${provider.displayName}" created`);
                    onCreated(provider);
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the identity provider.'),
            },
        );
    }

    const canSubmit = displayName.trim() && issuer.trim() && clientId.trim() && clientSecret.trim() && defaultRoleId && defaultDepartmentId;

    return (
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="flex flex-col gap-2">
                <Label htmlFor="create-idp-name">
                    Display name <RequiredMark />
                </Label>
                <Input
                    id="create-idp-name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="e.g. Acme Okta"
                    autoComplete="off"
                    required
                />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                    <Label htmlFor="create-idp-issuer">
                        Issuer / discovery URL <RequiredMark />
                    </Label>
                    <Input
                        id="create-idp-issuer"
                        value={issuer}
                        onChange={(event) => setIssuer(event.target.value)}
                        placeholder="https://acme.okta.com"
                        autoComplete="off"
                        required
                    />
                </div>
                <div className="flex flex-col gap-2">
                    <Label htmlFor="create-idp-client-id">
                        Client ID <RequiredMark />
                    </Label>
                    <Input
                        id="create-idp-client-id"
                        value={clientId}
                        onChange={(event) => setClientId(event.target.value)}
                        autoComplete="off"
                        required
                    />
                </div>
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="create-idp-client-secret">
                    Client secret <RequiredMark />
                </Label>
                <Input
                    id="create-idp-client-secret"
                    type="password"
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                    placeholder="Sealed with Vault Transit; never shown again"
                    autoComplete="off"
                    required
                />
            </div>
            <DefaultRoleDepartmentFields
                defaultRoleId={defaultRoleId}
                onRoleChange={setDefaultRoleId}
                defaultDepartmentId={defaultDepartmentId}
                onDepartmentChange={setDefaultDepartmentId}
            />
            <p className="text-muted-foreground text-xs">
                Advanced settings (scopes, group&rarr;role mapping, JIT toggle) are available after creation on the Overview tab. The provider starts{' '}
                <span className="font-mono">DRAFT</span> — run &quot;Test connection&quot; to enable it.
            </p>
            <FormActions>
                <Button type="button" variant="outline" onClick={onCancel} disabled={createProvider.isPending}>
                    Cancel
                </Button>
                <Button type="submit" disabled={!canSubmit || createProvider.isPending}>
                    {createProvider.isPending ? <Spinner /> : null}
                    Create provider
                </Button>
            </FormActions>
        </form>
    );
}

/** Edit form body — hosted in the drawer's Overview tab. PUT :id under optimistic concurrency. */
export function EditProviderForm({
    provider,
    etag,
    onSaved,
    onReload,
}: {
    provider: TenantIdpConfig;
    etag: string | null;
    onSaved: () => void;
    onReload: () => void;
}) {
    const updateProvider = useUpdateIdentityProvider();
    const [displayName, setDisplayName] = useState(provider.displayName);
    const [issuer, setIssuer] = useState(provider.config.issuer);
    const [clientId, setClientId] = useState(provider.config.clientId);
    const [clientSecret, setClientSecret] = useState('');
    const [defaultRoleId, setDefaultRoleId] = useState(provider.config.defaultRoleId);
    const [defaultDepartmentId, setDefaultDepartmentId] = useState(provider.config.defaultDepartmentId);
    const [scopes, setScopes] = useState((provider.config.scopes ?? ['openid', 'profile', 'email']).join(', '));
    const [jitEnabled, setJitEnabled] = useState(provider.config.jitEnabled ?? true);
    const [enforceSsoOnly, setEnforceSsoOnly] = useState(provider.config.enforceSsoOnly ?? false);
    const [groupToRoleMap, setGroupToRoleMap] = useState<Record<string, string>>(provider.config.groupToRoleMap ?? {});

    const occError =
        updateProvider.error instanceof GatewayError && (updateProvider.error.isVersionConflict || updateProvider.error.isMissingPrecondition)
            ? updateProvider.error
            : null;

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!etag) return;
        const config: OidcProviderConfig = {
            issuer: issuer.trim(),
            clientId: clientId.trim(),
            scopes: scopes
                .split(',')
                .map((scope) => scope.trim())
                .filter(Boolean),
            defaultRoleId,
            defaultDepartmentId,
            jitEnabled,
            enforceSsoOnly,
            groupToRoleMap: Object.keys(groupToRoleMap).length > 0 ? groupToRoleMap : undefined,
            directoryProvider: provider.config.directoryProvider,
        };
        updateProvider.mutate(
            {
                id: provider.id,
                patch: { displayName: displayName.trim(), config, ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) },
                etag,
            },
            {
                onSuccess: () => {
                    toast.success('Identity provider updated');
                    setClientSecret('');
                    onSaved();
                },
                onError: (error) => {
                    if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
                    toast.error(error instanceof GatewayError ? error.message : 'Could not update the identity provider.');
                },
            },
        );
    }

    return (
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
            <OccConflictAlert
                error={occError}
                onReload={() => {
                    onReload();
                    updateProvider.reset();
                }}
            />
            <div className="flex flex-col gap-2">
                <Label htmlFor="edit-idp-name">
                    Display name <RequiredMark />
                </Label>
                <Input id="edit-idp-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="off" required />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                    <Label htmlFor="edit-idp-issuer">
                        Issuer / discovery URL <RequiredMark />
                    </Label>
                    <Input id="edit-idp-issuer" value={issuer} onChange={(event) => setIssuer(event.target.value)} autoComplete="off" required />
                </div>
                <div className="flex flex-col gap-2">
                    <Label htmlFor="edit-idp-client-id">
                        Client ID <RequiredMark />
                    </Label>
                    <Input id="edit-idp-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" required />
                </div>
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="edit-idp-client-secret">Client secret {provider.hasSecret ? '(enter to rotate)' : ''}</Label>
                <Input
                    id="edit-idp-client-secret"
                    type="password"
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                    placeholder={provider.hasSecret ? '•••••••• (write-only — never shown)' : 'Sealed with Vault Transit'}
                    autoComplete="off"
                />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="edit-idp-scopes">Scopes</Label>
                <Input
                    id="edit-idp-scopes"
                    value={scopes}
                    onChange={(event) => setScopes(event.target.value)}
                    placeholder="openid, profile, email"
                    className="font-mono text-xs"
                />
            </div>
            <DefaultRoleDepartmentFields
                defaultRoleId={defaultRoleId}
                onRoleChange={setDefaultRoleId}
                defaultDepartmentId={defaultDepartmentId}
                onDepartmentChange={setDefaultDepartmentId}
            />
            <div className="flex items-center gap-2">
                <Switch id="edit-idp-jit" checked={jitEnabled} onCheckedChange={setJitEnabled} />
                <Label htmlFor="edit-idp-jit" className="text-muted-foreground text-xs">
                    Just-in-time provisioning — create a HOPE user on first successful IdP login
                </Label>
            </div>
            <div className="flex items-center gap-2">
                <Switch id="edit-idp-enforce-sso" checked={enforceSsoOnly} onCheckedChange={setEnforceSsoOnly} />
                <Label htmlFor="edit-idp-enforce-sso" className="text-muted-foreground text-xs">
                    Require SSO for non-admins (local break-glass login stays for admins)
                </Label>
            </div>
            <Separator />
            <GroupRoleMappingEditor value={groupToRoleMap} onChange={setGroupToRoleMap} />
            <Separator />
            <TestConnectionSection provider={provider} />
            <FormActions>
                <Button type="submit" disabled={!displayName.trim() || !etag || updateProvider.isPending}>
                    {updateProvider.isPending ? <Spinner /> : null}
                    Save changes
                </Button>
            </FormActions>
        </form>
    );
}
