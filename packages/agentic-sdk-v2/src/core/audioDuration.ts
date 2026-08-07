'use client';

/**
 * @arcaai/vox - browser audio duration probe (TASK-604)
 *
 * Reads a local file's duration through a detached `<audio>` element, so the
 * batch queue can refuse an over-long recording BEFORE uploading it. Without
 * this, a 60-minute file that the gateway will reject still costs the user
 * ~115 MB of upload first.
 *
 * This is an OPTIMISATION, not the enforcement point. The gateway measures the
 * same duration from the container header and is authoritative — a browser that
 * cannot decode a container (`null` here) does not get a free pass, it just
 * finds out server-side instead.
 *
 * `null` means "unknown", never "zero". `Infinity` — what `MediaRecorder`
 * output commonly reports until it has been fully seeked — is unknown too.
 */

export interface ProbeAudioDurationOptions {
  /**
   * Give up after this long. A media element that never fires either event
   * would otherwise pin a queue slot forever.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Duration of `file` in seconds, or `null` when it cannot be established. */
export function probeAudioDurationSeconds(file: Blob, options: ProbeAudioDurationOptions = {}): Promise<number | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<number | null>((resolve) => {
    let url: string | null = null;
    let audio: HTMLAudioElement | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    // One exit path for every outcome, so the object URL is released exactly
    // once — a leaked blob URL pins the whole file in memory.
    const settle = (value: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (audio) {
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('error', onError);
        // Drop the source so the element stops holding the blob.
        try {
          audio.src = '';
        } catch {
          /* detached element; nothing to release */
        }
      }
      if (url) URL.revokeObjectURL(url);
      resolve(value);
    };

    const onLoaded = () => {
      const seconds = audio?.duration ?? Number.NaN;
      settle(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    };
    const onError = () => settle(null);

    try {
      audio = document.createElement('audio');
      // Metadata is all we need; never pull the media itself.
      audio.preload = 'metadata';
      audio.addEventListener('loadedmetadata', onLoaded);
      audio.addEventListener('error', onError);
      url = URL.createObjectURL(file);
      audio.src = url;
      audio.load?.();
      timer = setTimeout(() => settle(null), timeoutMs);
    } catch {
      // No DOM (SSR/Node) or no object-URL support — unknown, not an error.
      settle(null);
    }
  });
}
