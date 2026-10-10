import type { ReactNode } from 'react';

const MAX_DEPTH = 3;

/** The parsed JSON object behind a STRUCTURED item's content, or `null` when it is not an object. */
export function parseStructured(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `bloodPressure` / `blood_pressure` -> `Blood pressure`. */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function renderValue(value: unknown, depth: number): ReactNode {
  if (isPrimitive(value)) return value === null ? '—' : String(value);
  if (Array.isArray(value)) {
    if (value.every(isPrimitive)) return value.map((entry) => (entry === null ? '—' : String(entry))).join(', ') || '—';
    return depth >= MAX_DEPTH ? JSON.stringify(value) : (
      <ul className="flex flex-col gap-1 pl-3">
        {value.map((entry, index) => (
          <li key={index}>{renderValue(entry, depth + 1)}</li>
        ))}
      </ul>
    );
  }
  if (typeof value === 'object') {
    return depth >= MAX_DEPTH ? JSON.stringify(value) : <StructuredList data={value as Record<string, unknown>} depth={depth + 1} />;
  }
  return String(value);
}

/** A STRUCTURED item as a key / value list instead of raw JSON. */
export function StructuredList({ data, depth = 0 }: { data: Record<string, unknown>; depth?: number }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return <span className="text-muted-foreground text-sm">No fields</span>;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{humanizeKey(key)}</dt>
          <dd className="break-words">{renderValue(value, depth)}</dd>
        </div>
      ))}
    </dl>
  );
}
