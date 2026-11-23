// Bygger data/curated.json från den handplockade listan data/curated-source.json.
// Varje post letas upp i OpenStreetMap: först en parkering med matchande namn inom kommunen
// (ger både position och form), annars adressen via Nominatim. Körs av nattjobbet – ingen nyckel behövs.
//
//   node scripts/build-curated.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { fromOsm } from '../core.js';
import { centroid } from '../geometry.js';

const SRC = new URL('../data/curated-source.json', import.meta.url);
const OUT = new URL('../data/curated.json', import.meta.url);
const UA = 'parkera-bot (https://github.com/EliasSahli/parkera)';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpassByName(entry, fetchImpl) {
  const re = entry.osmName.replace(/"/g, '');
  const q = `[out:json][timeout:60];area["name"="${entry.municipality}"]["admin_level"="7"]->.a;` +
    `nwr["amenity"="parking"]["name"~"${re}",i](area.a);out geom;`;
  const res = await fetchImpl(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: 'data=' + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const els = (await res.json()).elements || [];
  // Störst först: flest punkter i formen ≈ största ytan
  const parsed = els.map((el) => ({ el, p: fromOsm({ ...el, tags: { ...el.tags, access: 'yes' } }) })).filter((x) => x.p);
  parsed.sort((a, b) => (b.el.geometry?.length || 0) - (a.el.geometry?.length || 0));
  return parsed[0] || null;
}

async function nominatim(address, fetchImpl) {
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q: address, format: 'jsonv2', limit: '1', countrycodes: 'se' });
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const hit = (await res.json())[0];
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
}

export async function buildCurated({ source, fetchImpl = fetch, previous = null, pause = 1100 } = {}) {
  const prevById = new Map((previous?.items || []).map((i) => [i.curatedId, i]));
  const items = [];
  const missing = [];
  for (const e of source.items) {
    let lat = null, lon = null, geom = null, osmId = null;
    try {
      if (e.osmName) {
        const hit = await overpassByName(e, fetchImpl);
        if (hit) { ({ lat, lon, geom } = hit.p); osmId = hit.p.id; }
        await sleep(pause);
      }
      if (lat == null && e.address) {
        const pos = await nominatim(e.address, fetchImpl);
        if (pos) ({ lat, lon } = pos);
        await sleep(pause); // Nominatims regler: högst ett anrop per sekund
      }
    } catch (err) {
      console.warn(`${e.name}: ${err.message}`);
    }
    if (lat == null) {
      const old = prevById.get(e.id); // behåll gårdagens position om sökningen misslyckas
      if (old) ({ lat, lon, geom, osmId } = old);
    }
    if (lat == null) { missing.push(e.name); continue; }
    const mid = geom ? centroid(geom) : null;
    items.push({
      id: `cur-${e.id}`,
      curatedId: e.id,
      source: 'curated',
      name: e.name,
      kind: 'Parkeringshus / anläggning',
      lat: mid?.lat ?? lat,
      lon: mid?.lon ?? lon,
      fee: e.price ? 'paid' : 'unknown',
      price: e.price || null,
      priceFrom: Boolean(e.priceFrom),
      capacity: e.spaces ?? null,
      access: 'public',
      operator: e.operator || null,
      extra: e.hours || null,
      municipality: e.municipality,
      sourceUrl: e.source,
      checked: e.checked,
      ...(geom ? { geom } : {}),
      ...(osmId ? { osmId } : {}),
    });
  }
  return { generated: new Date().toISOString(), items, missing };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const source = JSON.parse(await readFile(SRC, 'utf8'));
  let previous = null;
  try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* första gången */ }
  const out = await buildCurated({ source, previous });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`Handplockade: ${out.items.length} hittade${out.missing.length ? `, saknas: ${out.missing.join(', ')}` : ''}`);
}
