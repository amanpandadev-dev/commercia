// Addresses and ranges: who is calling, and whether they are in a list of allowed networks.
import net from 'node:net';

/** "::ffff:192.168.1.5" is the same machine as "192.168.1.5". */
export function normalizeIp(ip: string): string {
  const s = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : s.toLowerCase();
}

export const LOOPBACK = ['127.0.0.0/8', '::1/128'];
/** Private networks, the Tailscale range, and IPv6 local addresses: the shop's own Wi-Fi and Tailscale, never the open internet. */
export const PRIVATE_RANGES = [...LOOPBACK, '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', 'fc00::/7', 'fe80::/10'];

export function isValidRange(s: string): boolean {
  const [addr, bits] = s.trim().split('/');
  const v = net.isIP(normalizeIp(addr));
  if (!v) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return /^\d+$/.test(bits) && n >= 0 && n <= (v === 4 ? 32 : 128);
}

/** A list of addresses and ranges ("192.168.1.0/24", "10.0.0.7", "fd00::/8") that can be asked about an address. */
export class IpSet {
  private list = new net.BlockList();
  constructor(ranges: string[]) {
    for (const r of ranges) {
      const [addr, bits] = r.trim().split('/');
      const a = normalizeIp(addr);
      const type = net.isIP(a) === 6 ? 'ipv6' : 'ipv4';
      if (bits === undefined) this.list.addAddress(a, type);
      else this.list.addSubnet(a, Number(bits), type);
    }
  }
  has(ip: string): boolean {
    const a = normalizeIp(ip);
    const v = net.isIP(a);
    return v ? this.list.check(a, v === 6 ? 'ipv6' : 'ipv4') : false;
  }
}

const sets = new Map<string, IpSet>();
/** Cached by contents: the list is checked on every request. */
export function ipSet(ranges: string[]): IpSet {
  const key = ranges.join(',');
  let s = sets.get(key);
  if (!s) sets.set(key, (s = new IpSet(ranges)));
  return s;
}
