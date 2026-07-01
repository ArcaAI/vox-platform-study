import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Spinner } from '@arcaai/ui/spinner';
import { Switch } from '@arcaai/ui/switch';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { User } from '@arcaai/vox';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';
import { type ProfileDraft } from '@/features/users/user-draft';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STATUS_OPTIONS = [
    { label: 'Active', value: 'ENABLED' },
    { label: 'Inactive', value: 'DISABLED' },
    { label: 'Archived', value: 'ARCHIVED' },
];

/**
 * Profile-edit dialog (38u header **Edit profile**). Only the fields
 * `UpdateUserInput` REALLY supports are editable — username / email / status /
 * service-account. The TARGET profile fields the design shows (full name,
 * specialty, credentials, preferred name, phone, about) are noted as not yet
 * modeled by the SDK rather than fabricated.
 */
export function UserEditDialog({
    open,
    onOpenChange,
    user,
    isSaving,
    onSave,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    user: User | null;
    isSaving: boolean;
    onSave: (draft: ProfileDraft) => void;
}) {
    const [draft, setDraft] = useState<ProfileDraft>({ username: '', email: '', resourceStatus: 'ENABLED', isServiceAccount: false });
    const [touched, setTouched] = useState(false);

    useEffect(() => {
        if (!open || !user) return;
        setDraft({
            username: user.username ?? '',
            email: user.email ?? '',
            resourceStatus: String(user.resourceStatus ?? 'ENABLED').toUpperCase(),
            isServiceAccount: Boolean(user.isServiceAccount),
        });
        setTouched(false);
    }, [open, user]);

    const errors = useMemo(() => {
        const e: { username?: string; email?: string } = {};
        if (!draft.username.trim()) e.username = 'Username is required';
        const email = draft.email.trim();
        if (email && !EMAIL_RE.test(email)) e.email = 'Enter a valid email address';
        else if (!email && !draft.isServiceAccount) e.email = 'Email is required';
        return e;
    }, [draft]);

    const canSave = Object.keys(errors).length === 0 && !isSaving;

    const submit = (e: FormEvent) => {
        e.preventDefault();
        setTouched(true);
        if (!canSave) return;
        onSave(draft);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className={cn('sm:max-w-lg', MOBILE_DIALOG_CONTENT)}>
                <form onSubmit={submit}>
                    <DialogHeader>
                        <DialogTitle>Edit profile</DialogTitle>
                        <DialogDescription>Update this user’s account identity and status.</DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4 py-4">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="eu-username">Username</Label>
                                <Input
                                    id="eu-username"
                                    value={draft.username}
                                    onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
                                    aria-invalid={touched && !!errors.username}
                                    autoFocus
                                />
                                {touched && errors.username ? <span className="text-xs text-destructive">{errors.username}</span> : null}
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="eu-email">Email</Label>
                                <Input
                                    id="eu-email"
                                    type="email"
                                    value={draft.email}
                                    onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                                    aria-invalid={touched && !!errors.email}
                                />
                                {touched && errors.email ? <span className="text-xs text-destructive">{errors.email}</span> : null}
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="eu-status">Status</Label>
                                <Select value={draft.resourceStatus} onValueChange={(v) => setDraft((d) => ({ ...d, resourceStatus: v }))}>
                                    <SelectTrigger id="eu-status">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {STATUS_OPTIONS.map((o) => (
                                            <SelectItem key={o.value} value={o.value}>
                                                {o.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="eu-service">Service account</Label>
                                <div className="flex h-9 items-center gap-2">
                                    <Switch id="eu-service" checked={draft.isServiceAccount} onCheckedChange={(v) => setDraft((d) => ({ ...d, isServiceAccount: v }))} />
                                    <span className="text-sm text-muted-foreground">For programmatic / integration use</span>
                                </div>
                            </div>
                        </div>

                        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">Target ·</span> full name, specialty, credentials, preferred name, phone and bio
                            are not yet part of the user record and can’t be edited here.
                        </p>
                    </div>

                    <DialogFooter className={MOBILE_DIALOG_FOOTER}>
                        <DialogClose asChild>
                            <Button type="button" variant="outline">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={!canSave}>
                            {isSaving ? <Spinner className="size-4" /> : 'Save changes'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
