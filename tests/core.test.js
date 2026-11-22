import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromOsm, fromGbg, prepare, pickOptions, applyFilters, navUrl, haversine, feeLabel, formatDistance,
} from '../core.js';

// Mål: Kungsportsplatsen, Göteborg
const dest = { lat: 57.7045, lon: 11.9700, label: 'Kungsportsplatsen' };
const off = (m) => m / 111320; // meter -> grader latitud

const osm = [
  { type: 'way', id: 1, center: { lat: dest.lat + off(120), lon: dest.lon }, tags: { amenity: 'parking', fee: 'yes', parking: 'multi-storey', name: 'P-hus Nordstan', capacity: '450' } },
  { type: 'node', id: 2, lat: dest.lat + off(60), lon: dest.lon, tags: { amenity: 'parking', access: 'private' } },
  { type: 'way', id: 3, center: { lat: dest.lat - off(400), lon: dest.lon }, tags: { amenity: 'parking', fee: 'no', maxstay: '2 hours' } },
  { type: 'way', id: 4, center: { lat: dest.lat - off(250), lon: dest.lon }, tags: { amenity: 'parking', fee: 'no', access: 'customers', name: 'ICA kundparkering' } },
  { type: 'node', id: 5, lat: dest.lat + off(90), lon: dest.lon, tags: { amenity: 'parking' } },
  { type: 'node', id: 6, lat: dest.lat, lon: dest.lon, tags: { amenity: 'bench' } },
];

test('OSM: privat och icke-parkering filtreras bort', () => {
  const list = osm.map(fromOsm).filter(Boolean);
  assert.equal(list.length, 4);
  assert.ok(!list.some((p) => p.id === 'osm-node-2'));
});

test('OSM: avgiftsstatus tolkas', () => {
  const by = Object.fromEntries(osm.map(fromOsm).filter(Boolean).map((p) => [p.id, p]));
  assert.equal(by['osm-way-1'].fee, 'paid');
  assert.equal(by['osm-way-3'].fee, 'free');
  assert.equal(by['osm-node-5'].fee, 'unknown');
  assert.equal(by['osm-way-4'].access, 'customers');
  assert.equal(by['osm-way-1'].kind, 'Parkeringshus');
  assert.equal(by['osm-way-1'].capacity, 450);
});

test('Tre val: närmaste föredrar känd avgift, gratis hoppar över kundparkering', () => {
  const list = prepare(osm.map(fromOsm), dest);
  assert.deepEqual(list.map((p) => p.id), ['osm-node-5', 'osm-way-1', 'osm-way-4', 'osm-way-3']);
  const { nearest, nearestFree } = pickOptions(list);
  assert.equal(nearest.id, 'osm-way-1'); // 120 m och känd avgift slår 90 m okänd
  assert.equal(nearestFree.id, 'osm-way-3'); // 400 m publik gratis, inte ICA 250 m
});

test('Okänd avgift nära slår känd avgift långt bort', () => {
  const near = fromOsm({ type: 'node', id: 20, lat: dest.lat + off(50), lon: dest.lon, tags: { amenity: 'parking' } });
  const far = fromOsm({ type: 'node', id: 21, lat: dest.lat + off(700), lon: dest.lon, tags: { amenity: 'parking', fee: 'yes' } });
  assert.equal(pickOptions(prepare([near, far], dest)).nearest.id, near.id);
});

test('Göteborgs data: gratis tidsparkering och fullt objekt', () => {
  const time = fromGbg({ Id: 'A', Name: 'Södra Larmg', Lat: dest.lat + off(150), Long: dest.lon, MaxParkingTime: '2 tim', ParkingSpaces: 12 }, 'time');
  const fullToll = fromGbg({ Id: 'B', Name: 'Kungsg', Lat: String(dest.lat + off(30)), Long: String(dest.lon), CurrentParkingCost: 40, FreeSpaces: 0 }, 'toll');
  assert.equal(time.fee, 'free');
  assert.equal(time.maxStay, '2 tim');
  assert.equal(fullToll.price, '40 kr/h');
  const list = prepare([...osm.map(fromOsm), time, fullToll], dest);
  const { nearest, nearestFree } = pickOptions(list);
  assert.notEqual(nearest.id, fullToll.id, 'fullt objekt ska inte föreslås');
  assert.equal(nearestFree.id, time.id, 'kommunal gratisparkering 150 m slår OSM 400 m');
});

test('Dubbletter inom 25 m slås ihop och kommunal data vinner', () => {
  const a = fromOsm({ type: 'node', id: 9, lat: dest.lat + off(150), lon: dest.lon, tags: { amenity: 'parking', fee: 'no' } });
  const b = fromGbg({ Id: 'C', Lat: dest.lat + off(160), Long: dest.lon }, 'time');
  const list = prepare([a, b], dest);
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'gbg');
});

test('Filter: avstånd och avgift', () => {
  const list = prepare(osm.map(fromOsm), dest);
  assert.equal(applyFilters(list, { maxDistance: 200 }).length, 2);
  assert.ok(applyFilters(list, { fee: 'free' }).every((p) => p.fee === 'free'));
  assert.ok(applyFilters(list, { fee: 'paid' }).every((p) => p.fee === 'paid'));
});

test('Djuplänkar för navigation', () => {
  assert.match(navUrl('apple', 57.7, 11.97), /^https:\/\/maps\.apple\.com\/\?daddr=57\.700000,11\.970000&dirflg=d/);
  assert.match(navUrl('google', 57.7, 11.97), /destination=57\.700000,11\.970000&travelmode=driving/);
  assert.match(navUrl('waze', 57.7, 11.97), /ll=57\.700000,11\.970000&navigate=yes/);
});

test('Hjälpfunktioner', () => {
  assert.ok(Math.abs(haversine(57.7, 11.97, 57.7 + off(1000), 11.97) - 1000) < 2);
  assert.equal(formatDistance(1234), '1,2 km');
  assert.equal(formatDistance(347), '350 m');
  assert.equal(feeLabel({ fee: 'free', maxStay: '2 hours' }), 'Gratis · max 2 hours');
  assert.equal(feeLabel({ fee: 'unknown' }), 'Avgift okänd');
});

import { freshFreeSpaces, parseGbgDate } from '../core.js';

test('Göteborg: lediga platser bara om uppgiften är färsk', () => {
  const now = Date.parse('2026-11-22T20:00:00+01:00');
  assert.equal(freshFreeSpaces({ FreeSpaces: 12 }, now), 12);
  assert.equal(freshFreeSpaces({ FreeSpaces: 12, FreeSpacesDate: '2026-11-22T19:45:00+01:00' }, now), 12);
  assert.equal(freshFreeSpaces({ FreeSpaces: 12, FreeSpacesDate: '2026-11-22T18:00:00+01:00' }, now), null);
  assert.equal(freshFreeSpaces({ FreeSpaces: 5, FreeSpacesDate: `/Date(${now - 60000}+0100)/` }, now), 5);
  assert.equal(parseGbgDate('/Date(1700000000000+0100)/'), 1700000000000);
  assert.equal(freshFreeSpaces({}, now), null);
});

test('Göteborg: pris föredrar textbeskrivning', () => {
  const p = fromGbg({ Lat: 57.7, Long: 11.97, ParkingCost: '25 kr/tim vardagar 9-18', CurrentParkingCost: 25 }, 'toll');
  assert.equal(p.price, '25 kr/tim vardagar 9-18');
});
