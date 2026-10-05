/**
 * Observing Catalog Progress API
 *
 * GET /api/v1/catalogs/:catalog/progress
 *   Returns all objects in a named observing catalog with imaged/remaining
 *   status from the user's library. Supports 'messier' initially; Caldwell
 *   and others plug in by adding an entry to CATALOG_CONFIGS below.
 */
import { Router, Request, Response } from 'express';
import { getLocalObjects } from '../lib/library/objects.js';
import { getCatalogEntry } from '../data/catalog.js';
import { prewarmThumbnails, findCachedMaster, startPrefetch, getPrefetchStatus } from '../lib/catalogPrefetch.js';
import { resolveCanonicalId } from '../lib/catalogAliases.js';
import { HERSCHEL400_IDS } from '../lib/herschel400Catalog.js';
import { SHARPLESS_CATALOG } from '../lib/sharplessCatalog.js';
import { raToHours, decToDegs } from '../lib/astroCalc.js';
import { computeBestImagingWindow, isUpTonight } from '../lib/bestImagingWindow.js';
import { classOfType } from '../lib/objectCategories.js';
import { hostsOf } from '../lib/companions.js';
import { companionKey, frameRadiusDeg } from '../lib/companionGeometry.js';
import { getAllProfiles, getSettingsData } from '../lib/telescopes.js';

const router = Router();

// ── Catalog definitions ──────────────────────────────────────────────────────

type CatalogDef = {
  label: string;
  /** Build the ordered list of catalog IDs for this observing program. */
  buildIds(): string[];
};

const CATALOG_CONFIGS: Record<string, CatalogDef> = {
  messier: {
    label: 'Messier',
    buildIds(): string[] {
      const ids: string[] = [];
      for (let n = 1; n <= 110; n++) ids.push(`M${n}`);
      return ids;
    },
  },
  caldwell: {
    label: 'Caldwell',
    buildIds(): string[] {
      const ids: string[] = [];
      for (let n = 1; n <= 109; n++) ids.push(`C${n}`);
      return ids;
    },
  },
  herschel400: {
    label: 'Herschel 400',
    buildIds(): string[] {
      return [...HERSCHEL400_IDS];
    },
  },
  sharpless: {
    label: 'Sharpless',
    buildIds(): string[] {
      // Sharpless catalog order is the Sh2-N numbering itself.
      return SHARPLESS_CATALOG.map(e => e.id);
    },
  },
};

// ── Type classification ──────────────────────────────────────────────────────

export type ObjectClass = 'galaxy' | 'nebula' | 'cluster' | 'other';

/** The coarse family for a raw type, or 'other' for everything the shared table
 *  does not claim (double stars, star clouds, an unresolved "Unknown").
 *
 *  This used to carry its own shorthand aliases (gal, neb, pn, snr, oc, cl...).
 *  None of them appear in the catalog's 22 real type strings, and `cl` also
 *  matched "Dark Cloud", so they are gone rather than ported.
 *
 *  Exported so tests exercise this function directly instead of a hand-copied
 *  mirror that can drift from it unnoticed (see git history for classifyType
 *  before it delegated to classOfType). */
export function classifyType(type: string | undefined): ObjectClass {
  return classOfType(type) ?? 'other';
}

// ── Library map helper ───────────────────────────────────────────────────────

function loadLibraryMap(localObjects: ReturnType<typeof getLocalObjects>): Map<string, { objectId: string; sessionCount: number }> {
  const map = new Map<string, { objectId: string; sessionCount: number }>();
  for (const o of localObjects) {
    const catId = typeof o.catalogId === 'string' ? o.catalogId : null;
    if (catId) {
      const key = catId.toUpperCase().replace(/\s+/g, '');
      const entry = { objectId: o.id, sessionCount: o.sessionCount };
      map.set(key, entry);
      // Also index under the canonical ID so catalog boards that iterate by
      // one designation (M82, C61) find library entries stored under another
      // (NGC3034, NGC4039) and vice-versa.
      const canonKey = resolveCanonicalId(key);
      if (canonKey !== key) map.set(canonKey, entry);
    }
  }
  return map;
}

