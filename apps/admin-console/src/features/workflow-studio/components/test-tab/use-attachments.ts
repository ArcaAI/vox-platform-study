'use client';

/**
 * The Test tab's attached files (TASK-1036 OD-15): each chosen file is checked against the Input
 * shape's allowed types, uploaded once, and tracked as a chip — uploading, ready (its `mediaId`),
 * refused (wrong type) or failed (the gateway's reason). Only READY files ride the run.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { isAcceptedMime, uploadMedia } from './lib/media-upload';

export interface AttachmentItem {
  key: string;
  name: string;
  sizeBytes: number;
  status: 'uploading' | 'ready' | 'refused' | 'failed';
  mediaId?: string;
  /** Why a `refused` / `failed` file is not attached. */
  error?: string;
}

export interface AttachmentsController {
  items: AttachmentItem[];
  /** Media ids of the files that finished uploading, in the order they were attached. */
  mediaIds: string[];
  uploading: boolean;
  add: (files: readonly File[]) => void;
  remove: (key: string) => void;
  clear: () => void;
}

export function useAttachments(acceptedMimeTypes: readonly string[]): AttachmentsController {
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const counter = useRef(0);

  const add = useCallback(
    (files: readonly File[]) => {
      const added: AttachmentItem[] = [];
      for (const file of files) {
        counter.current += 1;
        const key = `attachment-${counter.current}`;
        if (!isAcceptedMime(file.type, acceptedMimeTypes)) {
          added.push({ key, name: file.name, sizeBytes: file.size, status: 'refused', error: `Not an accepted type (${acceptedMimeTypes.join(', ')}).` });
          continue;
        }
        added.push({ key, name: file.name, sizeBytes: file.size, status: 'uploading' });
        uploadMedia(file).then(
          (media) => setItems((current) => current.map((item) => (item.key === key ? { ...item, status: 'ready', mediaId: media.mediaId } : item))),
          (cause: unknown) =>
            setItems((current) =>
              current.map((item) =>
                item.key === key
                  ? { ...item, status: 'failed', error: cause instanceof Error ? cause.message : 'The upload failed.' }
                  : item,
              ),
            ),
        );
      }
      setItems((current) => [...current, ...added]);
    },
    [acceptedMimeTypes],
  );

  const remove = useCallback((key: string) => setItems((current) => current.filter((item) => item.key !== key)), []);
  const clear = useCallback(() => setItems([]), []);

  const mediaIds = useMemo(() => items.flatMap((item) => (item.status === 'ready' && item.mediaId ? [item.mediaId] : [])), [items]);
  const uploading = items.some((item) => item.status === 'uploading');

  return { items, mediaIds, uploading, add, remove, clear };
}
