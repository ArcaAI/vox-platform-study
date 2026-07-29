'use client';

import { DetailDrawer } from '@/shared/detail/detail-drawer';
import type { StorageObject } from '../api/types';
import { objectBasename } from './file-meta';
import { SelectedObjectActions } from './object-actions-panel';

/**
 * Frame 31 object-actions surface (redesign build spec §3): the presigned-URL
 * actions for a selected object move out of the old right rail into the
 * console-wide `DetailDrawer` (size `md`). A file row click — or the `?object=`
 * deep-link — opens it; folder rows still navigate the prefix.
 */
export function ObjectDetailDrawer({
  bucketName,
  object,
  onOpenChange,
  onDeleted,
}: {
  bucketName: string;
  object: StorageObject | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  return (
    <DetailDrawer open={object !== null} onOpenChange={onOpenChange} size="md" title={object ? objectBasename(object.key) : 'Object'}>
      {object ? <SelectedObjectActions key={object.key} bucketName={bucketName} object={object} onDeleted={onDeleted} /> : null}
    </DetailDrawer>
  );
}
