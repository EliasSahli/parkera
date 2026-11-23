// Bygger data/gbg.json: alla Göteborgs Stads parkeringslistor, färdigtolkade.
// Körs varje natt av .github/workflows/gbg-snapshot.yml med nyckeln som GitHub-secret (GBG_APPID).
// Nyckeln finns aldrig i koden eller i den sparade filen.
//
//   GBG_APPID=din-nyckel node scripts/build-gbg-snapshot.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fromGbg } from '../core.js';

const KEY = process.env.GBG_APPID;
const OUT = new URL('../data/gbg.json', import.meta.url);
const BASE = 'https://data.goteborg.se/ParkingService/v2.1';
const LISTS = [
  ['PublicTimeParkings', 'time'],
  ['PublicTollParkings', 'toll'],
  ['PrivateTollParkings', 'private'],
  ['CommuterParkings', 'commuter'],
];

// Kortare fil: 6 decimaler (~10 cm) och inga tomma fält
const round = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : Array.isArray(v) ? v.map(round) : v);
function compact(item) {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (v == null || v === '') continue;
    if (k === 'freeSpaces') continue; // ögonblicksbilden är inte realtid
    if (k === 'geom') out.geom = v.type === 'GeometryCollection'
      ? { type: v.type, geometries: v.geometries.map((g) => ({ type: g.type, coordinates: round(g.coordinates) })) }
      : { type: v.type, coordinates: round(v.coordinates) };
    else if (k === 'lat' || k === 'lon') out[k] = round(v);
    else out[k] = v;
  }
  return out;
}

async function fetchList(ep, fetchImpl) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(`${BASE}/${ep}/${encodeURIComponent(KEY)}?format=Json`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('oväntat svar');
      return data;
    } catch (e) {
      console.warn(`${ep}: försök ${attempt} misslyckades (${e.message})`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return null;
}

export async function buildSnapshot({ fetchImpl = fetch, previous = null } = {}) {
  const items = [];
  const counts = {};
  const reused = [];
  for (const [ep, kind] of LISTS) {
    const raw = await fetchList(ep, fetchImpl);
    if (raw) {
      const list = raw.map((it) => fromGbg(it, kind)).filter(Boolean).map(compact);
      items.push(...list);
      counts[kind] = list.length;
    } else if (previous) {
      // Listan svarade inte (pendelparkeringarna har haft serverfel) – behåll gårdagens
      const old = previous.items.filter((it) => it.gbgKind === kind);
      items.push(...old);
      counts[kind] = old.length;
      reused.push(kind);
    } else {
      counts[kind] = 0;
      reused.push(kind);
    }
  }
  return { generated: new Date().toISOString(), counts, reused, items };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!KEY) {
    console.error('GBG_APPID saknas – lägg till den som secret i repots inställningar.');
    process.exit(1);
  }
  let previous = null;
  try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* första körningen */ }
  const snap = await buildSnapshot({ previous });
  if (!snap.items.length) {
    console.error('Inga data alls – behåller den gamla filen.');
    process.exit(1);
  }
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(snap));
  console.log(`Klart: ${snap.items.length} platser`, snap.counts, snap.reused.length ? `återanvända: ${snap.reused}` : '');
}
