import { describe, it, expect, vi, beforeEach } from 'vitest';
import net from 'net';

const lookup = vi.fn();
vi.mock('dns/promises', () => ({ default: { lookup }, lookup }));

const { tcpProbe } = await import('../../server/lib/smbReachability.js');

describe('tcpProbe hostname resolution', () => {
  let server: net.Server;
  let port: number;

  beforeEach(async () => {
    lookup.mockReset();
    server = net.createServer(s => s.destroy());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as net.AddressInfo).port;
    return () => new Promise<void>(r => server.close(() => r()));
  });

  // A dual-stack getaddrinfo for an mDNS name waits ~5s for an AAAA answer that
  // never comes, which exceeded the probe timeout and read as "unreachable".
  it('resolves IPv4 first and does not wait on a dual-stack lookup', async () => {
    lookup.mockImplementation((host: string, opts?: { family?: number }) =>
      opts?.family === 4
        ? Promise.resolve({ address: '127.0.0.1', family: 4 })
        : new Promise(() => { /* never answers, like a missing AAAA */ }));

    const ms = await tcpProbe('probe-v4-first.local', port, 500);

    expect(ms).not.toBeNull();
    expect(lookup).toHaveBeenCalledWith('probe-v4-first.local', { family: 4 });
  });

  it('falls back to a dual-stack lookup when there is no IPv4 record', async () => {
    lookup.mockImplementation((host: string, opts?: { family?: number }) =>
      opts?.family === 4
        ? Promise.reject(Object.assign(new Error('no A'), { code: 'ENOTFOUND' }))
        : Promise.resolve({ address: '127.0.0.1', family: 4 }));

    const ms = await tcpProbe('probe-v6-only.local', port, 500);

    expect(ms).not.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
