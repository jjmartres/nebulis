import { describe, it, expect } from 'vitest';
import os from 'os';
import { scanNetworks } from '../../server/lib/deviceScan.js';

type Ifaces = ReturnType<typeof os.networkInterfaces>;
const v4 = (address: string, netmask: string) =>
  ({ address, netmask, family: 'IPv4', internal: false, mac: '', cidr: null }) as os.NetworkInterfaceInfo;

describe('scanNetworks', () => {
  it('sweeps a plain /24 LAN', () => {
    const [n] = scanNetworks({ en0: [v4('192.168.1.20', '255.255.255.0')] } as Ifaces);
    expect(n.base).toBe('192.168.1.0');
    expect(n.hosts).toHaveLength(254);
    expect(n.hosts[0]).toBe('192.168.1.1');
    expect(n.hosts.at(-1)).toBe('192.168.1.254');
  });

  it('skips VPN, Docker and VM interfaces', () => {
    const nets = scanNetworks({
      utun3: [v4('10.8.0.5', '255.255.255.0')],
      docker0: [v4('172.17.0.1', '255.255.0.0')],
      'br-abc': [v4('172.18.0.1', '255.255.0.0')],
      'vEthernet (WSL)': [v4('172.20.0.1', '255.255.240.0')],
      en0: [v4('192.168.1.20', '255.255.255.0')],
    } as Ifaces);
    expect(nets.map(n => n.base)).toEqual(['192.168.1.0']);
  });

  it('uses the real netmask: a /28 is 14 hosts, not 254', () => {
    const [n] = scanNetworks({ eth0: [v4('10.0.0.5', '255.255.255.240')] } as Ifaces);
    expect(n.hosts).toHaveLength(14);
    expect(n.hosts.every(h => h.startsWith('10.0.0.'))).toBe(true);
  });

  it('skips point-to-point /31 and /32 links', () => {
    expect(scanNetworks({ eth0: [v4('10.0.0.5', '255.255.255.254')] } as Ifaces)).toEqual([]);
  });

  it('covers a /23 fully and clamps wider masks to /22', () => {
    const [a] = scanNetworks({ en0: [v4('192.168.0.9', '255.255.254.0')] } as Ifaces);
    expect(a.hosts).toHaveLength(510);
    const [b] = scanNetworks({ en0: [v4('10.1.2.3', '255.255.0.0')] } as Ifaces);
    expect(b.prefixLen).toBe(22);
    expect(b.hosts).toHaveLength(1022);
    expect(b.base).toBe('10.1.0.0');
  });

  it('ignores public, loopback-style and malformed addresses and dedupes', () => {
    const nets = scanNetworks({
      en0: [v4('192.168.1.20', '255.255.255.0'), v4('192.168.1.21', '255.255.255.0'), v4('8.8.8.8', '255.255.255.0'), v4('192.168.2.1', 'bogus')],
    } as Ifaces);
    expect(nets).toHaveLength(1);
  });
});
