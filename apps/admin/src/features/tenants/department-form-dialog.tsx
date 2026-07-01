import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Spinner } from '@arcaai/ui/spinner';
import { Textarea } from '@arcaai/ui/textarea';
import { useEffect, useState, type FormEvent } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';
import type { DepartmentDraft } from '@/features/tenants/department-draft';

/**
 * Create-department **dialog** (TASK-379 §5.13). Replaces the nested "Department"
 * blade per the page-based model — `Manage →` opens the detail page, while
 * creating a new department is a focused modal. Maps to
 * `useDepartments().create(toCreateDepartmentRequest(draft))`.
 */
export function DepartmentFormDialog({
    open,
    onOpenChange,
    tenantName,
    isSaving,
    onSave,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    tenantName?: string;
    isSaving: boolean;
    onSave: (draft: DepartmentDraft) => void;
}) {
    const [name, setName] = useState('');
    const [code, setCode] = useState('');
    const [description, setDescription] = useState('');

    useEffect(() => {
        if (!open) return;
        setName('');
        setCode('');
        setDescription('');
    }, [open]);

    const canSave = name.trim().length > 0 && !isSaving;

    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (!canSave) return;
        onSave({ name, code, description });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className={cn('sm:max-w-md', MOBILE_DIALOG_CONTENT)}>
                <form onSubmit={submit}>
                    <DialogHeader>
                        <DialogTitle>New department</DialogTitle>
                        <DialogDescription>{tenantName ? `Add a department to ${tenantName}.` : 'Add a department to this tenant.'}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="dept-name">Name</Label>
                            <Input id="dept-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="dept-code">
                                Code <span className="font-normal text-muted-foreground">(optional)</span>
                            </Label>
                            <Input id="dept-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. CARD" className="font-mono" />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="dept-description">
                                Description <span className="font-normal text-muted-foreground">(optional)</span>
                            </Label>
                            <Textarea id="dept-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
                        </div>
                    </div>
                    <DialogFooter className={MOBILE_DIALOG_FOOTER}>
                        <DialogClose asChild>
                            <Button type="button" variant="outline">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={!canSave}>
                            {isSaving ? <Spinner className="size-4" /> : 'Create department'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
