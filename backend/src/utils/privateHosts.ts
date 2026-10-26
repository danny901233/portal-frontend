/**
 * Refuse to fetch anything that resolves inside our own network.
 *
 * The scraper fetches URLs we did not choose: a garage's website from a signup form, from a
 * prospecting shortlist, and now from a Google listing's `websiteUri` — a third party's free-text
 * field. The portal runs on EC2, where a server-side fetch of http://169.254.169.254/ hands back
 * the instance role's credentials, so "it only scrapes garage websites" is not a control.
 *
 * Checking the hostname is not enough, because a public name can resolve to a private address
 * (and attacker-controlled DNS can do so deliberately). Every address the name resolves to has to
 * be public, and each redirect hop has to be checked again rather than trusted because the first
 * hop was fine.
 */
import dnsCb, { promises as dns } from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

/** Hostname suffixes that never belong to a customer's website. */
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/*
 * Explicit subnets rather than prefix arithmetic. The first version of this did its own
 * first-and-second-octet maths and missed 198.18.0.0/15 and the documentation ranges; a
 * BlockList cannot drift that way, and it understands both families the same way.
 */
const BLOCKED_V4 = new net.BlockList();
[
  ['0.0.0.0', 8],        // this host
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, incl. EC2 instance metadata
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // documentation
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // documentation
  ['203.0.113.0', 24],   // documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved
].forEach(([addr, bits]) => BLOCKED_V4.addSubnet(addr as string, bits as number, 'ipv4'));

const BLOCKED_V6 = new net.BlockList();
[
  ['::', 128],      // unspecified
  ['::1', 128],     // loopback
  ['fc00::', 7],    // unique local
  ['fe80::', 10],   // link-local
  ['fec0::', 10],   // deprecated site-local
  ['ff00::', 8],    // multicast
].forEach(([addr, bits]) => BLOCKED_V6.addSubnet(addr as string, bits as number, 'ipv6'));

/*
 * IPv6 forms that carry an IPv4 address inside them. Each has to be unwrapped and checked as IPv4,
 * or ::ffff:a9fe:a9fe reaches the metadata endpoint while looking like an IPv6 address: that is
 * the same address as 169.254.169.254.
 */
const embeddedIpv4 = (addr: string): string | null => {
  const a = addr.toLowerCase().split('%')[0];
  const dotted = a.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted && /^(::ffff:|::|64:ff9b:|64:ff9b:1:|2002:)/.test(a)) return dotted[1];
  // Hex-encoded tail: ::ffff:a9fe:a9fe, 2002:a9fe:a9fe::, 64:ff9b::a9fe:a9fe
  const hex = a.match(/^(?:::ffff:|::|64:ff9b::|64:ff9b:1::|2002:)([0-9a-f]{1,4}):([0-9a-f]{1,4})/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
    }
  }
  return null;
};

const ipv4Blocked = (ip: string): boolean => BLOCKED_V4.check(ip, 'ipv4');

const ipv6Blocked = (ip: string): boolean => {
  const addr = ip.toLowerCase().split('%')[0];
  const inner = embeddedIpv4(addr);
  if (inner && net.isIPv4(inner) && ipv4Blocked(inner)) return true;
  // 6to4 and NAT64 wrap a v4 address that may be public; anything else is judged as v6.
  return BLOCKED_V6.check(addr, 'ipv6');
};

/** True when this IP literal must never be fetched. */
export const isBlockedIp = (ip: string): boolean => {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Blocked(ip);
  if (v === 6) return ipv6Blocked(ip);
  return true; // not an address we understand, so not one we will fetch
};

/**
 * URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), which is not an address any IP
 * check recognises — so without this the literal falls through to DNS, fails to resolve and is
 * refused by accident rather than on purpose. Judged properly it is refused for the right reason,
 * and a legitimate public IPv6 literal is allowed through.
 */
const bareHost = (hostname: string): string =>
  (hostname || '').trim().replace(/^\[/, '').replace(/\]$/, '');

/** True when the hostname itself is disqualifying, before any DNS at all. */
export const isBlockedHostname = (hostname: string): boolean => {
  const h = bareHost(hostname).toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost') return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (net.isIP(h)) return isBlockedIp(h);
  return false;
};

/**
 * Throws unless every address this hostname resolves to is a public one.
 *
 * Deliberately strict: if ANY resolved address is private the name is refused outright, rather
 * than picking a public one and hoping the OS agrees when fetch connects.
 */
export const assertPublicHost = async (rawHostname: string): Promise<void> => {
  const hostname = bareHost(rawHostname);
  if (isBlockedHostname(hostname)) {
    throw new Error(`Refusing to fetch a non-public host (${hostname})`);
  }
  if (net.isIP(hostname)) return; // literal, already checked
  let records: { address: string }[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve ${hostname}`);
  }
  if (!records.length) throw new Error(`Could not resolve ${hostname}`);
  const bad = records.find((r) => isBlockedIp(r.address));
  if (bad) {
    throw new Error(`Refusing to fetch ${hostname} — it resolves to ${bad.address}`);
  }
};

/*
 * A dispatcher that validates inside the socket's own DNS resolution.
 *
 * `assertPublicHost` above is a check-then-fetch, and between the two the name can be re-resolved
 * to a private address — DNS rebinding, with a low TTL, is a deliberate technique rather than bad
 * luck. Validating in the lookup hook closes that window: the addresses that pass the check are
 * the exact addresses the socket connects to.
 */
export const safeFetchAgent = new Agent({
  connect: {
    lookup: (hostname: string, options: unknown, callback: (err: Error | null, addresses?: unknown) => void) => {
      dnsCb.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
        if (err) return callback(err);
        const list = Array.isArray(addresses) ? addresses : [];
        if (!list.length) return callback(new Error(`Could not resolve ${hostname}`));
        const bad = list.find((a) => isBlockedIp(a.address));
        if (bad) {
          return callback(new Error(`Refusing to connect to ${hostname} — it resolves to ${bad.address}`));
        }
        return callback(null, list);
      });
    },
  },
} as never);
