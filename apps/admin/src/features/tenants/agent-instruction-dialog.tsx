import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Spinner } from '@arcaai/ui/spinner';
import { Textarea } from '@arcaai/ui/textarea';
import { Lock } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { AgentInstructionDraft, AgentInstructionService } from '@/features/tenants/agent-instruction-draft';

const SERVICE_OPTIONS: { value: AgentInstructionService; label: string }[] = [
    { value: 'SUMMARIZATION', label: 'SMR — Summarization' },
    { value: 'DNA', label: 'DNA — Analysis' },
    { value: 'GUARDRAIL', label: 'Guardrail — Safety' },
    { value: 'NLP', label: 'NLP — Extraction' },
    { value: 'STT', label: 'STT — Transcription' },
];

/**
 * New agent-instruction **dialog** (TASK-379 §5.13). An "agent instruction" is a
 * department-scoped `PromptTemplate`; the scope is locked to `DEPARTMENT_DEFAULT`
 * (the row is bound to the department). The chosen *service* derives the SDK
 * `category` (see `agent-instruction-draft`). Not the full editor — create only.
 */
export function AgentInstructionDialog({
    open,
    onOpenChange,
    departmentName,
    isSaving,
    onSave,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    departmentName?: string;
    isSaving: boolean;
    onSave: (draft: AgentInstructionDraft) => void;
}) {
    const [name, setName] = useState('');
    const [service, setService] = useState<AgentInstructionService>('SUMMARIZATION');
    const [content, setContent] = useState('');

    useEffect(() => {
        if (!open) return;
        setName('');
        setService('SUMMARIZATION');
        setContent('');
    }, [open]);

    const canSave = name.trim().length > 0 && content.trim().length > 0 && !isSaving;

    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (!canSave) return;
        onSave({ name, service, content });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <form onSubmit={submit}>
                    <DialogHeader>
                        <DialogTitle>New agent instruction</DialogTitle>
                        <DialogDescription>{departmentName ? `${departmentName} · PromptTemplate` : 'PromptTemplate'}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="instruction-name">Name</Label>
                            <Input id="instruction-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="instruction-service">Service</Label>
                                <Select value={service} onValueChange={(v) => setService(v as AgentInstructionService)}>
                                    <SelectTrigger id="instruction-service">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {SERVICE_OPTIONS.map((o) => (
                                            <SelectItem key={o.value} value={o.value}>
                                                {o.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="instruction-scope">Scope</Label>
                                <div
                                    id="instruction-scope"
                                    className="flex h-9 items-center justify-between rounded-md border border-input bg-muted/50 px-3 text-sm text-muted-foreground"
                                >
                                    <span className="font-mono text-xs">DEPARTMENT_DEFAULT</span>
                                    <Lock className="size-3.5" />
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="instruction-content">Prompt</Label>
                            <Textarea
                                id="instruction-content"
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                rows={7}
                                required
                                placeholder="You are a clinical documentation assistant for this department…"
                            />
                        </div>
                    </div>
                    <DialogFooter className="sm:items-center sm:justify-between">
                        <span className="text-xs text-muted-foreground">
                            {departmentName ? `Applies to all ${departmentName} sessions` : 'Applies to all department sessions'}
                        </span>
                        <div className="flex gap-2">
                            <DialogClose asChild>
                                <Button type="button" variant="outline">
                                    Cancel
                                </Button>
                            </DialogClose>
                            <Button type="submit" disabled={!canSave}>
                                {isSaving ? <Spinner className="size-4" /> : 'Create instruction'}
                            </Button>
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
