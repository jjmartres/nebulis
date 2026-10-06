/**
 * LAN discovery for the "Find device" button in the Add Telescope modal.
 *
 * The server sweeps the real subnet (clamped to /22) of each of its own private
 * IPv4 LAN interfaces, skipping VPN/Docker/VM interfaces and classifies what answers:
 *
 *   - Dwarf: FTP on :21 that accepts an anonymous login and lists a
 *     DWARFLAB storage root. That listing is the proof; an open port 21 alone
 *     matches every router and NAS.
 *   - ZWO SeeStar / ASIAIR: SMB on :445 plus a ZWO signal. SMB alone matches
 *     every PC and NAS, so a host is only reported when something says it is a
 *     ZWO device: its reverse-DNS name, an answer to ZWO's UDP :4720
 *     "scan_iscope" broadcast, or its :4700 control port being open.
 *
 * Nothing is written to a device and no credentials are sent beyond the
 * anonymous FTP login the Dwarf firmware documents.
 *
 * The UDP :4720 broadcast and :4700 control port are the community-documented
 * SeeStar discovery path; they have not been verified against hardware here, so
 * hostnames are the primary signal and these two only add recall.
 */
import dgram from 'dgram';
import dns from 'dns/promises';
import net from 'net';
import os from 'os';
import { Client } from 'basic-ftp';
import { tcpProbe, SMB_PORT } from './smbReachability.js';
import { FTP_PORT } from './smb.ftp.js';
import type { TelescopeKind } from './types/telescopeKind.js';
import { log } from './logger.js';

const SEESTAR_CONTROL_PORT = 4700;
const SEESTAR_DISCOVERY_PORT = 4720;
const PROBE_TIMEOUT_MS = 700;
const CONCURRENCY = 128;
const UDP_LISTEN_MS = 1500;
const FTP_CONFIRM_TIMEOUT_MS = 4000;

export interface FoundDevice {
  host: string;
  /** Best-guess preset. For SeeStar the exact model cannot be told apart from
   *  the network, so the S50 preset is used; the user can change it. */
  kind: TelescopeKind;
  label: string;
  protocol: 'smb' | 'ftp';
  /** Reverse-DNS name, when the router published one. */
  name: string | null;
}

export interface ScanResult {
  devices: FoundDevice[];
  /** The networks swept, e.g. "192.168.1.0/24". Lets the UI explain an empty
   *  result (a Docker bridge network, say, is not the user's Wi-Fi). */
  subnets: string[];
}

/** Interfaces that are tunnels, container/VM bridges or OS plumbing, never the
 *  Wi-Fi/Ethernet a telescope sits on. Sweeping a corporate VPN or a Docker
 *  bridge is both useless and the kind of port scan an IDS flags. */
const VIRTUAL_IFACE =
  /^(lo|utun|tun|tap|ppp|wg|tailscale|zt|docker|br-|veth|virbr|vmnet|vboxnet|vnic|vethernet|wsl|hyper-v|awdl|llw|ap|gif|stf|bridge|anpi|ipsec)/i;

/** Widest block swept per interface (/22 = 1022 hosts). Larger masks are clamped. */
const MIN_PREFIX_LEN = 22;
/** Narrowest useful network; /31 and /32 are point-to-point links. */
const MAX_PREFIX_LEN = 30;

export interface ScanNetwork {
  /** Network address, e.g. "192.168.1.0". */
  base: string;
  prefixLen: number;
  /** Every usable host address in the network, as dotted-quad strings. */
  hosts: string[];
}

const ipToInt = (ip: string): number =>
  ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
const intToIp = (n: number): string =>
  [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** Prefix length of a contiguous IPv4 netmask, or null if malformed. */
function prefixLenOf(netmask: string): number | null {
  if (!net.isIPv4(netmask)) return null;
  const m = ipToInt(netmask);
  let ones = 0;
  while (ones < 32 && (m >>> (31 - ones)) & 1) ones++;
  const expected = ones === 0 ? 0 : (0xffffffff << (32 - ones)) >>> 0;
  return ones > 0 && expected === m ? ones : null;
}

/** Pure: the private LAN networks to sweep, given an `os.networkInterfaces()` map. */
export function scanNetworks(ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): ScanNetwork[] {
  const seen = new Map<string, ScanNetwork>();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const [a, b] = addr.address.split('.').map(Number);
      const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
      if (!isPrivate) continue;
      let len = prefixLenOf(addr.netmask);
      if (len === null || len > MAX_PREFIX_LEN) continue;
      len = Math.max(len, MIN_PREFIX_LEN);
      const mask = (0xffffffff << (32 - len)) >>> 0;
      const network = (ipToInt(addr.address) & mask) >>> 0;
      const key = `${network}/${len}`;
      if (seen.has(key)) continue;
      const size = 2 ** (32 - len);
      const hosts: string[] = [];
      for (let i = 1; i < size - 1; i++) hosts.push(intToIp(network + i));
      seen.set(key, { base: intToIp(network), prefixLen: len, hosts });
    }
  }
  return [...seen.values()];
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function reverseName(ip: string): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise<string[]>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 800); }),
    ]);
    return names[0] ?? null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** ZWO's UDP discovery: broadcast scan_iscope, collect the IPs that answer. */