interface FrameHost { objectId: string; name: string; sessionCount: number; kinds: Set<string> }

/** Library objects by canonical catalog key, with the telescope kinds that imaged
 *  each. A member's frame test needs the host's telescope (a Dwarf 3 frame holds
 *  more than a S50 frame), so kinds ride along. Variants of one catalog id merge. */
function loadFrameHosts(localObjects: ReturnType<typeof getLocalObjects>): Map<string, FrameHost> {
  const kindByProfile = new Map(getAllProfiles().map(p => [p.id, p.kind as string]));
  const hosts = new Map<string, FrameHost>();
  for (const o of localObjects) {
    const catId = typeof o.catalogId === 'string' ? o.catalogId : null;
    if (!catId) continue;
    const key = companionKey(catId);
    const kinds = (Array.isArray(o.telescopeIds) ? o.telescopeIds : []).map(id => kindByProfile.get(id)).filter((k): k is string => !!k);
    const existing = hosts.get(key);
    if (existing) {
      for (const k of kinds) existing.kinds.add(k);
      continue;
    }
    hosts.set(key, { objectId: o.id, name: typeof o.name === 'string' ? o.name : catId, sessionCount: o.sessionCount, kinds: new Set(kinds) });
  }
  return hosts;
}

export interface ImagedViaEntry { objectId: string; name: string; sepDeg: number }

// ── Route ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/catalogs/best-window?ra=&dec=&lat=&lon=&minAlt=
 *
 * The 12-month "best imaging window" the web client computes in-browser with
 * SunCalc, served for clients that have no sun-position math (iOS, Android).
 * `ra` is decimal hours, `dec`/`lat`/`lon` decimal degrees.
 */
router.get('/best-window', (req: Request, res: Response) => {
  const ra = Number(req.query.ra);
  const dec = Number(req.query.dec);
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const minAlt = req.query.minAlt != null ? Number(req.query.minAlt) : 20;

  if (![ra, dec, lat, lon, minAlt].every(Number.isFinite)) {
    res.apiError(400, 'BAD_REQUEST', 'ra, dec, lat and lon are required numbers');
    return;
  }

  const window = computeBestImagingWindow(ra, dec, lat, lon, minAlt);
  const upTonight = isUpTonight(ra, dec, lat, lon);

  res.apiSuccess({ ...window, upTonight });
});

