import type { TimelineBadge, TimelineContent, TimelineImage, TimelineItemModel } from '@arcaai/ui/components/timeline';
import type { ContextItem } from '@arcaai/vox';

const TYPE_LABELS: Record<string, string> = {
    TRANSCRIPT: 'Transcript',
    CASE_NOTE: 'Case note',
    WORKNOTE: 'Work note',
    RAW_SUMMARY: 'Summary',
    MODIFIED_SUMMARY: 'Edited summary',
    PRE_SUMMARY: 'Pre-summary',
    AUDIO_RECORDING: 'Audio',
    NAMED_ENTITY: 'Entities',
    ATTACHMENT: 'Attachment',
};

function typeLabel(type: string): string {
    return TYPE_LABELS[type] ?? type;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * TASK-375 — the storage-resolved media fields the backend now attaches to a
 * media-bearing context item on `GET /consultations/:id/context`: a short-lived
 * presigned `url`, its `mimeType`, and (for images) a `thumbnailUrl`. They exist
 * at runtime but are not (yet) declared on the SDK's `ContextItem`, so the mapper
 * reads them through this local view type.
 */
export type ContextItemWithMedia = ContextItem & {
    url?: string;
    mimeType?: string;
    thumbnailUrl?: string;
};

/** Just the resolved media fields — what {@link mergeResolvedMedia} copies. */
export type ResolvedContextMedia = { url?: string; mimeType?: string; thumbnailUrl?: string };

/**
 * A single resolved attachment, normalized from the item's top-level media
 * fields or a nested `structuredData.attachments[]` entry.
 */
interface MediaSource {
    url: string;
    thumbnailUrl?: string;
    mimeType: string;
    name: string;
    width?: number;
    height?: number;
}

type MediaKind = 'image' | 'pdf' | 'audio' | 'file';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|oga|webm|aac|flac)$/i;

