// ?bbox=west,south,east,north  (lng,lat,lng,lat, the order OSM and MapLibre use)

export type BBox = { west: number; south: number; east: number; north: number };

export function parseBbox(raw: string | undefined): { ok: true; bbox: BBox | null } | { ok: false; message: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, bbox: null };

  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return { ok: false, message: 'bbox must be four numbers: west,south,east,north' };
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    return { ok: false, message: 'bbox is out of range (lng -180..180, lat -90..90)' };
  }
  if (west >= east || south >= north) {
    return { ok: false, message: 'bbox must have west < east and south < north' };
  }
  return { ok: true, bbox: { west, south, east, north } };
}

export const inBbox = (b: BBox, lat: number, lng: number) =>
  lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
