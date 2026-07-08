'use client';

import { CodeEditor, validateJson } from '@arcaai/ui';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Switch } from '@arcaai/ui/components/shadcn/switch';

/**
 * Type-aware value editor for a setting (TASK-439, supersedes the old modal
 * `ValueEditor`). `Boolean` → Switch; `Json`/`Array` → the shared `CodeEditor`
 * (line numbers, syntax highlight, Format, live validation, Copy); `Binary` →
 * a read-only notice; every other scalar → a single Input (numeric inputmode for
 * number types). It never handles secrets — those are write-only and rendered by
 * the drawer's secret pane.
 */

const JSON_TYPES = new Set(['Json', 'Array']);
const NUMERIC_TYPES = new Set(['Integer', 'Float', 'Double', 'Decimal']);

export function isJsonType(dataType: string): boolean {
    return JSON_TYPES.has(dataType);
}

/**
 * Whether the current value is savable for its declared type. Only JSON/Array
 * can be structurally invalid; every other type accepts any string. Drives the
 * drawer's Save-disabled gate (AC 2).
 */
export function isValueValid(dataType: string, value: string): boolean {
    if (isJsonType(dataType)) return validateJson(value).ok;
    return true;
}

export interface ValueEditorPaneProps {
    id: string;
    dataType: string;
    value: string;
    onChange: (value: string) => void;
    /** Accessible name for the Json editor's textarea. */
    ariaLabel?: string;
    disabled?: boolean;
}

export function ValueEditorPane({ id, dataType, value, onChange, ariaLabel = 'Value', disabled }: ValueEditorPaneProps) {
    if (dataType === 'Boolean') {
        return (
            <div className="flex items-center gap-2">
                <Switch id={id} checked={value === 'true'} disabled={disabled} onCheckedChange={(checked) => onChange(String(checked))} />
                <span className="text-muted-foreground font-mono text-xs">{value === 'true' ? 'true' : 'false'}</span>
            </div>
        );
    }

    if (dataType === 'Binary') {
        return (
            <p id={id} className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
                Binary values cannot be edited here. Manage them through the owning service.
            </p>
        );
    }

    if (isJsonType(dataType)) {
        return <CodeEditor aria-label={ariaLabel} value={value} onChange={onChange} readOnly={disabled} language="json" className="min-h-56" />;
    }

    const numeric = NUMERIC_TYPES.has(dataType);
    return (
        <Input
            id={id}
            value={value}
            disabled={disabled}
            inputMode={numeric ? (dataType === 'Integer' ? 'numeric' : 'decimal') : undefined}
            onChange={(event) => onChange(event.target.value)}
            className="font-mono"
        />
    );
}