function classify({ mimeType, url }: MediaSource): MediaKind {
    if (/^image\//.test(mimeType) || IMAGE_EXT.test(url)) return 'image';
    if (mimeType === 'application/pdf' || /\.pdf$/i.test(url)) return 'pdf';
    if (/^audio\//.test(mimeType) || AUDIO_EXT.test(url)) return 'audio';
    return 'file';
}

/** Loose shape for the legacy `structuredData` bag / a nested attachment entry. */
interface RawAttachment {
    url?: unknown;
    fileUrl?: unknown;
    src?: unknown;
    thumbnailUrl?: unknown;
    thumbnailSrc?: unknown;
    mimeType?: unknown;
    contentType?: unknown;
    name?: unknown;
    fileName?: unknown;
    width?: unknown;
    height?: unknown;
}

function toMediaSource(raw: RawAttachment, fallbackName: string): MediaSource | null {
    const url = asString(raw.url) ?? asString(raw.fileUrl) ?? asString(raw.src);
    if (!url) return null;
    return {
        url,
        thumbnailUrl: asString(raw.thumbnailUrl) ?? asString(raw.thumbnailSrc),
        mimeType: asString(raw.mimeType) ?? asString(raw.contentType) ?? '',
        name: asString(raw.name) ?? asString(raw.fileName) ?? fallbackName,
        width: asNumber(raw.width),
        height: asNumber(raw.height),
    };
}

function toTimelineImage(source: MediaSource, id: string): TimelineImage {
    return {
        id,
        // Grid shows the (smaller) thumbnail; the zoom lightbox upgrades to the
        // full-resolution `url` via `zoomSrc` (TASK-372 TimelineImage enhancement),
        // which falls back to `src` in @arcaai/ui when absent. When no separate
        // thumbnail exists, `src` is the full url and `zoomSrc` is identical (a no-op
        // swap), so the large zoomable view is always full-resolution.
        src: source.thumbnailUrl ?? source.url,
        zoomSrc: source.url,
        alt: source.name,
        width: source.width ?? 1024,
        height: source.height ?? 768,
        title: source.name,
    };
}

function singleContent(source: MediaSource, itemId: string): Pick<TimelineItemModel, 'variant' | 'content'> {
    switch (classify(source)) {
        case 'image':
            return { variant: 'image', content: { type: 'image', images: [toTimelineImage(source, itemId)] } };
        case 'pdf':
            return { variant: 'pdf', content: { type: 'pdf', url: source.url, name: source.name } };
        case 'audio':
            return { variant: 'audio', content: { type: 'audio', src: source.url, title: source.name } };
        default:
            return { variant: 'file', content: { type: 'file', url: source.url, name: source.name, mimeType: source.mimeType || undefined } };
    }
}

/**
 * Compose the parts of a `mixed` card: the item's text (markdown), then a single
 * image grid for all images, then a part per pdf / audio / file. Ordering keeps
 * related media grouped (image grid is one part regardless of image count).
 */
function mixedParts(sources: MediaSource[], text: string | undefined, itemId: string): TimelineContent[] {
    const parts: TimelineContent[] = [];

    if (text?.trim()) {
        parts.push({ type: 'markdown', markdown: text });
    }

    const images = sources.filter((s) => classify(s) === 'image');
    if (images.length > 0) {
        parts.push({ type: 'image', images: images.map((s, i) => toTimelineImage(s, `${itemId}-img-${i}`)) });
    }
    for (const s of sources.filter((s) => classify(s) === 'pdf')) {
        parts.push({ type: 'pdf', url: s.url, name: s.name });
    }
    for (const s of sources.filter((s) => classify(s) === 'audio')) {
        parts.push({ type: 'audio', src: s.url, title: s.name });
    }
    for (const s of sources.filter((s) => classify(s) === 'file')) {
        parts.push({ type: 'file', url: s.url, name: s.name, mimeType: s.mimeType || undefined });
    }

    return parts;
}

/**
 * Adapt an SDK `ContextItem` → `HistoryTimelineList`'s `TimelineItemModel`.
 *
 * Media (TASK-375): a media-bearing item carries a storage-resolved presigned
 * `url` (+ `mimeType`, + image `thumbnailUrl`), which binds to the image grid /
 * zoomable lightbox, PDF (react-pdf), and audio player. Items with several
 * attachments (nested `structuredData.attachments[]`) render as a `mixed` card
 * (the item's text + an image grid + pdf/audio/file parts). When no media `url`
 * resolves, the item gracefully degrades to its text/markdown card (the
 * pre-TASK-375 behavior), so a timeline still reads before media resolution lands
 * or when storage is unavailable.
 */
export function mapContextItem(item: ContextItem): TimelineItemModel {
    const media = item as ContextItemWithMedia;
    const sd = (item.structuredData ?? {}) as Record<string, unknown>;
    const fallbackName = typeLabel(String(item.type));

    // Primary attachment: prefer the TASK-375 top-level resolved url, else the
    // legacy `structuredData` url (the pre-resolution degradation path).
    const primary =
        toMediaSource({ url: media.url, thumbnailUrl: media.thumbnailUrl, mimeType: media.mimeType, name: sd.name, fileName: sd.fileName }, fallbackName) ??
        toMediaSource(sd as RawAttachment, fallbackName);

    // Nested attachments power the "mixed" content type (audio + images + files
    // + text in one item). Each entry is normalized like the primary attachment.
    const nested = Array.isArray(sd.attachments)
        ? (sd.attachments as unknown[])
              .map((a, i) => toMediaSource((a ?? {}) as RawAttachment, `${fallbackName} ${i + 1}`))
              .filter((s): s is MediaSource => s !== null)
        : [];

    const sources: MediaSource[] = primary ? [primary, ...nested] : nested;

    const badges: TimelineBadge[] = [{ label: fallbackName, variant: 'secondary' }];
    if (item.isAiGenerated) badges.push({ label: 'AI', variant: 'outline' });

    const base = {
        id: item.id,
        timestamp: item.createdAt,
        title: fallbackName,
        badges,
        meta: { type: item.type, source: item.source },
    } as const;

    // No resolvable media → markdown (current / degraded behavior).
    if (sources.length === 0) {
        const markdown = item.content?.trim() ? item.content : '_No content_';
        return { ...base, variant: 'markdown', content: { type: 'markdown', markdown } };
    }

    // Exactly one attachment → its dedicated variant (preserves prior behavior).
    if (sources.length === 1) {
        return { ...base, ...singleContent(sources[0], item.id) };
    }

    // Multiple attachments → mixed (image grid + pdf/audio/file + the item text).
    return { ...base, variant: 'mixed', content: { type: 'mixed', parts: mixedParts(sources, item.content, item.id) } };
}

/**
 * Merge the TASK-375 storage-resolved media fields from the enriched
 * `GET /consultations/:id/context` response onto the store's context items
 * (which arrive via the consultation GET and are NOT media-enriched), matched by
 * `id`. Pure; preserves input order. Items without a resolved match pass through
 * unchanged, so the timeline degrades gracefully when resolution is unavailable.
 */
export function mergeResolvedMedia(items: ContextItem[], resolved: readonly ContextItem[]): ContextItem[] {
    if (resolved.length === 0) return items;

    const byId = new Map<string, ResolvedContextMedia>();
    for (const r of resolved) {
        const m = r as ContextItemWithMedia;
        const media: ResolvedContextMedia = {};
        if (m.url) media.url = m.url;
        if (m.mimeType) media.mimeType = m.mimeType;
        if (m.thumbnailUrl) media.thumbnailUrl = m.thumbnailUrl;
        if (media.url || media.mimeType || media.thumbnailUrl) byId.set(r.id, media);
    }
    if (byId.size === 0) return items;

    return items.map((item) => {
        const media = byId.get(item.id);
        return media ? ({ ...item, ...media } as ContextItem) : item;
    });
}
