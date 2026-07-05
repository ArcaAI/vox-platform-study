'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

interface BreadcrumbState {
    /** Resolved display name for the trailing dynamic segment (detail pages). */
    trailing: string | null;
    setTrailing: (label: string | null) => void;
}

export const useBreadcrumbStore = create<BreadcrumbState>((set) => ({
    trailing: null,
    setTrailing: (trailing) => set({ trailing }),
}));

/**
 * Detail screens publish their resolved display name ("Sunrise Medical
 * Group") so the topbar breadcrumb shows it instead of the raw id segment.
 * Cleared automatically on unmount.
 */
export function useTrailingBreadcrumb(label: string | null | undefined) {
    const setTrailing = useBreadcrumbStore((state) => state.setTrailing);
    useEffect(() => {
        setTrailing(label ?? null);
        return () => setTrailing(null);
    }, [label, setTrailing]);
}
