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
import { promises as dns } from 'node:dns';
import net from 'node:net';

/** Hostname suffixes that never belong to a customer's website. */
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

const ipv4Blocked = (ip: string): boolean => {
  const [a, b] = ip.split('.').map((n) => Number(n));
  if (a === 0 || a === 127 || a === 10) return true;             // this host, loopback, private
  if (a === 169 && b === 254) return true;                        // link-local, incl. EC2 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;               // private
  if (a === 192 && b === 168) return true;                        // private
  if (a === 100 && b >= 64 && b <= 127) return true;              // carrier-grade NAT
  if (a === 192 && b === 0) return true;                          // IETF protocol assignments
  if (a >= 224) return true;                                      // multicast and reserved
  return false;
};

const ipv6Blocked = (ip: string): boolean => {
  const addr = ip.toLowerCase().split('%')[0];
  if (addr === '::' || addr === '::1') return true;               // unspecified, loopback
  if (addr.startsWith('fe80') || addr.startsWith('fec0')) return true; // link/site-local
  if (/^f[cd]/.test(addr)) return true;                           // unique local fc00::/7
  // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 coat.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  return false;
};

/** True when this IP literal must never be fetched. */
export const isBlockedIp = (ip: string): boolean => {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Blocked(ip);
  if (v === 6) return ipv6Blocked(ip);
  return true; // not an address we understand, so not one we will fetch
};

/** True when the hostname itself is disqualifying, before any DNS at all. */
export const isBlockedHostname = (hostname: string): boolean => {
  const h = (hostname || '').toLowerCase().replace(/\.$/, '');
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
export const assertPublicHost = async (hostname: string): Promise<void> => {
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