function udpSeestarScan(): Promise<Set<string>> {
  return new Promise(resolve => {
    const found = new Set<string>();
    const sock = dgram.createSocket('udp4');
    const done = () => { try { sock.close(); } catch { /* already closed */ } resolve(found); };
    sock.on('error', done);
    sock.on('message', (_msg, rinfo) => found.add(rinfo.address));
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
        const payload = Buffer.from('{"id":201,"method":"scan_iscope","name":"nebulis","ver":"1.0"}\r\n');
        sock.send(payload, SEESTAR_DISCOVERY_PORT, '255.255.255.255');
      } catch { done(); }
    });
    setTimeout(done, UDP_LISTEN_MS);
  });
}

/** Anonymous FTP login + root listing; the Dwarf storage root is the proof. */
async function identifyDwarf(host: string): Promise<{ kind: TelescopeKind; label: string } | null> {
  const client = new Client(FTP_CONFIRM_TIMEOUT_MS);
  try {
    await client.access({ host, port: FTP_PORT, user: 'anonymous', password: '' });
    const names = (await client.list('/')).map(e => e.name.toLowerCase());
    if (names.includes('astronomy')) return { kind: 'dwarf-3', label: 'DWARFLAB Dwarf' };
    if (names.includes('dwarf_ii')) return { kind: 'dwarf-2', label: 'DWARFLAB Dwarf II' };
    if (names.includes('dwarf_mini')) return { kind: 'dwarf-mini', label: 'DWARFLAB Dwarf Mini' };
    return null;
  } catch {
    return null;
  } finally {
    client.close();
  }
}

let inFlight: Promise<ScanResult> | null = null;

/** Single-flight: a second click while a sweep runs joins it instead of
 *  doubling the socket load. */
export function scanForDevices(): Promise<ScanResult> {
  inFlight ??= runScan().finally(() => { inFlight = null; });
  return inFlight;
}

async function runScan(): Promise<ScanResult> {
  const networks = scanNetworks();
  const hosts = new Set<string>();
  for (const n of networks) for (const h of n.hosts) hosts.add(h);
  // The Dwarf AP (192.168.88.1) is covered when the server has joined its
  // Wi-Fi, because that network is then one of the swept ones. It is no longer
  // probed blindly through the default gateway.

  const udpPromise = udpSeestarScan();
  const open = new Map<string, { smb: boolean; ftp: boolean; control: boolean }>();

  await pool([...hosts], CONCURRENCY, async host => {
    const [smb, ftp, control] = await Promise.all([
      tcpProbe(host, SMB_PORT, PROBE_TIMEOUT_MS),
      tcpProbe(host, FTP_PORT, PROBE_TIMEOUT_MS),
      tcpProbe(host, SEESTAR_CONTROL_PORT, PROBE_TIMEOUT_MS),
    ]);
    if (smb !== null || ftp !== null || control !== null) {
      open.set(host, { smb: smb !== null, ftp: ftp !== null, control: control !== null });
    }
  });

  const udpHosts = await udpPromise;
  const devices: FoundDevice[] = [];

  await pool([...open.entries()], 16, async ([host, ports]) => {
    if (!net.isIPv4(host)) return;
    if (ports.ftp) {
      const dwarf = await identifyDwarf(host);
      if (dwarf) {
        devices.push({ host, ...dwarf, protocol: 'ftp', name: null });
        return;
      }
    }
    if (!ports.smb) return;
    const name = await reverseName(host);
    if (name && /asiair/i.test(name)) {
      devices.push({ host, kind: 'asiair', label: 'ZWO ASIAIR', protocol: 'smb', name });
    } else if ((name && /seestar|s50|s30/i.test(name)) || ports.control || udpHosts.has(host)) {
      devices.push({ host, kind: 'seestar-s50', label: 'ZWO SeeStar', protocol: 'smb', name });
    }
  });

  devices.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
  log.info({ subnets: networks.length, found: devices.length }, '[scan] device scan finished');
  return { devices, subnets: networks.map(n => `${n.base}/${n.prefixLen}`) };
}
