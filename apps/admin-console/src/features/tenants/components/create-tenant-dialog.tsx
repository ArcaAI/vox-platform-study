'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import type { User } from '@/features/users/api/types';
import { useProvisionTenant } from '../api/hooks';
import type { ProvisionTenantAdmin, ProvisionTenantRequest, TenantPlan } from '../api/types';
import { PLAN_LABELS } from './plan-badge';
import { UserPicker } from './user-picker';

const PLAN_CHOICES: Array<{ value: TenantPlan; label: string; hint: string }> = [
    { value: 'STARTER', label: PLAN_LABELS.STARTER, hint: 'Small practices' },
    { value: 'TRIAL', label: PLAN_LABELS.TRIAL, hint: 'Time-boxed evaluation' },
    { value: 'PRO', label: PLAN_LABELS.PRO, hint: 'Multi-department organizations' },
    { value: 'ENTERPRISE', label: PLAN_LABELS.ENTERPRISE, hint: 'Full platform capabilities' },
];

type AdminMode = 'existing' | 'new-local';
type Step = 1 | 2 | 3;

/**
 * Cosmetic client-side preview only — the server (`generateUniqueTenantKey`) is the authoritative generator (collision suffixing, reserved
 * fallback). This mirrors it loosely just so the user sees what to expect.
 */
function previewTenantKey(name: string): string {
    return name
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/, '');
}

/**
 * Create-tenant-with-admin wizard: step 1 identity, step 2
 * plan, step 3 the tenant's initial TENANT_ADMIN (existing user or a new
 * local account) — mandatory, so a tenant is never created adminless from
 * this dialog. Submits via `POST /admin/tenants/provision`.
 */
