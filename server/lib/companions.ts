/**
 * Catalog companions: objects that share a frame with another object.
 *
 * Imaging M42 also captures M43; imaging M51 also captures NGC 5195. The pairs
 * are precomputed from catalog coordinates into server/data/catalog-companions.json
 * (scripts/build-catalog-companions.ts), so there is no plate solving or per-night
 * geometry at runtime. See companionGeometry.ts for the field-of-view rule.
 *
 * All ids here are canonical (resolveCanonicalId), uppercase, no spaces: the
 * same form catalogs.ts keys its boards by.
 */
import table from '../data/catalog-companions.json';
import { frameRadiusDeg } from './companionGeometry.js';

interface CompanionTable { version: number; maxSepDeg: number; pairs: Record<string, Array<[string, number]>> }

const PAIRS = (table as unknown as CompanionTable).pairs;

export interface HostLink { hostId: string; sepDeg: number }

/** member canonical id -> the hosts whose frame it can fall in (closest first). */
const HOSTS_OF: Map<string, HostLink[]> = (() => {
  const m = new Map<string, HostLink[]>();
  for (const [hostId, members] of Object.entries(PAIRS)) {
    for (const [memberId, sepDeg] of members) {
      const list = m.get(memberId);
      if (list) list.push({ hostId, sepDeg });
      else m.set(memberId, [{ hostId, sepDeg }]);
    }
  }
  for (const list of m.values()) list.sort((a, b) => a.sepDeg - b.sepDeg);
  return m;
})();

/** Companions of a host (canonical id), closest first. Empty if it has none. */
export function companionsOf(hostId: string): Array<{ id: string; sepDeg: number }> {
  return (PAIRS[hostId] ?? []).map(([id, sepDeg]) => ({ id, sepDeg }));
}

/** Hosts whose frame can contain `memberId` (canonical), closest first. */
export function hostsOf(memberId: string): HostLink[] {
  return HOSTS_OF.get(memberId) ?? [];
}

/** Companions of a host that are actually in its frame, given the telescope kinds that imaged it. */
export function companionsInFrame(hostId: string, telescopeKinds: ReadonlyArray<string | null | undefined>): Array<{ id: string; sepDeg: number }> {
  const radius = frameRadiusDeg(telescopeKinds);
  return companionsOf(hostId).filter(c => c.sepDeg <= radius);
}
