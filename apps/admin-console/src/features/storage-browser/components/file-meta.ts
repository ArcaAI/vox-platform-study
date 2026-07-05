/**
 * Extension-derived display metadata. The /storage/buckets/:name/files
 * listing carries only key/size/lastModified — content types shown in the
 * actions panel are inferred from the key, never fetched.
 */

import { IconFile, IconFileMusic, IconFileText, IconFileZip, IconMovie, IconPhoto } from '@tabler/icons-react';
import type { ComponentType } from 'react';

export function objectBasename(key: string): string {
    const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
    return trimmed.split('/').pop() ?? trimmed;
}

function extensionOf(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

const CONTENT_TYPES: Record<string, string> = {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    pdf: 'application/pdf',
    zip: 'application/zip',
    gz: 'application/gzip',
};

/** Best-effort MIME from the file extension; null when unknown. */
export function guessContentType(name: string): string | null {
    return CONTENT_TYPES[extensionOf(name)] ?? null;
}

type IconComponent = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

/** Small file-type icon for the object grid (frame 31 key column). */
export function fileTypeIcon(name: string): IconComponent {
    const type = guessContentType(name);
    if (!type) return IconFile;
    if (type.startsWith('audio/')) return IconFileMusic;
    if (type.startsWith('video/')) return IconMovie;
    if (type.startsWith('image/')) return IconPhoto;
    if (type.startsWith('text/') || type === 'application/pdf' || type === 'application/json') return IconFileText;
    if (type === 'application/zip' || type === 'application/gzip') return IconFileZip;
    return IconFile;
}
