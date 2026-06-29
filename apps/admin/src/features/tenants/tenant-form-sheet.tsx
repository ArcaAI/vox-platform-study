import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@arcaai/ui/sheet';
import { Spinner } from '@arcaai/ui/spinner';
import { Textarea } from '@arcaai/ui/textarea';
import type { Tenant } from '@arcaai/vox';
import { useEffect, useState, type FormEvent } from 'react';

export interface TenantDraft {
    name: string;
    key: string;
    description: string;
}

/**
 * Create/edit tenant drawer (TASK-374). `key` is set at creation and immutable
 * thereafter; a client-side uniqueness check (DEF-ADM-001) blocks duplicates
 * before the server round-trip (the server remains the source of truth).
 */
export function TenantFormSheet({
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

    useEffect(() => {
        if (!open) return;
        setName(initial?.name ?? '');
        setKey(String(initial?.key ?? ''));
        setDescription(initial?.description ?? '');
    }, [open, initial]);

    const trimmedKey = key.trim().toLowerCase();
    const keyTaken = mode === 'create' && trimmedKey.length > 0 && existingKeys.includes(trimmedKey);
    const canSave = name.trim().length > 0 && (mode === 'edit' || (trimmedKey.length > 0 && !keyTaken)) && !isSaving;

    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (!canSave) return;
        onSave({ name: name.trim(), key: trimmedKey, description: description.trim() });
    };

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
                <SheetHeader>
                    <SheetTitle>{mode === 'create' ? 'New tenant' : 'Edit tenant'}</SheetTitle>
                    <SheetDescription>
                        {mode === 'create' ? 'Create an organization on the HOPE platform.' : 'Update this organization’s details.'}
                    </SheetDescription>
                </SheetHeader>

                <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
                    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-2">
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
                                aria-invalid={keyTaken}
                            />
                            {keyTaken ? (
                                <p className="text-xs text-destructive">This key is already in use.</p>
                            ) : (
                                <p className="text-xs text-muted-foreground">Lowercase identifier used at sign-in.</p>
                            )}
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="tenant-description">Description</Label>
                            <Textarea id="tenant-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
                        </div>
                    </div>

                    <SheetFooter>
                        <Button type="submit" disabled={!canSave}>
                            {isSaving ? <Spinner className="size-4" /> : mode === 'create' ? 'Create tenant' : 'Save changes'}
                        </Button>
                        <SheetClose asChild>
                            <Button type="button" variant="outline">
                                Cancel
                            </Button>
                        </SheetClose>
                    </SheetFooter>
                </form>
            </SheetContent>
        </Sheet>
    );
}
