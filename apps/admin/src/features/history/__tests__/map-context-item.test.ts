import { describe, expect, it } from 'vitest';
import type { ContextItem } from '@arcaai/vox';
import { mapContextItem, mergeResolvedMedia } from '../map-context-item';

function makeItem(partial: Partial<ContextItem>): ContextItem {
    return {
        id: 'ci-1',
        consultationId: 'c-1',
        type: 'CASE_NOTE',
        content: 'Patient reports mild headache.',
        source: 'USER',
        isSummary: false,
        isTranscript: false,
        isAiGenerated: false,
        isCaseNote: true,
        isWorknote: false,
        isNamedEntity: false,
        isAttachment: false,
        isFinalSummary: false,
        isPreSummary: false,
        isMediaType: false,
        createdAt: '2026-06-27T10:00:00.000Z',
        updatedAt: '2026-06-27T10:00:00.000Z',
        ...partial,
    } as ContextItem;
}

/** Attach the TASK-375 storage-resolved media fields (not on the SDK type) to an item. */
function withMedia(item: ContextItem, media: { url?: string; mimeType?: string; thumbnailUrl?: string }): ContextItem {
    return { ...item, ...media } as ContextItem;
}

describe('mapContextItem', () => {
    it('maps a text case note to a markdown timeline item', () => {
        const model = mapContextItem(makeItem({ type: 'CASE_NOTE', content: 'Hello' }));
        expect(model.variant).toBe('markdown');
        expect(model.content).toEqual({ type: 'markdown', markdown: 'Hello' });
        expect(model.id).toBe('ci-1');
        expect(model.badges?.[0]?.label).toBe('Case note');
    });

    it('falls back to a placeholder for empty content', () => {
        const model = mapContextItem(makeItem({ content: '' }));
        expect(model.content).toEqual({ type: 'markdown', markdown: '_No content_' });
    });

    it('adds an AI badge for AI-generated items', () => {
        const model = mapContextItem(makeItem({ isAiGenerated: true, type: 'RAW_SUMMARY' }));
        expect(model.badges?.some((b) => b.label === 'AI')).toBe(true);
    });

    it('maps an image attachment (by mime type) to the image variant', () => {
        const model = mapContextItem(
            makeItem({ type: 'ATTACHMENT', structuredData: { url: 'https://x/y', mimeType: 'image/png', name: 'scan.png' } }),
        );
        expect(model.variant).toBe('image');
        expect(model.content).toMatchObject({ type: 'image' });
    });

    it('maps a pdf attachment (by extension) to the pdf variant', () => {
        const model = mapContextItem(makeItem({ type: 'ATTACHMENT', structuredData: { url: 'https://x/report.pdf' } }));
        expect(model.variant).toBe('pdf');
        expect(model.content).toMatchObject({ type: 'pdf', url: 'https://x/report.pdf' });
    });

    it('degrades an unknown attachment to the file variant', () => {
        const model = mapContextItem(
            makeItem({ type: 'ATTACHMENT', structuredData: { url: 'https://x/data.bin', mimeType: 'application/octet-stream', name: 'data.bin' } }),
        );
        expect(model.variant).toBe('file');
        expect(model.content).toMatchObject({ type: 'file', name: 'data.bin' });
    });

    // TASK-375: backend-resolved top-level media fields (url / mimeType / thumbnailUrl).

    it('binds a top-level resolved image: thumbnailUrl for the grid src, full url available', () => {
        const item = withMedia(makeItem({ type: 'ATTACHMENT', content: '', structuredData: { name: 'scan.png' } }), {
            url: 'https://s3/full/scan.png?sig=1',
            mimeType: 'image/png',
            thumbnailUrl: 'https://s3/thumb/scan.png?sig=2',
        });
        const model = mapContextItem(item);
        expect(model.variant).toBe('image');
        expect(model.content.type).toBe('image');
        if (model.content.type !== 'image') throw new Error('expected image content');
        expect(model.content.images).toHaveLength(1);
        // Grid src binds the thumbnail; the full-res `url` is the zoom lightbox source (TASK-372 zoomSrc).
        expect(model.content.images[0]?.src).toBe('https://s3/thumb/scan.png?sig=2');
        expect(model.content.images[0]?.zoomSrc).toBe('https://s3/full/scan.png?sig=1');
        expect(model.content.images[0]?.alt).toBe('scan.png');
    });

    it('falls back to the full url for the image src when no thumbnailUrl (zoomSrc identical)', () => {
        const item = withMedia(makeItem({ type: 'ATTACHMENT', content: '' }), { url: 'https://s3/full/x.jpg?sig=1', mimeType: 'image/jpeg' });
        const model = mapContextItem(item);
        expect(model.variant).toBe('image');
        if (model.content.type !== 'image') throw new Error('expected image content');
        expect(model.content.images[0]?.src).toBe('https://s3/full/x.jpg?sig=1');
        // No separate thumbnail → zoomSrc equals src (a no-op swap, stays full-res).
        expect(model.content.images[0]?.zoomSrc).toBe('https://s3/full/x.jpg?sig=1');
    });

    it('binds a top-level resolved pdf url into the pdf renderer', () => {
        const item = withMedia(makeItem({ type: 'ATTACHMENT', content: '', structuredData: { name: 'report.pdf' } }), {
            url: 'https://s3/report.pdf?sig=1',
            mimeType: 'application/pdf',
        });
        const model = mapContextItem(item);
        expect(model.variant).toBe('pdf');
        expect(model.content).toMatchObject({ type: 'pdf', url: 'https://s3/report.pdf?sig=1', name: 'report.pdf' });
    });

    it('binds a top-level resolved audio url into the audio player', () => {
        const item = withMedia(makeItem({ type: 'AUDIO_RECORDING', content: '', structuredData: { name: 'visit.mp3' } }), {
            url: 'https://s3/visit.mp3?sig=1',
            mimeType: 'audio/mpeg',
        });
        const model = mapContextItem(item);
        expect(model.variant).toBe('audio');
        expect(model.content).toMatchObject({ type: 'audio', src: 'https://s3/visit.mp3?sig=1', title: 'visit.mp3' });
    });

    it('maps an item with multiple nested attachments (audio + images + file + text) to mixed', () => {
        const model = mapContextItem(
            makeItem({
                type: 'ATTACHMENT',
                content: 'Scans plus the dictation.',
                structuredData: {
                    attachments: [
                        { url: 'https://s3/scan1.png?s=1', mimeType: 'image/png', thumbnailUrl: 'https://s3/scan1-t.png?s=2', name: 'scan1.png' },
                        { url: 'https://s3/scan2.jpg?s=1', mimeType: 'image/jpeg', name: 'scan2.jpg' },
                        { url: 'https://s3/dictation.mp3?s=1', mimeType: 'audio/mpeg', name: 'dictation.mp3' },
                        { url: 'https://s3/labs.pdf?s=1', mimeType: 'application/pdf', name: 'labs.pdf' },
                        { url: 'https://s3/data.bin?s=1', mimeType: 'application/octet-stream', name: 'data.bin' },
                    ],
                },
            }),
        );

        expect(model.variant).toBe('mixed');
        if (model.content.type !== 'mixed') throw new Error('expected mixed content');
        const parts = model.content.parts;

        // text first, then a single image grid (2 images), then pdf, audio, file.
        expect(parts[0]).toEqual({ type: 'markdown', markdown: 'Scans plus the dictation.' });

        const image = parts.find((p) => p.type === 'image');
        expect(image?.type === 'image' && image.images).toHaveLength(2);
        expect(image?.type === 'image' && image.images[0]?.src).toBe('https://s3/scan1-t.png?s=2');
        // Grid uses the thumbnail; zoom uses the full-res url.
        expect(image?.type === 'image' && image.images[0]?.zoomSrc).toBe('https://s3/scan1.png?s=1');
        // Second image has no thumbnail → src and zoomSrc are both the full url.
        expect(image?.type === 'image' && image.images[1]?.src).toBe('https://s3/scan2.jpg?s=1');
        expect(image?.type === 'image' && image.images[1]?.zoomSrc).toBe('https://s3/scan2.jpg?s=1');

        expect(parts.some((p) => p.type === 'pdf' && p.url === 'https://s3/labs.pdf?s=1')).toBe(true);
        expect(parts.some((p) => p.type === 'audio' && p.src === 'https://s3/dictation.mp3?s=1')).toBe(true);
        expect(parts.some((p) => p.type === 'file' && p.url === 'https://s3/data.bin?s=1')).toBe(true);
    });

    it('mixes a top-level primary attachment with nested attachments', () => {
        const item = withMedia(makeItem({ type: 'ATTACHMENT', content: '', structuredData: { name: 'cover.png', attachments: [{ url: 'https://s3/note.mp3?s=1', mimeType: 'audio/mpeg', name: 'note.mp3' }] } }), {
            url: 'https://s3/cover.png?s=1',
            mimeType: 'image/png',
        });
        const model = mapContextItem(item);
        expect(model.variant).toBe('mixed');
        if (model.content.type !== 'mixed') throw new Error('expected mixed content');
        expect(model.content.parts.some((p) => p.type === 'image')).toBe(true);
        expect(model.content.parts.some((p) => p.type === 'audio' && p.src === 'https://s3/note.mp3?s=1')).toBe(true);
    });

    it('degrades to markdown when an attachment has no resolvable url', () => {
        const model = mapContextItem(makeItem({ type: 'ATTACHMENT', content: 'Pending upload.', structuredData: { name: 'scan.png', mimeType: 'image/png' } }));
        expect(model.variant).toBe('markdown');
        expect(model.content).toEqual({ type: 'markdown', markdown: 'Pending upload.' });
    });
});

