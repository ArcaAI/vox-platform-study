'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import type { AssembledGenerationType, AssembledVisitType, SmrProvider } from '../api/types';

/** All request knobs except the provider/model pair (which cascades separately). */
export interface LlmFormState {
    prompt: string;
    systemPrompt: string;
    temperature: number;
    /** Raw input text; parsed + clamped at submit time. */
    maxTokens: string;
    streaming: boolean;
    assembled: boolean;
    assembledType: AssembledGenerationType;
    visitType: AssembledVisitType;
    message: string;
    /** Comma-separated IDs; mutually exclusive with message. */
    contextItemIds: string;
    templateId: string;
    dnaStyleId: string;
    debug: boolean;
}

interface PromptEditorCardProps {
    form: LlmFormState;
    onPatch: (partial: Partial<LlmFormState>) => void;
    providers: SmrProvider[] | undefined;
    providersLoading: boolean;
    selectedProvider: string;
    selectedModel: string;
    onProviderChange: (name: string) => void;
    onModelChange: (name: string) => void;
    /** GLOBAL_ADMIN / TENANT_ADMIN — gates the assembled debug switch. */
    canDebug: boolean;
    /** Exactly-one-context-source violation message (assembled mode). */
    sourceHint: string | null;
}

function SwitchRow({
    id,
    label,
    caption,
    checked,
    onCheckedChange,
}: {
    id: string;
    label: string;
    caption: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-3 rounded-md border p-3">
            <div className="flex min-w-0 flex-col gap-0.5">
                <Label htmlFor={id}>{label}</Label>
                <p className="text-muted-foreground text-xs">{caption}</p>
            </div>
            <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
        </div>
    );
}

