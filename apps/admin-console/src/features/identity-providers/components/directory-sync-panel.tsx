'use client';

import { useState } from 'react';
import { IconRefresh } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
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
import { GatewayError } from '@/shared/api';
import { useSetDirectoryCredentials, useSyncDirectory, useUpdateIdentityProvider } from '../api/hooks';
import type { DirectoryProviderKey, GoogleDirectoryCredentials, MsGraphDirectoryCredentials, TenantIdpConfig } from '../api/types';

const PROVIDER_OPTIONS: { value: DirectoryProviderKey; label: string }[] = [
    { value: 'ms-graph', label: 'Microsoft Graph (Entra ID)' },
    { value: 'google-directory', label: 'Google Workspace Directory' },
];

/** Directory-provider selector — a full `config` PUT (persists alongside the other OIDC config fields). */
function DirectoryProviderSelect({
    provider,
    etag,
    onSaved,
}: {
    provider: TenantIdpConfig;
    etag: string | null;
    onSaved: () => void;
}) {
    const updateProvider = useUpdateIdentityProvider();
    const [directoryProvider, setDirectoryProvider] = useState<DirectoryProviderKey | 'none'>(provider.config.directoryProvider ?? 'none');

    function handleSave() {
        if (!etag) return;
        updateProvider.mutate(
            {
                id: provider.id,
                patch: {
                    config: { ...provider.config, directoryProvider: directoryProvider === 'none' ? undefined : directoryProvider },
                },
                etag,
            },
            {
                onSuccess: () => {
                    toast.success('Directory provider saved');
                    onSaved();
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not save the directory provider.'),
            },
        );
    }

    const dirty = directoryProvider !== (provider.config.directoryProvider ?? 'none');

    return (
        <div className="flex flex-col gap-2">
            <Label htmlFor="idp-directory-provider">Directory API</Label>
            <div className="flex gap-2">
                <Select value={directoryProvider} onValueChange={(next) => setDirectoryProvider(next as DirectoryProviderKey | 'none')}>
                    <SelectTrigger id="idp-directory-provider" className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="none">Off — no directory pull</SelectItem>
                        {PROVIDER_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {dirty ? (
                    <Button type="button" size="sm" disabled={!etag || updateProvider.isPending} onClick={handleSave}>
                        {updateProvider.isPending ? <Spinner /> : null}
                        Save
                    </Button>
                ) : null}
            </div>
        </div>
    );
}

function MsGraphCredentialsForm({ providerId }: { providerId: string }) {
    const setCredentials = useSetDirectoryCredentials();
    const [azureTenantId, setAzureTenantId] = useState('');
    const [clientId, setClientId] = useState('');
    const [clientSecret, setClientSecret] = useState('');

    function handleSave() {
        const credentials: MsGraphDirectoryCredentials = { azureTenantId: azureTenantId.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() };
        setCredentials.mutate(
            { id: providerId, credentials },
            {
                onSuccess: () => {
                    toast.success('Microsoft Graph credentials saved');
                    setAzureTenantId('');
                    setClientId('');
                    setClientSecret('');
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not save the credentials.'),
            },
        );
    }

    const canSave = azureTenantId.trim() && clientId.trim() && clientSecret.trim();

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
                <Label htmlFor="msgraph-azure-tenant-id">Azure AD tenant ID</Label>
                <Input id="msgraph-azure-tenant-id" value={azureTenantId} onChange={(event) => setAzureTenantId(event.target.value)} autoComplete="off" className="font-mono text-xs" />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="msgraph-client-id">App registration client ID</Label>
                <Input id="msgraph-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" className="font-mono text-xs" />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="msgraph-client-secret">Client secret</Label>
                <Input
                    id="msgraph-client-secret"
                    type="password"
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                    placeholder="•••••••• (write-only — never shown)"
                    autoComplete="off"
                    className="font-mono text-xs"
                />
            </div>
            <p className="text-muted-foreground text-xs">
                Requires an Azure AD app registration with the application permissions <span className="font-mono">User.Read.All</span> and{' '}
                <span className="font-mono">GroupMember.Read.All</span>, admin-consented.
            </p>
            <Button type="button" variant="outline" size="sm" className="self-start" disabled={!canSave || setCredentials.isPending} onClick={handleSave}>
                {setCredentials.isPending ? <Spinner /> : null}
                Save credentials
            </Button>
        </div>
    );
}

function GoogleDirectoryCredentialsForm({ providerId }: { providerId: string }) {
    const setCredentials = useSetDirectoryCredentials();
    const [serviceAccountEmail, setServiceAccountEmail] = useState('');
    const [privateKey, setPrivateKey] = useState('');
    const [delegatedAdminEmail, setDelegatedAdminEmail] = useState('');
    const [customerId, setCustomerId] = useState('');

    function handleSave() {
        const credentials: GoogleDirectoryCredentials = {
            serviceAccountEmail: serviceAccountEmail.trim(),
            privateKey: privateKey.trim(),
            delegatedAdminEmail: delegatedAdminEmail.trim(),
            ...(customerId.trim() ? { customerId: customerId.trim() } : {}),
        };
        setCredentials.mutate(
            { id: providerId, credentials },
            {
                onSuccess: () => {
                    toast.success('Google Directory credentials saved');
                    setServiceAccountEmail('');
                    setPrivateKey('');
                    setDelegatedAdminEmail('');
                    setCustomerId('');
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not save the credentials.'),
            },
        );
    }

    const canSave = serviceAccountEmail.trim() && privateKey.trim() && delegatedAdminEmail.trim();

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
                <Label htmlFor="google-service-account-email">Service account email</Label>
                <Input
                    id="google-service-account-email"
                    value={serviceAccountEmail}
                    onChange={(event) => setServiceAccountEmail(event.target.value)}
                    autoComplete="off"
                    className="font-mono text-xs"
                />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="google-private-key">Private key (PEM)</Label>
                <textarea
                    id="google-private-key"
                    value={privateKey}
                    onChange={(event) => setPrivateKey(event.target.value)}
                    placeholder="-----BEGIN PRIVATE KEY-----"
                    className="border-input min-h-24 resize-none rounded-md border bg-transparent px-3 py-2 font-mono text-xs shadow-xs"
                />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="google-delegated-admin-email">Delegated admin email</Label>
                <Input
                    id="google-delegated-admin-email"
                    value={delegatedAdminEmail}
                    onChange={(event) => setDelegatedAdminEmail(event.target.value)}
                    autoComplete="off"
                    className="font-mono text-xs"
                />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="google-customer-id">Customer ID (optional — defaults to my_customer)</Label>
                <Input id="google-customer-id" value={customerId} onChange={(event) => setCustomerId(event.target.value)} autoComplete="off" className="font-mono text-xs" />
            </div>
            <p className="text-muted-foreground text-xs">
                Requires a domain-wide-delegated service account with the read-only{' '}
                <span className="font-mono">admin.directory.user</span> and <span className="font-mono">admin.directory.group</span> scopes.
            </p>
            <Button type="button" variant="outline" size="sm" className="self-start" disabled={!canSave || setCredentials.isPending} onClick={handleSave}>
                {setCredentials.isPending ? <Spinner /> : null}
                Save credentials
            </Button>
        </div>
    );
}

/**
 * Directory sync tab: pick the directory API, seal its
 * credentials, and trigger an admin bulk pull. No live progress bar — the
 * gateway's job-status endpoint is platform-admin-only today (documented
 * gap), so this shows a single "sync started" toast instead.
 */
export function DirectorySyncPanel({ provider, etag, onSaved }: { provider: TenantIdpConfig; etag: string | null; onSaved: () => void }) {
    const syncDirectory = useSyncDirectory();
    const directoryProvider = provider.config.directoryProvider;

    function handleSync() {
        syncDirectory.mutate(provider.id, {
            onSuccess: (result) => toast.success(`Directory sync started (job ${result.jobId})`),
            onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not start the directory sync.'),
        });
    }

    return (
        <Card className="gap-4 py-4">
            <CardHeader className="px-4">
                <h2 className="flex flex-wrap items-baseline gap-x-2 text-sm leading-none font-semibold">
                    Directory sync
                    <span aria-hidden className="text-muted-foreground font-mono text-xs font-normal">
                        POST :id/sync
                    </span>
                </h2>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 px-4">
                <DirectoryProviderSelect
                    provider={provider}
                    etag={etag}
                    key={`${provider.id}-${provider.config.directoryProvider ?? 'none'}`}
                    onSaved={onSaved}
                />

                {directoryProvider ? (
                    <>
                        <Separator />
                        <div className="flex items-center gap-2">
                            <h3 className="text-sm font-medium">Directory-API credentials</h3>
                            <Badge variant={provider.hasDirectoryCredentials ? 'secondary' : 'outline'}>
                                {provider.hasDirectoryCredentials ? 'configured' : 'not configured'}
                            </Badge>
                        </div>
                        {directoryProvider === 'ms-graph' ? (
                            <MsGraphCredentialsForm providerId={provider.id} />
                        ) : (
                            <GoogleDirectoryCredentialsForm providerId={provider.id} />
                        )}
                        <Separator />
                        <div className="flex flex-col gap-2">
                            <h3 className="text-sm font-medium">Bulk pull</h3>
                            <p className="text-muted-foreground text-xs">
                                Admin-triggered, async, idempotent — safe to re-run. Pre-provisions HOPE users from the directory using the same
                                default-role/department and group→role mapping as JIT login.
                            </p>
                            <Button
                                type="button"
                                size="sm"
                                className="self-start"
                                disabled={!provider.hasDirectoryCredentials || syncDirectory.isPending}
                                onClick={handleSync}
                            >
                                {syncDirectory.isPending ? <Spinner /> : <IconRefresh aria-hidden />}
                                Sync now
                            </Button>
                        </div>
                    </>
                ) : (
                    <p className="text-muted-foreground text-xs">Pick a directory API above to enable admin-triggered bulk pre-provisioning.</p>
                )}
            </CardContent>
        </Card>
    );
}
