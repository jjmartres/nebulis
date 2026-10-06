import { fetchJSON } from './client';

export type ObjectClass = 'galaxy' | 'nebula' | 'cluster' | 'other';

export interface CatalogProgressObject {
  number: number | null;
  id: string;
  ngcName: string | null;
  name: string;
  type: string;
  typeClass: ObjectClass;
  constellation: string | null;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  ra: number | null;
  dec: number | null;
  isImaged: boolean;
  libraryObjectId: string | null;
  sessionCount: number;
  /** Set when the object was not imaged itself but sits inside the frame of one
   *  that was (M43 when M42 was shot). `libraryObjectId` is then the host's. */
  imagedVia: Array<{ objectId: string; name: string; sepDeg: number }> | null;
}

export type ByTypeStats = Record<ObjectClass, { imaged: number; total: number }>;

interface CatalogProgress {
  catalog: string;
  label: string;
  total: number;
  imagedCount: number;
  /** Part of imagedCount credited through another object's frame. */
  imagedInFrameCount: number;
  byType: ByTypeStats;
  objects: CatalogProgressObject[];
}

export const getCatalogProgress = (catalog: string) =>
  fetchJSON<CatalogProgress>(`/catalogs/${encodeURIComponent(catalog)}/progress`);
