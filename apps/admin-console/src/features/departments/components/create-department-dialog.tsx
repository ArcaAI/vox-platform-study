'use client';

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { useCreateDepartment } from '../api/hooks';
import type { Department } from '../api/types';

/** Radix Select reserves '', so "no parent" maps through a sentinel. */
const ROOT_SENTINEL = '__root__';

/**
 * Frame 30 "+ New department" dialog. Parent options come from the already-
 * loaded flat list; created departments land at the root when none is picked.
 */
export function CreateDepartmentDialog({
    open,
    onOpenChange,
    departments,
    onCreated,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    departments: Department[];
    onCreated: (department: Department) => void;
}) {
    const uid = useId();
    const create = useCreateDepartment();
    const [name, setName] = useState('');
    const [code, setCode] = useState('');
    const [description, setDescription] = useState('');
    const [parent, setParent] = useState(ROOT_SENTINEL);

    function handleOpenChange(next: boolean) {
        if (!next) {
            setName('');
            setCode('');
            setDescription('');
            setParent(ROOT_SENTINEL);
            create.reset();
        }
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        create.mutate(
            {
                name: name.trim(),
                ...(code.trim() ? { code: code.trim() } : {}),
                ...(description.trim() ? { description: description.trim() } : {}),
                ...(parent !== ROOT_SENTINEL ? { parentDepartmentId: parent } : {}),
            },
            {
                onSuccess: (created) => {
                    toast.success('Department created');
                    handleOpenChange(false);
                    onCreated(created);
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the department.'),
            },
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>New department</DialogTitle>
                    <DialogDescription>Creates a department in the working tenant. Pick a parent to nest it in the hierarchy.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor={`${uid}-name`}>
                            Name
                            <span aria-hidden className="text-destructive">
                                *
                            </span>
                        </Label>
                        <Input id={`${uid}-name`} value={name} onChange={(event) => setName(event.target.value)} placeholder="Cardiology" required />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor={`${uid}-code`}>Code</Label>
                        <Input
                            id={`${uid}-code`}
                            value={code}
                            onChange={(event) => setCode(event.target.value)}
                            placeholder="CARD"
                            className="font-mono"
                            autoComplete="off"
                        />
                        <p className="text-muted-foreground text-xs">Unique per tenant; used for the code lookup.</p>
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor={`${uid}-description`}>Description</Label>
                        <Textarea
                            id={`${uid}-description`}
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            rows={2}
                            className="resize-none"
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor={`${uid}-parent`}>Parent</Label>
                        <Select value={parent} onValueChange={setParent}>
                            <SelectTrigger id={`${uid}-parent`} className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ROOT_SENTINEL}>{'\u2014'} Root (no parent) {'\u2014'}</SelectItem>
                                {departments.map((department) => (
                                    <SelectItem key={department.id} value={department.id}>
                                        {department.name || department.code || department.id}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={create.isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!name.trim() || create.isPending}>
                            {create.isPending ? <Spinner /> : null}
                            Create department
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
