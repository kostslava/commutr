import { Hono } from 'hono';
import { inBbox, parseBbox } from '../transit/bbox.js';
import { ATTRIBUTION } from '../transit/config.js';
import { getLiveVehicles } from '../transit/liveVehicles.js';
import { allStops } from '../transit/staticGtfs.js';

// Public transit data. These routes do not depend on the current user.
export const transitRoutes = new Hono();

transitRoutes.get('/buses/live', async (c) => {
  const parsed = parseBbox(c.req.query('bbox'));
  if (!parsed.ok) return c.json({ error: { code: 'validation_error', message: parsed.message } }, 400);

  const live = await getLiveVehicles();
  const bbox = parsed.bbox;
  const vehicles = bbox ? live.vehicles.filter((v) => inBbox(bbox, v.lat, v.lng)) : live.vehicles;
  return c.json({ source: live.source, updated_at: live.updated_at, attribution: ATTRIBUTION, vehicles });
});

transitRoutes.get('/stops', (c) => {
  const parsed = parseBbox(c.req.query('bbox'));
  if (!parsed.ok) return c.json({ error: { code: 'validation_error', message: parsed.message } }, 400);

  const bbox = parsed.bbox;
  const stops = allStops();
  return c.json({ attribution: ATTRIBUTION, stops: bbox ? stops.filter((s) => inBbox(bbox, s.lat, s.lng)) : stops });
});
