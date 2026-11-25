// Bygger data/gbg.json: alla Göteborgs Stads parkeringslistor, färdigtolkade.
// Körs varje natt av .github/workflows/gbg-snapshot.yml med nyckeln som GitHub-secret (GBG_APPID).
// Nyckeln finns aldrig i koden eller i den sparade filen.
//
//   GBG_APPID=din-nyckel node scripts/build-gbg-snapshot.mjs
// Resultat: data/gbg/index.json + en fil per ruta (se tiles.js).
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fromGbg } from '../core.js';
import { splitIntoCells } from '../tiles.js';

const KEY = process.env.GBG_APPID;
// Utdata: data/gbg/index.json (metadata + antal per ruta) och data/gbg/<ruta>.json
const DIR = new URL('../data/gbg/', import.meta.url);
const LEGACY = new URL('../data/gbg.json', import.meta.url);
const BASE = 'https://data.goteborg.se/ParkingService/v2.1';
const LISTS = [
  ['PublicTimeParkings', 'time'],
  ['PublicTollParkings', 'toll'],
  ['PrivateTollParkings', 'private'],
  ['CommuterParkings', 'commuter'],
  ['HandicapParkings', 'handicap'],
];

// Kortare fil: 5 decimaler (~1 m) och inga tomma fält
const round = (v) => (typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : Array.isArray(v) ? v.map(round) : v);
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

// Gårdagens data (för listor som inte svarar), oavsett om den sparades hel eller i rutor
async function readPrevious() {
  try {
    const index = JSON.parse(await readFile(new URL('index.json', DIR), 'utf8'));
    const items = [];
    for (const key of Object.keys(index.cells)) {
      items.push(...JSON.parse(await readFile(new URL(`${key}.json`, DIR), 'utf8')));
    }
    return { items };
  } catch { /* inga rutor än */ }
  try { return JSON.parse(await readFile(LEGACY, 'utf8')); } catch { return null; }
}

export async function writeSnapshot(snap, dir = DIR) {
  const cells = splitIntoCells(snap.items);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [key, items] of Object.entries(cells)) {
    await writeFile(new URL(`${key}.json`, dir), JSON.stringify(items));
  }
  const index = {
    generated: snap.generated,
    counts: snap.counts,
    reused: snap.reused,
    cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, v.length])),
  };
  await writeFile(new URL('index.json', dir), JSON.stringify(index));
  return index;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!KEY) {
    console.error('GBG_APPID saknas – lägg till den som secret i repots inställningar.');
    process.exit(1);
  }
  const previous = await readPrevious();
  const snap = await buildSnapshot({ previous });
  if (!snap.items.length) {
    console.error('Inga data alls – behåller de gamla filerna.');
    process.exit(1);
  }
  const index = await writeSnapshot(snap);
  await rm(LEGACY, { force: true }); // ersatt av rutorna
  console.log(`Klart: ${snap.items.length} platser i ${Object.keys(index.cells).length} rutor`, snap.counts, snap.reused.length ? `återanvända: ${snap.reused}` : '');
}
