import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMaxStay, parsePrice, parseBans, parseDays, parseWindow, costFor, evaluate, limitWindow,
} from '../rules.js';
import { prepare, pickOptions, fromGbg, fromOsm } from '../core.js';

// Söndag 22 nov 2026 kl 20:30 och måndag 23 nov kl 07:30 (lokal tid i testmiljön)
const sun2030 = new Date(2026, 10, 22, 20, 30);
const mon0730 = new Date(2026, 10, 23, 7, 30);
const mon1200 = new Date(2026, 10, 23, 12, 0);

test('maxtid tolkas', () => {
  assert.equal(parseMaxStay('30 min'), 30);
  assert.equal(parseMaxStay('3 tim'), 180);
  assert.equal(parseMaxStay('2 timmar'), 120);
  assert.equal(parseMaxStay('2 hours'), 120);
  assert.equal(parseMaxStay('1,5 h'), 90);
  assert.equal(parseMaxStay('24 tim'), 1440);
  assert.equal(parseMaxStay('1 dygn'), 1440);
  assert.equal(parseMaxStay('PT2H'), 120);
  assert.equal(parseMaxStay(''), null);
  assert.equal(parseMaxStay('se skylt'), null);
});

test('dagar och tidsfönster', () => {
  assert.deepEqual([...parseDays('måndagar klockan 08.00')], [1]);
  assert.deepEqual([...parseDays('vardag klockan 08.00 - 22.00')].sort(), [1, 2, 3, 4, 5]);
  assert.equal(parseDays('34 kr/tim 8-22'), null);
  assert.equal(parseDays('Storgatan 8-22'), null); // "tor" i Storgatan ska inte bli torsdag
  assert.deepEqual(parseWindow('klockan 08.00 - 10.00'), { from: 480, to: 600 });
  assert.deepEqual(parseWindow('8-22'), { from: 480, to: 1320 });
});

test('pristext från Göteborg: "34 kr/tim 8-22 alla dagar. Övrig tid: 2 kr/tim"', () => {
  const p = parsePrice('34 kr/tim 8-22 alla dagar. Övrig tid: 2 kr/tim');
  assert.equal(p.rules.length, 1);
  assert.equal(p.rules[0].rate, 34);
  assert.equal(p.otherRate, 2);
  // Söndag 20:30, 3 h: 1,5 h à 34 + 1,5 h à 2 = 51 + 3 = 54
  assert.equal(costFor(p, sun2030, 180), 54);
  // Måndag 12:00, 2 h: 68 kr
  assert.equal(costFor(p, mon1200, 120), 68);
});

test('pristext utan övrig tid = gratis utanför tiderna', () => {
  const p = parsePrice('15 kr/tim vardagar 9-18');
  assert.equal(costFor(p, sun2030, 120), 0);
  assert.equal(costFor(p, mon1200, 60), 15);
});

test('okänd pristext ger null', () => {
  assert.equal(parsePrice('Avgift enligt skylt'), null);
  assert.equal(costFor(null, mon1200, 60), null);
});

test('P-förbud: "P-förbud måndagar klockan 08.00 - 10.00."', () => {
  const bans = parseBans('P-förbud måndagar klockan 08.00 - 10.00.');
  assert.equal(bans.length, 1);
  const p = { fee: 'free', extra: 'P-förbud måndagar klockan 08.00 - 10.00.' };
  assert.equal(evaluate(p, mon0730, 60).ok, false); // 07:30–08:30 krockar
  assert.match(evaluate(p, mon0730, 60).reason, /P-förbud 08\.00–10\.00/);
  assert.equal(evaluate(p, sun2030, 240).ok, true); // söndag kväll är ok
  assert.equal(evaluate(p, mon1200, 60).ok, true);
});

test('Gratis max 30 min passar inte för 2 h', () => {
  const p = { fee: 'free', maxStay: '30 min' };
  assert.deepEqual(evaluate(p, mon1200, 30), { ok: true, reason: '', cost: 0, approx: false });
  const e = evaluate(p, mon1200, 120);
  assert.equal(e.ok, false);
  assert.equal(e.reason, 'max 30 min');
});

test('Tidsgräns som bara gäller vardag 08–22 ignoreras söndag kväll', () => {
  assert.deepEqual(limitWindow('Tillåtelsen gäller vardag klockan 08.00 - 22.00.').from, 480);
  const p = { fee: 'free', maxStay: '30 min', restriction: 'Tillåtelsen gäller vardag klockan 08.00 - 22.00.' };
  assert.equal(evaluate(p, sun2030, 180).ok, true);
  assert.equal(evaluate(p, mon1200, 120).ok, false);
});

test('Avgift utan tolkbar text men med aktuell taxa ger ungefärlig kostnad', () => {
  const e = evaluate({ fee: 'paid', price: 'Se skylt', currentRate: 20 }, mon1200, 90);
  assert.equal(e.cost, 30);
  assert.equal(e.approx, true);
});

test('Kort 2 blir avgiftsparkering när närmaste är gratis (dubblettfixen)', () => {
  const d = 1 / 111320;
  const dest = { lat: 57.7, lon: 11.97 };
  const free = fromGbg({ Id: 'V', Name: 'Vasagatan', Lat: 57.7 + 70 * d, Long: 11.97 }, 'time');
  const paid = fromGbg({ Id: 'S', Name: 'Storgatan', Lat: 57.7 + 100 * d, Long: 11.97, ParkingCost: '34 kr/tim 8-22 alla dagar. Övrig tid: 2 kr/tim' }, 'toll');
  const list = prepare([free, paid], dest);
  const o = pickOptions(list);
  assert.equal(o.nearestFree.name, 'Vasagatan');
  assert.equal(o.nearest.name, 'Storgatan');
  assert.equal(o.nearestTitle, 'Närmaste avgiftsparkering');
});

test('Plats som inte passar vald tid väljs inte som förslag', () => {
  const d = 1 / 111320;
  const dest = { lat: 57.7, lon: 11.97 };
  const short = fromGbg({ Id: 'A', Name: 'Kort', Lat: 57.7 + 50 * d, Long: 11.97, MaxParkingTime: '30 min' }, 'time');
  const long = fromOsm({ type: 'node', id: 1, lat: 57.7 + 400 * d, lon: 11.97, tags: { amenity: 'parking', fee: 'no', name: 'Lång' } });
  const list = prepare([short, long], dest);
  list.forEach((p) => { p.eval = evaluate(p, mon1200, 120); });
  assert.equal(pickOptions(list).nearestFree.name, 'Lång');
});
