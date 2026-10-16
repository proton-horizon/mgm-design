import type { decodeBundle } from './bundle.mjs';

/** Stores a validated bundle under its claimed, immutable publication prefix.
 * Runs at most four writes at once. On failure, stops scheduling, waits for all
 * started writes to settle, and rejects. The caller activates only after success.
 */
export async function storePublicationFiles(
  bucket: Pick<R2Bucket, 'put'>,
  prefix: string,
  files: ReturnType<typeof decodeBundle>['files'],
): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  async function writeNext() {
    while (!failed && next < files.length) {
      const file = files[next++];
      try {
        await bucket.put(`${prefix}/${file.path}`, file.bytes, {
          httpMetadata: { contentType: file.contentType },
        });
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  }
  // Stay below the Worker's six simultaneous connection limit.
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, writeNext));
  if (failed) throw failure;
}