export function CreateTenantDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const router = useRouter();
    const provisionTenant = useProvisionTenant();
    const [step, setStep] = useState<Step>(1);
    const [name, setName] = useState('');
    const [tenantKey, setTenantKey] = useState('');
    const [description, setDescription] = useState('');
    const [plan, setPlan] = useState<TenantPlan>('STARTER');
    const [adminMode, setAdminMode] = useState<AdminMode>('existing');
    const [existingUser, setExistingUser] = useState<User | null>(null);
    const [newEmail, setNewEmail] = useState('');
    const [newUsername, setNewUsername] = useState('');
    const [newPassword, setNewPassword] = useState('');

    const detailsValid = name.trim().length > 0;
    const adminValid = adminMode === 'existing' ? existingUser !== null : newEmail.trim().length > 0 && newPassword.length > 0;
    const keyPreview = previewTenantKey(name);

    function reset() {
        setStep(1);
        setName('');
        setTenantKey('');
        setDescription('');
        setPlan('STARTER');
        setAdminMode('existing');
        setExistingUser(null);
        setNewEmail('');
        setNewUsername('');
        setNewPassword('');
        provisionTenant.reset();
    }

    function handleOpenChange(next: boolean) {
        if (!next) reset();
        onOpenChange(next);
    }

    function handleDetailsSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (detailsValid) setStep(2);
    }

    function handleCreate() {
        const admin: ProvisionTenantAdmin =
            adminMode === 'existing'
                ? { mode: 'existing', userId: existingUser?.id ?? '' }
                : {
                      mode: 'new-local',
                      email: newEmail.trim(),
                      ...(newUsername.trim() ? { username: newUsername.trim() } : {}),
                      password: newPassword,
                  };

        const body: ProvisionTenantRequest = {
            tenantName: name.trim(),
            ...(tenantKey.trim() ? { tenantKey: tenantKey.trim() } : {}),
            plan,
            admin,
        };
        provisionTenant.mutate(body, {
            onSuccess: (result) => {
                toast.success('Tenant created');
                handleOpenChange(false);
                if (result?.tenant?.id) router.push(`/tenants/${result.tenant.id}`);
            },
            onError: (error) =>
                toast.error(
                    error instanceof GatewayError
                        ? error.status === 409
                            ? 'That tenant key is already taken — try a different key.'
                            : error.message
                        : 'Could not create the tenant.',
                ),
        });
    }

    const stepLabel = { 1: 'details', 2: 'plan', 3: 'tenant admin' }[step];

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>New tenant</DialogTitle>
                    <DialogDescription>{`Step ${step} of 3 — ${stepLabel}`}</DialogDescription>
                </DialogHeader>
                {step === 1 ? (
                    <form onSubmit={handleDetailsSubmit} className="flex flex-col gap-4">
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="create-tenant-name">
                                Name <span aria-hidden className="text-destructive">*</span>
                            </Label>
                            <Input
                                id="create-tenant-name"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder="Sunrise Medical Group"
                                autoComplete="off"
                                required
                            />
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="create-tenant-key">Key (optional)</Label>
                            <Input
                                id="create-tenant-key"
                                value={tenantKey}
                                onChange={(event) => setTenantKey(event.target.value)}
                                placeholder={keyPreview || 'sunrise-medical'}
                                autoComplete="off"
                                className="font-mono"
                            />
                            <p className="text-muted-foreground text-xs">
                                {tenantKey.trim() ? 'Short unique code used in URLs and API calls.' : keyPreview ? <>Auto-generated: <span className="font-mono">{keyPreview}</span></> : 'Auto-generated from the name when left blank.'}
                            </p>
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="create-tenant-description">Description</Label>
                            <Textarea
                                id="create-tenant-description"
                                value={description}
                                onChange={(event) => setDescription(event.target.value)}
                                placeholder="Optional note about this organization"
                                className="resize-none"
                                rows={3}
                            />
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={!detailsValid}>
                                Next
                            </Button>
                        </DialogFooter>
                    </form>
                ) : null}
                {step === 2 ? (
                    <div className="flex flex-col gap-4">
                        <fieldset className="flex flex-col gap-2">
                            <legend className="mb-2 text-sm font-medium">Plan</legend>
                            {PLAN_CHOICES.map((choice) => (
                                <label
                                    key={choice.value}
                                    className="border-input has-[:checked]:border-primary has-[:checked]:bg-primary/5 flex cursor-pointer items-start gap-3 rounded-md border p-3"
                                >
                                    <input
                                        type="radio"
                                        name="create-tenant-plan"
                                        value={choice.value}
                                        checked={plan === choice.value}
                                        onChange={() => setPlan(choice.value)}
                                        className="accent-primary mt-0.5"
                                    />
                                    <span className="flex flex-col">
                                        <span className="text-sm font-medium">{choice.label}</span>
                                        <span className="text-muted-foreground text-xs">{choice.hint}</span>
                                    </span>
                                </label>
                            ))}
                        </fieldset>
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setStep(1)}>
                                Back
                            </Button>
                            <Button type="button" onClick={() => setStep(3)}>
                                Next
                            </Button>
                        </DialogFooter>
                    </div>
                ) : null}
                {step === 3 ? (
                    <div className="flex flex-col gap-4">
                        <fieldset className="flex flex-col gap-2">
                            <legend className="mb-2 text-sm font-medium">Tenant admin</legend>
                            <label className="border-input has-[:checked]:border-primary has-[:checked]:bg-primary/5 flex cursor-pointer items-center gap-3 rounded-md border p-3">
                                <input
                                    type="radio"
                                    name="create-tenant-admin-mode"
                                    checked={adminMode === 'existing'}
                                    onChange={() => setAdminMode('existing')}
                                    className="accent-primary"
                                />
                                <span className="text-sm font-medium">Use an existing user</span>
                            </label>
                            <label className="border-input has-[:checked]:border-primary has-[:checked]:bg-primary/5 flex cursor-pointer items-center gap-3 rounded-md border p-3">
                                <input
                                    type="radio"
                                    name="create-tenant-admin-mode"
                                    checked={adminMode === 'new-local'}
                                    onChange={() => setAdminMode('new-local')}
                                    className="accent-primary"
                                />
                                <span className="text-sm font-medium">Create a new local user</span>
                            </label>
                        </fieldset>
                        {adminMode === 'existing' ? (
                            <div className="flex flex-col gap-2">
                                <Label htmlFor="create-tenant-admin-user-id">User</Label>
                                <UserPicker id="create-tenant-admin-user-id" value={existingUser} onChange={setExistingUser} />
                            </div>
                        ) : (
                            <>
                                <div className="flex flex-col gap-2">
                                    <Label htmlFor="create-tenant-admin-email">Email</Label>
                                    <Input
                                        id="create-tenant-admin-email"
                                        type="email"
                                        value={newEmail}
                                        onChange={(event) => setNewEmail(event.target.value)}
                                        autoComplete="off"
                                        required
                                    />
                                </div>
                                <div className="flex flex-col gap-2">
                                    <Label htmlFor="create-tenant-admin-username">Username (optional)</Label>
                                    <Input
                                        id="create-tenant-admin-username"
                                        value={newUsername}
                                        onChange={(event) => setNewUsername(event.target.value)}
                                        autoComplete="off"
                                        placeholder="Defaults to the email"
                                    />
                                </div>
                                <div className="flex flex-col gap-2">
                                    <Label htmlFor="create-tenant-admin-password">Password</Label>
                                    <Input
                                        id="create-tenant-admin-password"
                                        type="password"
                                        value={newPassword}
                                        onChange={(event) => setNewPassword(event.target.value)}
                                        autoComplete="new-password"
                                        required
                                    />
                                </div>
                            </>
                        )}
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setStep(2)} disabled={provisionTenant.isPending}>
                                Back
                            </Button>
                            <Button type="button" onClick={handleCreate} disabled={!adminValid || provisionTenant.isPending}>
                                {provisionTenant.isPending ? <Spinner /> : null}
                                Create tenant
                            </Button>
                        </DialogFooter>
                    </div>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}
