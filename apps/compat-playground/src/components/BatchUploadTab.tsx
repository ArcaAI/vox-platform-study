import { BatchJobQueue } from './batch/BatchJobQueue';
import { BatchJobResult } from './batch/BatchJobResult';
import { BatchUploadPanel } from './batch/BatchUploadPanel';
import { BATCH_UPLOAD_EXAMPLE_FILES, TabExampleCode } from './TabExampleCode';

/**
 * Tab 4 — batch upload (TASK-603).
 *
 * Layout only, same shape as the Live-transcription tab: controls left, results
 * right, single column below `xl`. All state comes from
 * `usePlaygroundSession().batch`, which is mounted above the tabs — so an
 * upload started here keeps running (and keeps streaming results) while the
 * developer works in another tab.
 */
export function BatchUploadTab() {
  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        <BatchUploadPanel />
        <BatchJobQueue />
      </div>
      <BatchJobResult />
      <div className="xl:col-span-2">
        <TabExampleCode
          files={BATCH_UPLOAD_EXAMPLE_FILES}
          description="The batch path end to end: the upload queue hook, per-file job dispatch with progress, the SSE result stream, and the hand-off into summarization."
        />
      </div>
    </div>
  );
}
