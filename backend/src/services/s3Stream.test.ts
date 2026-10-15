import { strict as assert } from 'node:assert';
import test from 'node:test';
import { PassThrough, Readable } from 'node:stream';
import { streamS3BodyToResponse } from './s3Stream.js';

/** An S3 body that never ends on its own, like a large object still arriving. */
const endlessBody = () => new Readable({ read() { this.push(Buffer.alloc(256)); } });

test('a client that walks away mid-stream has its S3 body destroyed', async () => {
  // The leak that took every recording down on 2026-10-14: `body.pipe(res)` left the S3 stream
  // alive when the browser aborted, holding a socket out of the shared client's pool for the
  // life of the process. Fifty of those and the next request queues forever.
  const body = endlessBody();
  const res = new PassThrough();

  const done = streamS3BodyToResponse(body, res);
  res.destroy(); // the browser cancelled the <audio> request
  await done;

  assert.equal(body.destroyed, true, 'S3 body must be destroyed so its socket returns to the pool');
});

test('a body that fails mid-stream is still destroyed', async () => {
  const body = endlessBody();
  const res = new PassThrough();

  const done = streamS3BodyToResponse(body, res);
  body.destroy(new Error('connection reset by S3'));
  await done;

  assert.equal(body.destroyed, true);
});

test('it resolves rather than rejecting when the client disconnects', async () => {
  // A disconnect is not a fault, and there is no one left to report an error to: the route has
  // already sent its headers. Rejecting here would only produce an unhandled rejection.
  const body = endlessBody();
  const res = new PassThrough();

  const done = streamS3BodyToResponse(body, res);
  res.destroy();

  await assert.doesNotReject(() => done);
});

test('a complete body reaches the response intact', async () => {
  const payload = Buffer.from('audio-bytes');
  const body = Readable.from([payload]);
  const res = new PassThrough();

  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));

  await streamS3BodyToResponse(body, res);

  assert.equal(Buffer.concat(chunks).toString(), 'audio-bytes');
  assert.equal(body.destroyed, true, 'the socket must be released on success too');
});