describe('mergeResolvedMedia', () => {
    it('merges resolved media onto matching items by id and preserves order', () => {
        const a = makeItem({ id: 'a', type: 'ATTACHMENT', content: '' });
        const b = makeItem({ id: 'b', type: 'CASE_NOTE', content: 'note' });
        const resolvedA = withMedia(makeItem({ id: 'a' }), { url: 'https://s3/a.png?s=1', mimeType: 'image/png', thumbnailUrl: 'https://s3/a-t.png?s=2' });

        const merged = mergeResolvedMedia([a, b], [resolvedA]);

        expect(merged.map((i) => i.id)).toEqual(['a', 'b']);
        expect(merged[0]).toMatchObject({ id: 'a', url: 'https://s3/a.png?s=1', mimeType: 'image/png', thumbnailUrl: 'https://s3/a-t.png?s=2' });
        // Non-matching item passes through untouched (reference-equal).
        expect(merged[1]).toBe(b);
    });

    it('produces an image timeline item end-to-end after merge', () => {
        const a = makeItem({ id: 'a', type: 'ATTACHMENT', content: '', structuredData: { name: 'scan.png' } });
        const resolvedA = withMedia(makeItem({ id: 'a' }), { url: 'https://s3/a.png?s=1', mimeType: 'image/png', thumbnailUrl: 'https://s3/a-t.png?s=2' });

        const [merged] = mergeResolvedMedia([a], [resolvedA]);
        const model = mapContextItem(merged);

        expect(model.variant).toBe('image');
        if (model.content.type !== 'image') throw new Error('expected image content');
        expect(model.content.images[0]?.src).toBe('https://s3/a-t.png?s=2');
        expect(model.content.images[0]?.zoomSrc).toBe('https://s3/a.png?s=1');
    });

    it('is a no-op when there are no resolved items (graceful degradation)', () => {
        const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })];
        expect(mergeResolvedMedia(items, [])).toBe(items);
    });

    it('is a no-op when resolved items carry no media fields', () => {
        const items = [makeItem({ id: 'a' })];
        const resolved = [makeItem({ id: 'a' })];
        expect(mergeResolvedMedia(items, resolved)).toBe(items);
    });
});
