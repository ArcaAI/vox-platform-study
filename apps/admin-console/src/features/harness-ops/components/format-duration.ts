const EM_DASH = '\u2014';

/**
 * Compact human duration for wait clocks and workflow runtimes ("38 min",
 * "2 h 5 min", "3 d 4 h"). Sub-minute durations collapse to seconds.
 */
export function formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return EM_DASH;
    const total = Math.max(Math.round(seconds), 0);
    if (total < 60) return `${total} s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        const rest = minutes % 60;
        return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
    }
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours > 0 ? `${days} d ${restHours} h` : `${days} d`;
}

/** Elapsed seconds between two instants (end defaults to now). */
export function elapsedSeconds(start: string | null | undefined, end?: string | null): number | null {
    if (!start) return null;
    const startMs = new Date(start).getTime();
    if (Number.isNaN(startMs)) return null;
    const endMs = end ? new Date(end).getTime() : Date.now();
    if (Number.isNaN(endMs)) return null;
    return Math.max((endMs - startMs) / 1000, 0);
}
