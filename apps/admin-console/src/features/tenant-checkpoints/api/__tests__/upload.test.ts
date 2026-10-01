import { describe, expect, it, vi } from 'vitest';
import { uploadInParts, type PartResponse } from '../upload';

function init(partSizeBytes: number, count: number) {
  return {
    partSizeBytes,
    parts: Array.from({ length: count }, (_, index) => ({ partNumber: index + 1, url: `https://store/part-${index + 1}` })),
  };
}

const ok = (etag: string | null): PartResponse => ({ headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) } });

describe('uploadInParts', () => {
  it('slices the file by partSizeBytes and returns parts sorted by partNumber with their ETags', async () => {
    const file = new File([new Uint8Array(25)], 'a.hcp');
    const sizes: Record<string, number> = {};
    const putPart = vi.fn(async (url: string, blob: Blob) => {
      sizes[url] = blob.size;
      return ok(`"etag-${url.slice(-1)}"`);
    });
    // Present the parts out of order to prove the result is sorted.
    const plan = init(10, 3);
    plan.parts.reverse();
    const parts = await uploadInParts(file, plan, putPart);
    expect(sizes).toEqual({ 'https://store/part-1': 10, 'https://store/part-2': 10, 'https://store/part-3': 5 });
    expect(parts).toEqual([
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
      { partNumber: 3, etag: '"etag-3"' },
    ]);
  });

  it('reports progress after every part', async () => {
    const onProgress = vi.fn();
    await uploadInParts(new File([new Uint8Array(20)], 'a.hcp'), init(10, 2), async () => ok('"x"'), { onProgress });
    expect(onProgress.mock.calls).toEqual([[1, 2], [2, 2]]);
  });

  it('throws UPLOAD_ETAG_MISSING when the store does not expose the ETag header', async () => {
    await expect(uploadInParts(new File([new Uint8Array(5)], 'a.hcp'), init(10, 1), async () => ok(null))).rejects.toMatchObject({
      code: 'UPLOAD_ETAG_MISSING',
    });
  });

  it('stops sending further parts once the signal aborts', async () => {
    const controller = new AbortController();
    const putPart = vi.fn(async () => {
      controller.abort();
      return ok('"x"');
    });
    await expect(uploadInParts(new File([new Uint8Array(30)], 'a.hcp'), init(10, 3), putPart, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(putPart).toHaveBeenCalledTimes(1);
  });
});
