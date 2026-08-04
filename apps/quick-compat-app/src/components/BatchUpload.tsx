import { useRef } from 'react';
import { useArcaBatchTranscription, type BatchQueueItem } from '@arcaai/vox/compat';

interface BatchUploadProps {
  pipelineId: string;
  language: string;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusLabel(item: BatchQueueItem): string {
  if (item.status === 'uploading') return `uploading ${item.uploadProgress}%`;
  return item.status;
}

export function BatchUpload({ pipelineId, language }: BatchUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const batch = useArcaBatchTranscription({
    options: { pipelineId: pipelineId.trim() || undefined, language },
  });

  return (
    <section className="card">
      <h2>
        Batch upload{' '}
        <span className="badge off">
          {batch.activeCount > 0 ? `${batch.activeCount} active` : `${batch.items.length} file(s)`}
        </span>
      </h2>

      <div className="row">
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          multiple
          onChange={(e) => {
            if (e.target.files?.length) batch.enqueue(e.target.files);
            // Let the same file be picked again after a retry/clear.
            if (inputRef.current) inputRef.current.value = '';
          }}
        />
        <button onClick={() => batch.clear()} disabled={batch.items.length === 0}>
          Clear
        </button>
      </div>

      {batch.error ? <p className="error">{batch.error.message}</p> : null}

      <div className="transcript">
        {batch.items.length === 0 ? <p className="muted">No files queued.</p> : null}

        {batch.items.map((item) => (
          <article key={item.id} className="job">
            <div className="row between">
              <strong>{item.fileName}</strong>
              <span className="muted">
                {formatSize(item.size)} · {statusLabel(item)}
              </span>
            </div>

            {item.error ? <p className="error">{item.error}</p> : null}
            {item.text ? <p>{item.text}</p> : <p className="muted">No result yet.</p>}

            <div className="row">
              {item.status === 'failed' || item.status === 'cancelled' ? (
                <button onClick={() => batch.retry(item.id)}>Retry</button>
              ) : null}
              {item.status === 'uploading' || item.status === 'processing' ? (
                <button onClick={() => batch.cancel(item.id)}>Cancel</button>
              ) : null}
              <button onClick={() => batch.remove(item.id)}>Remove</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
