/**
 * Tyre stock for the unified chat agent.
 *
 * The Tyresoft adapter filters an injected inventory, and chooseDiary was constructing it
 * with the default empty array — so every tyre search matched nothing and quietly returned
 * "we have none in that size". This loads the same two depot CSVs the production Tyresoft
 * chat agent reads, and maps them to the snake_case keys the adapter filters on.
 *
 * Read-only: it touches the same files as chatAgentTyresoft.ts but nothing in it.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/** depot id → rows, parsed once per process. */
const CACHE = new Map<number, Array<Record<string, any>>>();

/** "2 Days" → 2; "In Stock", "0", "" → 0. */
function leadTimeDays(raw: string): number {
  const m = /(\d+)/.exec(raw || '');
  return m ? Number(m[1]) : 0;
}

function parseDepot(file: string): Array<Record<string, any>> {
  let content: string;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    console.warn(`[UNIFIED_CHAT] tyre CSV not found: ${file}`);
    return [];
  }
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  const idx = (name: string) => headers.findIndex((h) => h.trim() === name);

  const i = {
    stock: idx('Product Stock Number'), title: idx('Product Title'), retail: idx('Retail'),
    width: idx('Width'), aspect: idx('Aspect Ratio'), rim: idx('Rim'),
    brand: idx('Brand Name'), lead: idx('Product Channel Lead Time'),
  };

  const rows: Array<Record<string, any>> = [];
  for (let n = 1; n < lines.length; n += 1) {
    const c = lines[n].split(',');
    if (c.length < 5) continue;
    rows.push({
      stock_number: c[i.stock]?.trim() ?? '',
      title: c[i.title]?.trim() ?? '',
      price: parseFloat(c[i.retail] ?? '0') || 0,
      width: c[i.width]?.trim() ?? '',
      aspect_ratio: c[i.aspect]?.trim() ?? '',
      rim: c[i.rim]?.trim() ?? '',
      brand: c[i.brand]?.trim() ?? '',
      lead_time_days: leadTimeDays(c[i.lead]?.trim() ?? ''),
    });
  }
  return rows;
}

/** Depot for a garage, defaulting to 1 the way the production agent does. */
export function tyreStockFor(depotId: unknown): Array<Record<string, any>> {
  const depot = Number(depotId) || 1;
  if (!CACHE.size) {
    const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');
    CACHE.set(1, parseDepot(join(dataDir, 'tyresoft-products-depot-1.csv')));
    CACHE.set(3, parseDepot(join(dataDir, 'tyresoft-products-depot-2.csv')));
    console.log(`[UNIFIED_CHAT] tyre stock loaded: depot1=${CACHE.get(1)!.length}, `
      + `depot3=${CACHE.get(3)!.length}`);
  }
  return CACHE.get(depot) ?? CACHE.get(1) ?? [];
}
