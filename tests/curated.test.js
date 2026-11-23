import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCurated } from '../scripts/build-curated.mjs';
import { prepare } from '../core.js';
import { evaluate } from '../rules.js';

const source = JSON.parse(readFileSync(new URL('../data/curated-source.json', import.meta.url), 'utf8'));

const way = { type: 'way', id: 42, tags: { amenity: 'parking', name: 'Allum' },
  geometry: [{ lat: 57.7385, lon: 12.115 }, { lat: 57.7385, lon: 12.118 }, { lat: 57.7400, lon: 12.118 }, { lat: 57.7400, lon: 12.115 }, { lat: 57.7385, lon: 12.115 }] };

function fakeFetch(url) {
  const json = (d) => Promise.resolve({ ok: true, json: () => Promise.resolve(d) });
  if (String(url).includes('overpass')) return json({ elements: [way] });
  return json([{ lat: '57.65', lon: '12.01' }]);
}

test('handplockade: källfilen är giltig', () => {
  assert.ok(source.items.length >= 5);
  for (const e of source.items) {
    assert.ok(e.id && e.name && e.municipality && e.source && e.checked, e.id);
    assert.ok(e.osmName || e.address, `${e.id} behöver osmName eller address`);
  }
});

test('handplockade: byggs med position, form och källa', async () => {
  const out = await buildCurated({ source, fetchImpl: fakeFetch, pause: 0 });
  assert.equal(out.items.length, source.items.length);
  const allum = out.items.find((i) => i.curatedId === 'allum');
  assert.equal(allum.source, 'curated');
  assert.equal(allum.osmId, 'osm-way-42');
  assert.ok(allum.geom);
  assert.equal(allum.capacity, 1647);
  const addr = out.items.find((i) => i.curatedId === 'norra-agatan-32');
  assert.equal(addr.lat, 57.65);
});

test('handplockade: ersätter OSM-ytan i stället för att visas dubbelt', async () => {
  const out = await buildCurated({ source: { items: [source.items[0]] }, fetchImpl: fakeFetch, pause: 0 });
  const osm = { id: 'osm-way-42', source: 'osm', name: 'Allum', lat: 57.739, lon: 12.1165, fee: 'unknown', geom: out.items[0].geom };
  const res = prepare([osm, out.items[0]], { lat: 57.739, lon: 12.11 });
  assert.equal(res.length, 1);
  assert.equal(res[0].source, 'curated');
});

test('handplockade: priset räknas och visas som ungefärligt', async () => {
  const out = await buildCurated({ source, fetchImpl: fakeFetch, pause: 0 });
  const start = new Date('2026-11-24T10:00:00+01:00');
  for (const p of out.items) {
    const e = evaluate(p, start, 120);
    assert.ok(e.ok, p.name);
    assert.ok(e.cost > 0, `${p.name}: ${JSON.stringify(e)} (${p.price})`);
    assert.equal(e.approx, true);
  }
  const allum = out.items.find((i) => i.curatedId === 'allum');
  assert.equal(evaluate(allum, start, 120).cost, 14);
});

test('handplockade: misslyckad sökning behåller gårdagens position', async () => {
  const failing = () => Promise.reject(new Error('nere'));
  const previous = { items: [{ curatedId: 'allum', lat: 1, lon: 2 }] };
  const out = await buildCurated({ source: { items: [source.items[0]] }, fetchImpl: failing, previous, pause: 0 });
  assert.equal(out.items[0].lat, 1);
});
