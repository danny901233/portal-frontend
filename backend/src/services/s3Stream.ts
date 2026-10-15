import { pipeline } from 'node:stream';
import type { Readable, Writable } from 'node:stream';

/**
 * Pipe an S3 object body to an HTTP response, releasing the S3 socket however the transfer ends.
 *
 * `body.pipe(res)` leaves the S3 stream alive when the response closes early, and an <audio>
 * request aborts constantly: /calls points one at every row, so the browser cancels as soon as
 * the user scrolls, seeks or opens another call. Every abandoned body keeps its socket checked
 * out of the shared S3 client's pool, which holds 50, so the 51st abort wedges S3 for the whole
 * process — requests queue with no error and no timeout, and the 30s request timeout in
 * server.ts deliberately skips `/recording/` paths, so nothing ever breaks the wait. Every call
 * recording in the portal died this way on 2026-10-14.
 *
 * `pipeline` destroys both ends on early close, on error and on normal completion, which hands
 * the socket back every time. It only works because getS3Client sets
 * `responseChecksumValidation: 'WHEN_REQUIRED'`: under the SDK default the body is a
 * ChecksumStream wrapper that swallows destroy() and keeps the socket regardless, so the two
 * changes are load-bearing together and neither fixes this alone.
 *
 * Resolves rather than rejecting: the response headers are already sent by the time anything
 * here can fail, so there is no one left to tell, and a caller hanging up is not a fault.
 */
export function streamS3BodyToResponse(body: Readable, res: Writable): Promise<void> {
  return new Promise((resolve) => {
    pipeline(body, res, (err) => {
      // ERR_STREAM_PREMATURE_CLOSE is the ordinary "browser went away" case, not a failure.
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.warn('[RECORDING] stream ended early:', err.message);
      }
      resolve();
    });
  });
}
