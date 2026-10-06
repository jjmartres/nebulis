/**
 * LAN address detection shared by UDP discovery and QR enrollment.
 *
 * Prefers 192.168/10.x addresses; Docker bridge addresses (172.16-31.x) are a
 * last resort because they're rarely reachable from other devices on the LAN.
 */
import os from 'os';

export function getLanIP(): string | null {
  const allPrivate: Array<{ ip: string; priority: number }> = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const [a, b] = addr.address.split('.').map(Number);
      if (a === 192 && b === 168) allPrivate.push({ ip: addr.address, priority: 0 });
      else if (a === 10) allPrivate.push({ ip: addr.address, priority: 1 });
      else if (a === 172 && b >= 16 && b <= 31) allPrivate.push({ ip: addr.address, priority: 2 });
    }
  }
  allPrivate.sort((a, b) => a.priority - b.priority);
  return allPrivate[0]?.ip ?? null;
}

/** True for hostnames that only resolve on the server box itself. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/**
 * True when a request's socket comes from this same machine: loopback, or one
 * of the machine's own interface addresses (a browser on the server box that
 * opened it by LAN IP). Reads the raw socket address, never X-Forwarded-For,
 * so it cannot be spoofed and a reverse proxy or Docker port mapping reads as
 * "another machine" — which is the right answer there, since a container sees
 * a different filesystem than the browser's host.
 */
export function isSameMachineAddress(remote: string | undefined): boolean {
  if (!remote) return false;
  const addr = remote.replace(/^::ffff:/, '');
  if (addr === '127.0.0.1' || addr === '::1') return true;
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const a of iface ?? []) {
      if (a.address === addr) return true;
    }
  }
  return false;
}
