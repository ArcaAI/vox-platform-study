import { useEffect, useState } from 'react';
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@arcaai/ui';
import { fetchPipelines, type PipelineOption } from '../lib/pipelines';

type PipelineFetchState = 'loading' | 'list' | 'freetext';

/** Sentinel for "no pipeline selected" — Radix `<Select.Item>` rejects an empty-string value. */
const NONE_PIPELINE = '__none__';
/** Sentinel for the always-available free-text escape hatch. */
const CUSTOM_PIPELINE = '__custom__';

/**
 * Settle time before the draft credentials are sent to the gateway.
 *
 * The Connection tab re-renders on every keystroke, so an undebounced effect
 * POSTs a partially-typed API key to `/api/v1/audio/pipelines` once per
 * character. Stale responses were already discarded (the `cancelled` guard
 * below), so this was never a correctness race — it is credential hygiene and
 * gateway log noise. 400 ms is past a normal inter-keystroke gap and well under
 * the time it takes to reach for the Connect button.
*/
export const PIPELINE_FETCH_DEBOUNCE_MS = 400;

export interface PipelinePickerProps {
  id?: string;
  apiEndpoint: string;
  apiKey: string;
  /** The submitted `pipelineId` — empty string means "tenant default (no SDK pipeline)". */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  'aria-describedby'?: string;
}

/**
 * Pipeline picker for the Connection tab.
 *
 * Same three-state pattern as the department picker in `SummaryCard.tsx`
 * (`loading | list | freetext`): fetch the tenant's real pipelines via
 * `lib/pipelines.ts`, render a `<Select>` when the fetch succeeds with at
 * least one row, and fall back to the original free-text `<Input>` on
 * 401/403/network error or an empty list — so a developer against a
 * deployment that predates pipelines (or lacks list permission) is never
 * blocked from typing an id by hand.
 *
 * A `Custom…` option is always present in the list state so a developer can
 * switch to free text even when the fetch succeeds (e.g. to test an id that
 * isn't in this tenant's catalog).
*/
export function PipelinePicker({
  id = 'pipeline-picker',
  apiEndpoint,
  apiKey,
  value,
  onChange,
  disabled,
  placeholder,
  'aria-describedby': ariaDescribedBy,
}: PipelinePickerProps) {
  const [state, setState] = useState<PipelineFetchState>('loading');
  const [options, setOptions] = useState<PipelineOption[]>([]);
  // Once the developer explicitly picks "Custom…", stay in free-text mode
  // for the rest of this mount — mirrors the department picker.
  const [isCustom, setIsCustom] = useState(false);

  useEffect(() => {
    if (!apiEndpoint.trim() || !apiKey.trim()) {
      setState('freetext');
      return;
    }
    let cancelled = false;
    setState('loading');
    // Debounced: one fetch per settled pair of values, not one per keystroke.
    // The `cancelled` flag still guards the in-flight response — clearing the
    // timer only prevents requests that have not been issued yet.
    const timer = setTimeout(() => {
      fetchPipelines(apiEndpoint, apiKey)
        .then((fetched) => {
          if (cancelled) return;
          if (fetched.length === 0) {
            setState('freetext');
            return;
          }
          setOptions(fetched);
          setState('list');
        })
        .catch(() => {
          if (!cancelled) setState('freetext');
        });
    }, PIPELINE_FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiEndpoint, apiKey]);

  if (state === 'loading') {
    return <Skeleton className="h-9 w-full" aria-label="Loading pipelines" />;
  }

  if (state === 'freetext' || isCustom) {
    return (
      <Input
        id={id}
        aria-label="Pipeline ID"
        aria-describedby={ariaDescribedBy}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoComplete="off"
      />
    );
  }

  const currentSelectValue = value.trim() === '' ? NONE_PIPELINE : options.some((o) => o.value === value) ? value : '';

  return (
    <Select
      value={currentSelectValue}
      onValueChange={(v) => {
        if (v === CUSTOM_PIPELINE) {
          setIsCustom(true);
          onChange('');
        } else if (v === NONE_PIPELINE) {
          onChange('');
        } else {
          onChange(v);
        }
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label="Pipeline" aria-describedby={ariaDescribedBy} className="w-full">
        <SelectValue placeholder="Select a pipeline" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_PIPELINE}>Tenant default (no pipeline)</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.value}>
            {o.label}
            {o.isDefault ? ' — default' : ''}
          </SelectItem>
        ))}
        <SelectItem value={CUSTOM_PIPELINE}>Custom…</SelectItem>
      </SelectContent>
    </Select>
  );
}