export function PromptEditorCard({
    form,
    onPatch,
    providers,
    providersLoading,
    selectedProvider,
    selectedModel,
    onProviderChange,
    onModelChange,
    canDebug,
    sourceHint,
}: PromptEditorCardProps) {
    const activeProvider = providers?.find((provider) => provider.name === selectedProvider);

    return (
        <Card className="gap-4">
            <CardHeader>
                <CardTitle>Prompt · request</CardTitle>
                <CardDescription>POST /text/generate — assembled mode posts /text/generate/assembled instead</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                    <Label htmlFor="llm-prompt">Prompt</Label>
                    <Textarea
                        id="llm-prompt"
                        value={form.prompt}
                        onChange={(event) => onPatch({ prompt: event.target.value })}
                        placeholder="Summarize the visit transcript below…"
                        className="min-h-40 flex-1 resize-none font-mono text-sm"
                    />
                </div>
                <div className="flex flex-col gap-2">
                    <Label htmlFor="llm-system-prompt">System prompt</Label>
                    <Textarea
                        id="llm-system-prompt"
                        value={form.systemPrompt}
                        onChange={(event) => onPatch({ systemPrompt: event.target.value })}
                        placeholder="You are a clinical summarizer…"
                        className="min-h-20 resize-none font-mono text-sm"
                    />
                </div>

                {providersLoading ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-9 w-full" />
                    </div>
                ) : providers && providers.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="llm-provider">Provider</Label>
                            <NativeSelect id="llm-provider" value={selectedProvider} onChange={(event) => onProviderChange(event.target.value)}>
                                {providers.map((provider) => (
                                    <NativeSelectOption key={provider.name} value={provider.name} disabled={!provider.is_available}>
                                        {provider.name}
                                        {provider.is_default ? ' · default' : ''}
                                        {provider.is_available ? '' : ' (unavailable)'}
                                    </NativeSelectOption>
                                ))}
                            </NativeSelect>
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="llm-model">Model</Label>
                            <NativeSelect id="llm-model" value={selectedModel} onChange={(event) => onModelChange(event.target.value)}>
                                {(activeProvider?.models ?? []).map((model) => (
                                    <NativeSelectOption key={model.name} value={model.name}>
                                        {model.name}
                                        {model.size ? ` · ${model.size}` : ''}
                                    </NativeSelectOption>
                                ))}
                                {/* Empty value = drop `model` from the body → HarnessPolicy cascade. */}
                                <NativeSelectOption value="">Omit — tenant default (cascade)</NativeSelectOption>
                            </NativeSelect>
                        </div>
                    </div>
                ) : providers ? (
                    <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
                        No provider catalog for this tenant — requests post without provider/model and the tenant’s HarnessPolicy cascade resolves
                        them server-side.
                    </p>
                ) : (
                    <p className="text-destructive text-sm">
                        Provider catalog unavailable — generation still works; the tenant’s HarnessPolicy cascade resolves the model server-side.
                    </p>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <Label htmlFor="llm-temperature">Temperature</Label>
                            <span className="text-muted-foreground font-mono text-xs">{form.temperature.toFixed(1)}</span>
                        </div>
                        <input
                            id="llm-temperature"
                            type="range"
                            min={0}
                            max={2}
                            step={0.1}
                            value={form.temperature}
                            onChange={(event) => onPatch({ temperature: Number(event.target.value) })}
                            className="accent-primary w-full"
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="llm-max-tokens">Max tokens</Label>
                        <Input
                            id="llm-max-tokens"
                            type="number"
                            min={1}
                            max={32768}
                            value={form.maxTokens}
                            onChange={(event) => onPatch({ maxTokens: event.target.value })}
                        />
                    </div>
                </div>

                <SwitchRow
                    id="llm-streaming"
                    label="Streaming mode"
                    caption="Stream tokens over SSE; off = one sync response with latency and usage."
                    checked={form.streaming}
                    onCheckedChange={(checked) => onPatch({ streaming: checked })}
                />
                <SwitchRow
                    id="llm-assembled"
                    label="Assembled mode"
                    caption="Compose the prompt server-side from context items / template / DNA style."
                    checked={form.assembled}
                    onCheckedChange={(checked) => onPatch({ assembled: checked })}
                />

                {form.assembled ? (
                    <div className="flex flex-col gap-4 border-t pt-4">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="flex flex-col gap-2">
                                <Label htmlFor="llm-assembled-type">Type</Label>
                                <NativeSelect
                                    id="llm-assembled-type"
                                    value={form.assembledType}
                                    onChange={(event) => onPatch({ assembledType: event.target.value as AssembledGenerationType })}
                                >
                                    <NativeSelectOption value="pre-summary">pre-summary</NativeSelectOption>
                                    <NativeSelectOption value="summary">summary</NativeSelectOption>
                                </NativeSelect>
                            </div>
                            <div className="flex flex-col gap-2">
                                <Label htmlFor="llm-visit-type">Visit type</Label>
                                <NativeSelect
                                    id="llm-visit-type"
                                    value={form.visitType}
                                    onChange={(event) => onPatch({ visitType: event.target.value as AssembledVisitType })}
                                >
                                    <NativeSelectOption value="new_visit">new_visit</NativeSelectOption>
                                    <NativeSelectOption value="referral">referral</NativeSelectOption>
                                </NativeSelect>
                            </div>
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="llm-message">Message</Label>
                            <Textarea
                                id="llm-message"
                                value={form.message}
                                onChange={(event) => onPatch({ message: event.target.value })}
                                placeholder="Ad-hoc message to assemble around…"
                                className="min-h-20 resize-none font-mono text-sm"
                            />
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="llm-context-ids">Context item IDs</Label>
                            <Input
                                id="llm-context-ids"
                                value={form.contextItemIds}
                                onChange={(event) => onPatch({ contextItemIds: event.target.value })}
                                placeholder="ctx-1, ctx-2 (comma-separated)"
                            />
                            <p className={sourceHint ? 'text-warning-strong text-xs' : 'text-muted-foreground text-xs'}>
                                {sourceHint ?? 'Exactly one context source: a message or context item IDs.'}
                            </p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="flex flex-col gap-2">
                                <Label htmlFor="llm-template-id">Template ID</Label>
                                <Input
                                    id="llm-template-id"
                                    value={form.templateId}
                                    onChange={(event) => onPatch({ templateId: event.target.value })}
                                    placeholder="prompt template id (optional)"
                                />
                            </div>
                            <div className="flex flex-col gap-2">
                                <Label htmlFor="llm-dna-style-id">DNA style ID</Label>
                                <Input
                                    id="llm-dna-style-id"
                                    value={form.dnaStyleId}
                                    onChange={(event) => onPatch({ dnaStyleId: event.target.value })}
                                    placeholder="dna writing style id (optional)"
                                />
                            </div>
                        </div>
                        {canDebug ? (
                            <SwitchRow
                                id="llm-debug"
                                label="Debug assembly"
                                caption="GLOBAL_ADMIN / TENANT_ADMIN only — the response carries the _debug assembly meta."
                                checked={form.debug}
                                onCheckedChange={(checked) => onPatch({ debug: checked })}
                            />
                        ) : null}
                    </div>
                ) : null}
            </CardContent>
        </Card>
    );
}