router.get('/:catalog/progress', (req: Request, res: Response) => {
  const catalogKey = String(req.params.catalog).toLowerCase();
  const def = CATALOG_CONFIGS[catalogKey];
  if (!def) {
    res.apiError(404, 'UNKNOWN_CATALOG', `Catalog '${catalogKey}' is not supported`);
    return;
  }

  const ids = def.buildIds();
  const localObjects = getLocalObjects();
  const libraryMap = loadLibraryMap(localObjects);
  // Settings → Library → "Credit objects in the same frame" (default on). Off means
  // only objects with a library object of their own count as imaged.
  const creditCompanions = getSettingsData().groupCatalogCompanions !== false;
  const frameHosts = creditCompanions ? loadFrameHosts(localObjects) : new Map<string, FrameHost>();

  type ByClass = { imaged: number; total: number };
  const byType: Record<ObjectClass, ByClass> = {
    galaxy:  { imaged: 0, total: 0 },
    nebula:  { imaged: 0, total: 0 },
    cluster: { imaged: 0, total: 0 },
    other:   { imaged: 0, total: 0 },
  };

  let imagedCount = 0;
  let imagedInFrameCount = 0;

  const objects = ids.map((rawId) => {
    const key = rawId.toUpperCase().replace(/\s+/g, '');
    const canonKey = resolveCanonicalId(key);

    // Sharpless entries carry no constellation or magnitude of their own, so
    // when an object cross-references a Messier/NGC/IC target, prefer that
    // richer entry and fall back to the bare Sharpless record otherwise.
    let entry = getCatalogEntry(key);
    if (catalogKey === 'sharpless' && canonKey !== key) {
      entry = getCatalogEntry(canonKey) ?? entry;
    }

    // Parse the catalog number from the ID string (M-number for Messier,
    // C-number for Caldwell, Sh2-N for Sharpless).
    const numMatch = rawId.match(/^(?:M|C|SH2-)(\d+)$/i);
    const catalogNum = numMatch ? parseInt(numMatch[1], 10) : null;

    const type = entry?.type ?? 'Unknown';
    const cls = classifyType(type);

    const libEntry = libraryMap.get(key) ?? libraryMap.get(canonKey);

    // Not imaged on its own, but sitting inside the frame of something that was:
    // M43 when M42 was shot. Looked up in the precomputed companion table, so no
    // geometry runs here. Direct imaging always wins and leaves this empty.
    const imagedVia: ImagedViaEntry[] = [];
    if (!libEntry && creditCompanions) {
      for (const link of hostsOf(companionKey(canonKey))) {
        const host = frameHosts.get(link.hostId);
        if (host && link.sepDeg <= frameRadiusDeg([...host.kinds])) {
          imagedVia.push({ objectId: host.objectId, name: host.name, sepDeg: link.sepDeg });
        }
      }
    }
    const inFrame = imagedVia.length > 0;
    const isImaged = libEntry != null || inFrame;

    byType[cls].total++;
    if (isImaged) {
      imagedCount++;
      byType[cls].imaged++;
      if (inFrame) imagedInFrameCount++;
    }

    // Resolve a user-friendly name: prefer the first common name, then the
    // catalog name, then fall back to the raw id.
    const commonName =
      (entry as { commonNames?: string[] } | undefined)?.commonNames?.[0] ??
      entry?.name ??
      rawId;

    return {
      number: catalogNum,
      id: rawId,
      ngcName: canonKey !== key ? canonKey : null,
      name: commonName,
      type,
      typeClass: cls,
      constellation: entry?.constellation ?? null,
      magnitude: entry?.magnitude ?? null,
      majorAxisArcmin:
        (entry as { majorAxisArcmin?: number | null } | undefined)?.majorAxisArcmin ?? null,
      // RA in decimal HOURS — the catalog board, object modal ("RA …h"),
      // best-imaging-window math, and plan-to-session flow all expect hours.
      // raToDegs would (inconsistently) return degrees for curated sexagesimal
      // entries while leaving decimal-hours strings untouched, which is what
      // stored degree-valued RA in plannedSessions for Messier objects.
      ra: entry?.ra != null ? raToHours(entry.ra) : null,
      dec: entry?.dec != null ? decToDegs(entry.dec) : null,
      isImaged,
      // For an in-frame credit this is the host's object, so "View observations"
      // opens the images the object is actually in.
      libraryObjectId: libEntry?.objectId ?? imagedVia[0]?.objectId ?? null,
      sessionCount: libEntry?.sessionCount ?? 0,
      imagedVia: inFrame ? imagedVia : null,
    };
  });

  res.apiSuccess({
    catalog: catalogKey,
    label: def.label,
    total: ids.length,
    imagedCount,
    // How many of imagedCount come from another object's frame rather than a
    // library object of their own.
    imagedInFrameCount,
    byType,
    objects,
  });

  // Fire-and-forget: pre-warm thumbnails for objects that already have a
  // cached master, and — for Caldwell — trigger the image download phase if
  // most objects are still missing their master. The pack updater runs 60s
  // after startup, but users who visited the Caldwell board before that fires,
  // or whose pack download failed, would see blank tiles indefinitely.
  void (async () => {
    let mastersMissing = 0;
    for (const rawId of ids) {
      try {
        const canonId = resolveCanonicalId(rawId);
        const master = findCachedMaster(canonId, null);
        if (master) {
          await prewarmThumbnails(canonId, master.path, master.source);
        } else {
          mastersMissing++;
        }
      } catch { /* non-fatal */ }
    }

    // If more than half the catalog has no master and nothing is already
    // running, kick the appropriate prefetch phase so images appear without
    // the user having to manually start a prefetch from Settings.
    if (mastersMissing > ids.length / 2 && !getPrefetchStatus().running) {
      if (catalogKey === 'caldwell') {
        startPrefetch({ phase: 'caldwell' });
      } else {
        startPrefetch({ packsOnly: true });
      }
    }
  })();
});

export { router as catalogsRouter };
