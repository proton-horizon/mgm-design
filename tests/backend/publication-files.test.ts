import { describe, expect, it, vi } from 'vitest';
import { storePublicationFiles } from '../../worker/publication-files';

function fixture(count: number) {
  const files = Array.from({ length: count }, (_, index) => ({
    path: `screen-${index}.html`,
    bytes: new TextEncoder().encode(`<p>${index}</p>`),
    contentType: 'text/html',
  }));
  const writes: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  const put = vi.fn<R2Bucket['put']>(
    () =>
      new Promise((resolve, reject) => {
        writes.push({ resolve: () => resolve(null), reject });
      }),
  );
  return { files, writes, bucket: { put } };
}

describe('bounded publication storage', () => {
  it('overlaps writes, bounds outstanding operations, and waits for every file', async () => {
    const { files, writes, bucket } = fixture(9);
    let settled = false;
    const storing = storePublicationFiles(bucket, 'project/attempt', files).then(() => {
      settled = true;
    });
    expect(writes).toHaveLength(4);
    for (let index = 0; index < files.length; index++) {
      expect(settled).toBe(false);
      expect(writes.length - index).toBeLessThanOrEqual(4);
      writes[index].resolve();
      await Promise.resolve();
      expect(writes).toHaveLength(Math.min(index + 5, files.length));
    }
    await storing;
    expect(settled).toBe(true);
    expect(bucket.put.mock.calls).toEqual(
      files.map((file) => [
        `project/attempt/${file.path}`,
        file.bytes,
        { httpMetadata: { contentType: file.contentType } },
      ]),
    );
  });

  it('stops scheduling after failure and drains started writes before rejecting the original error', async () => {
    const { files, writes, bucket } = fixture(10);
    let settled = false;
    const firstError = new Error('storage unavailable');
    const storing = storePublicationFiles(bucket, 'project/failed', files).catch((error) => {
      settled = true;
      return error;
    });
    writes[1].reject(firstError);
    await Promise.resolve();
    expect(settled).toBe(false);
    writes[0].resolve();
    writes[2].reject(new Error('second failure'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(writes).toHaveLength(4);
    writes[3].resolve();
    expect(await storing).toBe(firstError);
    expect(writes).toHaveLength(4);
  });

  it('supports intentionally empty publications without storage calls', async () => {
    const { bucket } = fixture(0);
    await storePublicationFiles(bucket, 'project/empty', []);
    expect(bucket.put).not.toHaveBeenCalled();
  });
});
