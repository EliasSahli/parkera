// Hämtar NOBIL:s laddstationer för Sverige, behåller Göteborgsregionen och sparar dem i rutor
// Secret NOBIL_KEY tillagd 2026-11-25.
// (data/nobil/). Körs av nattjobbet med nyckeln som GitHub-secret NOBIL_KEY – NOBIL:s villkor
// tillåter inte att nyckeln eller API-svaren exponeras direkt i appen.
//
//   NOBIL_KEY=din-nyckel node scripts/build-nobil.mjs
import { readFile } from 'node:fs/promises';
import { parseNobil } from '../nobil.js';
import { writeSnapshot } from './build-gbg-snapshot.mjs';

const KEY = process.env.NOBIL_KEY;
const DIR = new URL('../data/nobil/', import.meta.url);
const URL_DUMP = 'https://nobil.no/api/server/datadump.php';

// Strukturen (bara fältnamn, inga värden) – hjälper felsökning om NOBIL ändrar formatet
function shapeOf(v, depth = 0) {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') {
    if (depth > 4) return '{…}';
    return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  }
  return typeof v;
}

export async function buildNobil({ key, fetchImpl = fetch } = {}) {
  const url = `${URL_DUMP}?${new URLSearchParams({ apikey: key, countrycode: 'SWE', format: 'json', file: 'false' })}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': 'parkera-bot (https://github.com/EliasSahli/parkera)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const data = JSON.parse(text.replace(/^﻿/, ''));
      const items = parseNobil(data);
      const all = Array.isArray(data) ? data : data.chargerstations || [];
      return {
        generated: new Date().toISOString(),
        counts: { sweden: all.length, region: items.length },
        reused: [],
        items,
        shape: shapeOf(all[0] ?? data),
      };
    } catch (e) {
      lastErr = e;
      // felmeddelandet kan innehålla adressen – ta bort nyckeln innan något loggas
      lastErr.message = String(e.message).split(key).join('***');
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!KEY) {
    console.log('NOBIL_KEY saknas – hoppar över laddplatser.');
    process.exit(0);
  }
  let snap;
  try {
    snap = await buildNobil({ key: KEY });
  } catch (e) {
    console.error(`NOBIL svarade inte (${e.message}) – behåller gårdagens laddplatser.`);
    process.exit(0);
  }
  if (!snap.items.length) {
    // Spara bara strukturen så att formatet kan felsökas, behåll gamla rutor
    let old = {};
    try { old = JSON.parse(await readFile(new URL('index.json', DIR), 'utf8')); } catch { /* inga */ }
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(DIR, { recursive: true });
    await writeFile(new URL('index.json', DIR), JSON.stringify({ ...old, problem: 'inga stationer tolkades', counts: snap.counts, shape: snap.shape }));
    console.error('Inga laddstationer tolkades – se data/nobil/index.json (shape).');
    process.exit(0);
  }
  const index = await writeSnapshot(snap, DIR);
  console.log(`Laddplatser: ${snap.items.length} i regionen (av ${snap.counts.sweden} i Sverige), ${Object.keys(index.cells).length} rutor`);
}
