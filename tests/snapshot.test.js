import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GBG_APPID = 'hemlig-testnyckel';
const { buildSnapshot } = await import('../scripts/build-gbg-snapshot.mjs');

const sample = {
  PublicTimeParkings: [{ Id: 'T1', Name: 'Vasagatan', MaxParkingTime: '2 tim', Lat: 57.7, Long: 11.97, WKT: 'LINESTRING (11.97 57.7, 11.971 57.7001)' }],
  PublicTollParkings: [{ Id: 'P1', Name: 'Storgatan', ParkingCost: '34 kr/tim 8-22 alla dagar. Övrig tid: 2 kr/tim', PhoneParkingCode: '801', Lat: 57.701, Long: 11.972, WKT: 'MULTILINESTRING ((11.972 57.701, 11.973 57.7012))' }],
  HandicapParkings: [{ Id: 'H1', Name: 'Kungsgatan 12', ParkingSpaces: 2, MaxParkingTime: '24 tim', Lat: 57.705, Long: 11.966, WKT: 'POINT (11.966 57.705)' }],
  PrivateTollParkings: [{ Id: '792', Name: 'Nordhemsskolan', ParkingCost: 'P-tillstånd erfordras helgfri mån-fre 07-17.', ExtraInfo: '10 kr/tim alla dagar 08-22.', Lat: 57.69434, Long: 11.94924, WKT: 'POINT (11.94924 57.69434)' }],
};
const fakeFetch = (fail = []) => async (url) => {
  const ep = Object.keys({ ...sample, CommuterParkings: 1 }).find((k) => url.includes(`/${k}/`));
  if (fail.includes(ep) || !sample[ep]) return new Response('fel', { status: 500 });
  return new Response(JSON.stringify(sample[ep]), { status: 200 });
};

test('Ögonblicksbild: alla listor tolkas, nyckeln hamnar inte i filen', async () => {
  const snap = await buildSnapshot({ fetchImpl: fakeFetch(), previous: { items: [{ id: 'gbg-commuter-C1', gbgKind: 'commuter', name: 'Gamla pendel', lat: 57.74, lon: 12.1 }] } });
  assert.equal(snap.counts.time, 1);
  assert.equal(snap.counts.toll, 1);
  assert.equal(snap.counts.private, 1);
  assert.equal(snap.counts.handicap, 1);
  const h = snap.items.find((i) => i.gbgKind === 'handicap');
  assert.equal(h.prh, true);
  assert.equal(h.fee, 'free');
  assert.deepEqual(snap.reused, ['commuter'], 'pendellistan (serverfel) återanvänds från förra natten');
  assert.ok(snap.items.some((i) => i.name === 'Gamla pendel'));
  const json = JSON.stringify(snap);
  assert.ok(!json.includes('hemlig-testnyckel'), 'nyckeln får aldrig hamna i data/gbg.json');
  const toll = snap.items.find((i) => i.name === 'Storgatan');
  assert.equal(toll.geom.type, 'MultiLineString');
  assert.equal(toll.payCode, '801');
  assert.equal(snap.items.find((i) => i.name === 'Nordhemsskolan').fee, 'paid');
  assert.ok(Date.parse(snap.generated) > 0);
}, { timeout: 30000 });

import { cellKey, cellsForRadius, splitIntoCells } from '../tiles.js';
import { haversine } from '../core.js';
import { readFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('Rutor: en sökning hittar exakt samma platser som hela filen', async () => {
  const path = new URL('../data/gbg.json', import.meta.url);
  if (!existsSync(path)) return; // riktig data finns bara lokalt/efter nattjobbet
  const all = JSON.parse(readFileSync(path, 'utf8')).items;
  const cells = splitIntoCells(all);
  for (const [lat, lon, r] of [[57.7089, 11.9746, 1500], [57.6997, 11.9759, 2500], [57.7180, 11.9440, 1000], [57.6500, 11.9100, 1500]]) {
    const direct = all.filter((p) => haversine(lat, lon, p.lat, p.lon) <= r).map((p) => p.id).sort();
    const viaCells = cellsForRadius(lat, lon, r).flatMap((k) => cells[k] || []).filter((p) => haversine(lat, lon, p.lat, p.lon) <= r).map((p) => p.id).sort();
    assert.deepEqual(viaCells, direct, `${lat},${lon}`);
  }
  // Största rutan ska vara betydligt mindre än hela filen
  const biggest = Math.max(...Object.values(cells).map((c) => JSON.stringify(c).length));
  assert.ok(biggest < JSON.stringify(all).length / 5, `största ruta ${biggest} byte`);
});

test('Rutor skrivs med index', async () => {
  const { writeSnapshot } = await import('../scripts/build-gbg-snapshot.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'gbg-'));
  const items = [{ id: 'a', lat: 57.70, lon: 11.97 }, { id: 'b', lat: 57.71, lon: 11.98 }, { id: 'c', lat: 57.80, lon: 12.10 }];
  const index = await writeSnapshot({ generated: '2026-11-23T00:00:00Z', counts: {}, reused: [], items }, pathToFileURL(dir + '/'));
  assert.equal(Object.values(index.cells).reduce((a, b) => a + b, 0), 3);
  assert.ok(readdirSync(dir).includes('index.json'));
  assert.ok(readdirSync(dir).includes(`${cellKey(57.70, 11.97)}.json`));
});
