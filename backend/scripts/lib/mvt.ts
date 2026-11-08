// Minimal Mapbox Vector Tile reader for Mapillary's coverage tiles (mly1_public, z14):
// returns the points of the "image" layer with their properties. Used only by
// scripts/route-safety-generate.ts and its tests.

import protobuf from 'protobufjs';
import type { PhotoCandidate } from '../../src/safety/rating.js';

const root = protobuf.parse(`syntax = "proto2"; package vt;
message Tile {
  message Value { optional string string_value = 1; optional float float_value = 2; optional double double_value = 3; optional int64 int_value = 4; optional uint64 uint_value = 5; optional sint64 sint_value = 6; optional bool bool_value = 7; }
  message Feature { optional uint64 id = 1; repeated uint32 tags = 2 [packed = true]; optional uint32 type = 3; repeated uint32 geometry = 4 [packed = true]; }
  message Layer { required uint32 version = 15; required string name = 1; repeated Feature features = 2; repeated string keys = 3; repeated Value values = 4; optional uint32 extent = 5 [default = 4096]; }
  repeated Layer layers = 3;
}`).root;
export const TileType = root.lookupType('vt.Tile');

const VALUE_KEYS = ['stringValue', 'boolValue', 'intValue', 'uintValue', 'sintValue', 'doubleValue', 'floatValue'] as const;
/** Only fields actually present (proto2 defaults live on the prototype). 64-bit ints stay strings, so IDs keep their precision. */
function value(v: Record<string, unknown>): string | number | boolean | undefined {
  for (const k of VALUE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(v, k)) {
      const x = v[k];
      return typeof x === 'object' && x !== null ? String(x) : (x as string | number | boolean);
    }
  }
  return undefined;
}

const zigzag = (n: number) => (n >> 1) ^ -(n & 1);

/** The tile (x, y) at zoom z containing a point. */
export function tileFor(lat: number, lng: number, z: number): [number, number] {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return [Math.floor(((lng + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
}

/** Image points from one decoded tile. */
export function imagesFromTile(buf: Uint8Array, z: number, x: number, y: number): PhotoCandidate[] {
  const tile = TileType.decode(buf) as unknown as { layers: { name: string; extent: number; keys: string[]; values: Record<string, unknown>[]; features: { tags: number[]; geometry: number[] }[] }[] };
  const layer = tile.layers.find((l) => l.name === 'image');
  if (!layer) return [];
  const ext = layer.extent || 4096, n = 2 ** z, out: PhotoCandidate[] = [];
  for (const f of layer.features) {
    if (f.geometry.length < 3) continue;
    const px = zigzag(f.geometry[1]!), py = zigzag(f.geometry[2]!);
    const lng = ((x + px / ext) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / ext)) / n))) * 180) / Math.PI;
    const p: Record<string, unknown> = {};
    for (let i = 0; i + 1 < f.tags.length; i += 2) p[layer.keys[f.tags[i]!]!] = value(layer.values[f.tags[i + 1]!]!);
    if (p.id === undefined) continue;
    out.push({ id: String(p.id), lat, lng, captured_at: Number(p.captured_at ?? 0), is_pano: p.is_pano === true, sequence_id: String(p.sequence_id ?? '') });
  }
  return out;
}
