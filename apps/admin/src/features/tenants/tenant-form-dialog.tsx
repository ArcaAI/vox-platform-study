import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Spinner } from '@arcaai/ui/spinner';
import { Textarea } from '@arcaai/ui/textarea';
import type { Tenant } from '@arcaai/vox';
import { Check } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';
import { validateTenantKey } from '@/features/tenants/tenant-key';
import { planLabel, TENANT_PLAN_VALUES, type TenantPlan } from '@/features/tenants/tenant-plan';

export interface TenantDraft {
    name: string;
    key: string;
    description: string;
    /** Commercial plan tier; `null` = unspecified ("No plan"). */
    plan: TenantPlan | null;
}

/** Sentinel value for the "No plan" option (shadcn `Select` can't use an empty string). */
const NO_PLAN = '__none__';

/**
 * Create/edit tenant **dialog** (TASK-379, refactored from the TASK-374 Sheet per
 * §5.12 — detail is now a page, so this is a focused modal). The `key` is set at
 * creation and immutable thereafter; a case-insensitive client-side uniqueness
 * check (DEF-ADM-001, `validateTenantKey`) blocks duplicates before the server
 * round-trip (the server remains the source of truth).
 */
export function TenantFormDialog({
    open,
    onOpenChange,
    mode,
    initial,
    existingKeys,
    isSaving,
    onSave,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: 'create' | 'edit';
    initial?: Tenant | null;
    existingKeys: string[];
    isSaving: boolean;
    onSave: (draft: TenantDraft) => void;
}) {
    const [name, setName] = useState('');
    const [key, setKey] = useState('');
    const [description, setDescription] = useState('');
    const [plan, setPlan] = useState<TenantPlan | null>(null);

    useEffect(() => {
        if (!open) return;
        setName(initial?.name ?? '');
        setKey(String(initial?.key ?? ''));
        setDescription(initial?.description ?? '');
        setPlan((initial?.plan as TenantPlan | null | undefined) ?? null);
    }, [open, initial]);

    // Editing never re-checks the key (it is immutable); creation validates uniqueness.
    const keyState = mode === 'create' ? validateTenantKey(key, existingKeys) : { valid: true as const };
    const keyTaken = !keyState.valid && keyState.reason === 'taken';
    const keyAvailable = mode === 'create' && key.trim().length > 0 && keyState.valid;
    const canSave = name.trim().length > 0 && (mode === 'edit' || keyState.valid) && !isSaving;

    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (!canSave) return;
        onSave({ name: name.trim(), key: key.trim().toLowerCase(), description: description.trim(), plan });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className={cn('sm:max-w-md', MOBILE_DIALOG_CONTENT)}>
                <form onSubmit={submit}>
                    <DialogHeader>
                        <DialogTitle>{mode === 'create' ? 'Create tenant' : 'Edit tenant'}</DialogTitle>
                        <DialogDescription>
                            {mode === 'create' ? 'Provision a new tenant organization.' : 'Update this organization’s details.'}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="tenant-name">Name</Label>
                            <Input id="tenant-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="tenant-key">
                                Key {mode === 'edit' ? <span className="font-normal text-muted-foreground">(immutable)</span> : null}
                            </Label>
                            <Input
                                id="tenant-key"
                                value={key}
                                onChange={(e) => setKey(e.target.value)}
                                disabled={mode === 'edit'}
                                placeholder="e.g. acme-health"
                                className="font-mono"
                                aria-invalid={keyTaken}
                            />
                            {keyTaken ? (
                                <p className="text-xs text-destructive">This key is already in use.</p>
                            ) : keyAvailable ? (
                                <p className="flex items-center gap-1 text-xs text-success">
                                    <Check className="size-3.5" /> Available
                                </p>
                            ) : (
                                <p className="text-xs text-muted-foreground">Lowercase · must be unique · used at sign-in.</p>
                            )}
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="tenant-description">Description</Label>
                            <Textarea id="tenant-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="tenant-plan">Plan</Label>
                            <Select value={plan ?? NO_PLAN} onValueChange={(v) => setPlan(v === NO_PLAN ? null : (v as TenantPlan))}>
                                <SelectTrigger id="tenant-plan" aria-label="Plan">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={NO_PLAN}>No plan</SelectItem>
                                    {TENANT_PLAN_VALUES.map((p) => (
                                        <SelectItem key={p} value={p}>
                                            {planLabel(p)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">Commercial tier only — entitlements are not attached to the plan.</p>
                        </div>
                        {/* TARGET (TASK-379): a custom domain is design-only — no backend field yet. Tags are managed on the tenant detail. */}
                        <p className="text-xs text-muted-foreground">A custom domain is not yet backed by the API.</p>
                    </div>
                    <DialogFooter className={MOBILE_DIALOG_FOOTER}>
                        <DialogClose asChild>
                            <Button type="button" variant="outline">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={!canSave}>
                            {isSaving ? <Spinner className="size-4" /> : mode === 'create' ? 'Create tenant' : 'Save changes'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
