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
import { useCreateTenant } from '../api/hooks';
import type { CreateTenantRequest, TenantPlan } from '../api/types';
import { PLAN_LABELS } from './plan-badge';

const PLAN_CHOICES: Array<{ value: TenantPlan | ''; label: string; hint: string }> = [
    { value: '', label: 'No plan', hint: 'Assign a commercial plan later' },
    { value: 'TRIAL', label: PLAN_LABELS.TRIAL, hint: 'Time-boxed evaluation' },
    { value: 'STARTER', label: PLAN_LABELS.STARTER, hint: 'Small practices' },
    { value: 'PRO', label: PLAN_LABELS.PRO, hint: 'Multi-department organizations' },
    { value: 'ENTERPRISE', label: PLAN_LABELS.ENTERPRISE, hint: 'Full platform capabilities' },
];

/**
 * Create-tenant wizard (frame 12 primary action): step 1 collects the
 * identity details, step 2 picks the plan and confirms the summary before the
 * POST. Navigates to the new tenant on success.
 */
export function CreateTenantDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const router = useRouter();
    const createTenant = useCreateTenant();
    const [step, setStep] = useState<1 | 2>(1);
    const [name, setName] = useState('');
    const [tenantKey, setTenantKey] = useState('');
    const [description, setDescription] = useState('');
    const [plan, setPlan] = useState<TenantPlan | ''>('');

    const detailsValid = name.trim().length > 0 && tenantKey.trim().length > 0;

    function handleOpenChange(next: boolean) {
        if (!next) {
            setStep(1);
            setName('');
            setTenantKey('');
            setDescription('');
            setPlan('');
            createTenant.reset();
        }
        onOpenChange(next);
    }

    function handleDetailsSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (detailsValid) setStep(2);
    }

    function handleCreate() {
        const body: CreateTenantRequest = {
            name: name.trim(),
            key: tenantKey.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(plan ? { plan } : {}),
        };
        createTenant.mutate(body, {
            onSuccess: (created) => {
                toast.success('Tenant created');
                handleOpenChange(false);
                if (created?.id) router.push(`/tenants/${created.id}`);
            },
            onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the tenant.'),
        });
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>New tenant</DialogTitle>
                    <DialogDescription>{step === 1 ? 'Step 1 of 2 \u2014 details' : 'Step 2 of 2 \u2014 plan & confirm'}</DialogDescription>
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
                            <Label htmlFor="create-tenant-key">
                                Key <span aria-hidden className="text-destructive">*</span>
                            </Label>
                            <Input
                                id="create-tenant-key"
                                value={tenantKey}
                                onChange={(event) => setTenantKey(event.target.value)}
                                placeholder="sunrise-medical"
                                autoComplete="off"
                                className="font-mono"
                                required
                            />
                            <p className="text-muted-foreground text-xs">Short unique code used in URLs and API calls.</p>
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
                ) : (
                    <div className="flex flex-col gap-4">
                        <fieldset className="flex flex-col gap-2">
                            <legend className="mb-2 text-sm font-medium">Plan</legend>
                            {PLAN_CHOICES.map((choice) => (
                                <label
                                    key={choice.value || 'none'}
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
                        <dl className="bg-muted/50 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
                            <dt className="text-muted-foreground">Name</dt>
                            <dd className="font-medium">{name.trim()}</dd>
                            <dt className="text-muted-foreground">Key</dt>
                            <dd className="font-mono text-xs leading-5">{tenantKey.trim()}</dd>
                            {description.trim() ? (
                                <>
                                    <dt className="text-muted-foreground">Description</dt>
                                    <dd className="truncate">{description.trim()}</dd>
                                </>
                            ) : null}
                        </dl>
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setStep(1)} disabled={createTenant.isPending}>
                                Back
                            </Button>
                            <Button type="button" onClick={handleCreate} disabled={createTenant.isPending}>
                                {createTenant.isPending ? <Spinner /> : null}
                                Create tenant
                            </Button>
                        </DialogFooter>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
