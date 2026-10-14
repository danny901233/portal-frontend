import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';

/**
 * Shared, lazily-built S3 clients.
 *
 * Every S3 call site used to do `new S3Client(...)` per request. Each client carries its own
 * HTTPS keep-alive socket pool, and nothing ever destroyed them, so the sockets never closed.
 * On the live box that reached 748 open connections to S3 and ~2,900 leaked socket fds, which
 * pushed kernel TCP memory to 409MB against a 364MB `tcp_mem` ceiling. Past that ceiling the
 * kernel refuses socket buffer allocations, so requests stall and retransmit rather than fail —
 * the portal went slow for everyone, and stayed slow (9,992 `TCP: out of memory` events over
 * a fortnight). The same leak held the backend at 1.5GB RSS.
 *
 * Clients are cached on their RESOLVED config, not on the call site, so a caller that resolves
 * a different region or key still gets its own client and behaviour is unchanged. Callers keep
 * reading env themselves at call time, so the process still starts with no AWS config at all
 * and a credential-less caller still falls back to the default chain.
 */

export type S3Credentials = { accessKeyId: string; secretAccessKey: string };

const clients = new Map<string, S3Client>();

/**
 * An S3 client for this region and credentials, reused across calls.
 *
 * Pass `credentials` for the explicit `S3_` or `AWS_` key (the one with write access); omit it
 * to use the default credential chain, which on the box is a read-only IAM user.
 */
export function getS3Client(region: string, credentials?: S3Credentials | null): S3Client {
  // The secret is hashed rather than used as a map key directly — it is already in this
  // process's env, but there is no reason to copy it into a long-lived key as well.
  const fingerprint = credentials
    ? createHash('sha256')
      .update(`${credentials.accessKeyId}\u0000${credentials.secretAccessKey}`)
      .digest('hex')
    : 'default-chain';
  const key = `${region}\u0000${fingerprint}`;

  const existing = clients.get(key);
  if (existing) return existing;

  const client = new S3Client({
    region,
    ...(credentials ? { credentials } : {}),
  });
  clients.set(key, client);
  return client;
}
