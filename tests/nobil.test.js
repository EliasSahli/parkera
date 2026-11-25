import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNobil, fromNobil, parsePosition, attachChargers, chargingText } from '../nobil.js';
import { buildNobil } from '../scripts/build-nobil.mjs';

const a = (id, valid) => ({ attrtypeid: String(id), attrname: 'x', attrvalid: String(valid), trans: 'x', attrval: '' });
const station = (id, pos, { avail = 1, fee = 2, conns = [[32, 11], [32, 11], [39, 24]], status = 1 } = {}) => ({
  csmd: { id, name: `Station ${id}`, Street: 'Kungsgatan', House_number: '1', City: 'Göteborg', Position: pos,
    Number_charging_points: conns.length, Owned_by: 'Göteborg Energi', Station_status: status },
  attr: {
    st: { 2: a(2, avail), 3: a(3, 2), 7: a(7, fee), 24: a(24, 1) },
    conn: Object.fromEntries(conns.map(([t, k], i) => [String(i + 1), { 4: a(4, t), 5: a(5, k) }])),
  },
});

test('NOBIL: position och region', () => {
  assert.deepEqual(parsePosition('(57.70681,11.96861)'), { lat: 57.70681, lon: 11.96861 });
  assert.equal(fromNobil(station(1, '(59.9,10.7)')), null); // Oslo – utanför regionen
});

test('NOBIL: uttag, effekt och avgift tolkas', () => {
  const s = fromNobil(station(7, '(57.7068,11.9686)'));
  assert.equal(s.id, 'nobil-7');
  assert.deepEqual(s.charging, { points: 3, maxKw: 150, connectors: { 'Typ 2': 2, CCS: 1 } });
  assert.equal(s.parkingFee, false);
  assert.equal(s.location, 'Parkering');
  assert.match(chargingText(s.charging), /3 uttag · upp till 150 kW/);
});

test('NOBIL: privata, ur drift och vätgas sorteras bort', () => {
  assert.equal(fromNobil(station(2, '(57.7,11.97)', { avail: 3 })), null);
  assert.equal(fromNobil(station(4, '(57.7,11.97)', { conns: [[70, 26]] })), null);
  assert.equal(fromNobil(station(5, '(57.7,11.97)', { avail: 2 })).access, 'customers');
});

test('NOBIL: hela svaret, med BOM och utan', () => {
  const body = JSON.stringify({ Provider: 'NOBIL', Rights: 'CC BY', apiver: '3', chargerstations: [station(1, '(57.7,11.97)'), station(2, '(59.9,10.7)')] });
  assert.equal(parseNobil('﻿' + body).length, 1);
  assert.equal(parseNobil(JSON.parse(body).chargerstations).length, 1);
});

test('NOBIL: laddare kopplas till parkeringen den står på, övriga blir egna', () => {
  const dest = { lat: 57.7, lon: 11.97 };
  const sq = { type: 'Polygon', coordinates: [[[11.969, 57.6995], [11.971, 57.6995], [11.971, 57.7005], [11.969, 57.7005], [11.969, 57.6995]]] };
  const parking = { id: 'osm-way-1', source: 'osm', name: 'P', lat: 57.7, lon: 11.97, geom: sq, fee: 'paid', distance: 0, access: 'public' };
  const inside = fromNobil(station(1, '(57.7001,11.9701)'));
  const far = fromNobil(station(2, '(57.71,11.99)', { fee: 2 }));
  const res = attachChargers([parking], [inside, far], dest);
  assert.equal(res.length, 2);
  assert.equal(res[0].charging.points, 3);
  assert.equal(res[1].evOnly, true);
  assert.equal(res[1].fee, 'unknown'); // NOBIL:s avgiftsuppgift är inte pålitlig
  assert.ok(res[1].distance > 1000);
  assert.equal(attachChargers([parking], [], dest)[0], parking);
});

test('NOBIL: nattjobbet läcker inte nyckeln i fel eller data', async () => {
  const KEY = 'hemlig-nyckel-123';
  const ok = await buildNobil({ key: KEY, fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ chargerstations: [station(1, '(57.7,11.97)')] }) }) });
  assert.equal(ok.items.length, 1);
  assert.ok(!JSON.stringify(ok).includes(KEY));
  await assert.rejects(
    buildNobil({ key: KEY, fetchImpl: async (u) => { throw new Error(`fetch failed ${u}`); } }),
    (e) => !e.message.includes(KEY),
  );
});
