import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getS3Client } from './s3Client.js';

const KEY = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-one' };

test('the same region and credentials reuse one client', () => {
  // This is the whole point of the module: a fresh client per call meant a fresh HTTPS socket
  // pool per call, and nothing closed them.
  assert.equal(getS3Client('eu-west-2', KEY), getS3Client('eu-west-2', KEY));
});

test('a separate object with the same values still reuses the client', () => {
  // Call sites rebuild the credentials object from env on every request, so identity-based
  // caching would never hit.
  assert.equal(
    getS3Client('eu-west-2', { ...KEY }),
    getS3Client('eu-west-2', { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-one' }),
  );
});

test('a different region gets its own client', () => {
  assert.notEqual(getS3Client('eu-west-2', KEY), getS3Client('us-east-1', KEY));
});

test('a different key gets its own client', () => {
  assert.notEqual(
    getS3Client('eu-west-2', KEY),
    getS3Client('eu-west-2', { accessKeyId: 'AKIAOTHER', secretAccessKey: 'secret-two' }),
  );
});

test('the default credential chain is cached apart from an explicit key', () => {
  // ticketAttachments and showcall fall back to the default chain, which on the box resolves to
  // a read-only IAM user — it must never collide with the write key's client.
  const chain = getS3Client('eu-west-2');
  assert.equal(chain, getS3Client('eu-west-2', null));
  assert.notEqual(chain, getS3Client('eu-west-2', KEY));
});

test('the cached client is configured with the region it was asked for', async () => {
  assert.equal(await getS3Client('us-east-1', KEY).config.region(), 'us-east-1');
});

test('response checksum validation is off, so a destroyed body releases its socket', async () => {
  // With the SDK default ("WHEN_SUPPORTED") every GetObject body comes back wrapped in a
  // ChecksumStream, which has no `.socket` and does not pass destroy() down to the real
  // response. An aborted download then holds its socket out of this shared pool for the life
  // of the process, and the pool only holds 50: recording 51 onwards queued forever and every
  // recording in the portal went dead on 2026-10-14. "WHEN_REQUIRED" hands back the raw
  // IncomingMessage, whose destroy() actually closes the socket. Verified against live S3.
  const client = getS3Client('eu-west-2', KEY);
  const configured = client.config.responseChecksumValidation;
  const value = typeof configured === 'function' ? await configured() : configured;
  assert.equal(value, 'WHEN_REQUIRED');
});
