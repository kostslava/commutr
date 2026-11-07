// Small request helpers shared by the route files.
import type { Context } from 'hono';

export const bad = (c: Context, message: string) => c.json({ error: { code: 'validation_error', message } }, 400);

export const notFound = (c: Context, what: string, id: unknown) => c.json({ error: { code: 'not_found', message: `No ${what} ${id}` } }, 404);

export async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Positive integer :id param, or null. */
export function idParam(c: Context, name = 'id'): number | null {
  const id = Number(c.req.param(name));
  return Number.isInteger(id) && id > 0 ? id : null;
}
