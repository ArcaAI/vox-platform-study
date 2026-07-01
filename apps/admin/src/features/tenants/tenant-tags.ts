/**
 * Pure tenant-tag helpers (TASK-387 #2 / F9). The tags editor keeps a working
 * draft locally and replaces the whole set via `useTenants().setTags`; these keep
 * the add/remove/normalize logic testable in isolation.
 */

/** Trim + collapse inner whitespace. Tags are compared case-sensitively but de-duped as typed. */
export function normalizeTag(tag: string): string {
    return tag.trim().replace(/\s+/g, ' ');
}

/** Normalize, drop empties, and de-duplicate while preserving first-seen order. */
export function normalizeTags(tags: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of tags) {
        const tag = normalizeTag(raw);
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        out.push(tag);
    }
    return out;
}

/** Append a tag (no-op when empty or already present). Returns a new array. */
export function addTag(tags: string[], tag: string): string[] {
    const next = normalizeTag(tag);
    if (!next || tags.some((t) => t === next)) return tags;
    return [...tags, next];
}

/** Remove a tag by exact value. Returns a new array. */
export function removeTag(tags: string[], tag: string): string[] {
    return tags.filter((t) => t !== tag);
}

/** True when two tag sets differ (order-insensitive) — drives the Save enabled state. */
export function tagsChanged(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return true;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.some((t, i) => t !== sortedB[i]);
}
