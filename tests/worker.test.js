import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';
import { fromGbg, shareUrl, payAppUrl } from '../core.js';

let calls;
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const data = url.includes('PublicTimeParkings')
      ? [{ Id: 'T', Name: 'Vasagatan', Lat: 57.7, Long: 11.97, MaxParkingTime: '30 min' }]
      : url.includes('PublicTollParkings')
        ? [{ Id: 'P', Name: 'Storgatan', Lat: 57.701, Long: 11.971, PhoneParkingCode: '4115', ParkingCost: '34 kr/tim 8-22 alla dagar' }]
        : url.includes('PrivateTollParkings')
          ? [{ Id: 'G', Name: 'P-hus Nordstan', Owner: 'Parkering Göteborg', FreeSpaces: 120, ParkingCost: '40 kr/tim', Lat: 57.708, Long: 11.968 }]
          : [{ Id: 'C', Name: 'Partille centrum pendel', FreeSpaces: 12, ParkingCost: 'Gratis', Lat: 57.739, Long: 12.106 }];
    return new Response(JSON.stringify(data), { status: 200 });
  };
});

const env = { GBG_APPID: 'hemlig-nyckel' };
const ctx = { waitUntil() {} };
const req = (path, origin = 'https://eliassahli.github.io') =>
  new Request('https://parkera.example.workers.dev' + path, { headers: { Origin: origin } });

test('Proxy: hämtar båda listorna och lägger nyckeln i anropet, inte i svaret', async () => {
  const res = await worker.fetch(req('/parking?lat=57.7&lon=11.97&radius=800'), env, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.time[0].Name, 'Vasagatan');
  assert.equal(body.toll[0].PhoneParkingCode, '4115');
  assert.equal(body.private[0].Name, 'P-hus Nordstan');
  assert.equal(body.commuter[0].FreeSpaces, 12);
  assert.equal(calls.length, 5);
  assert.ok(calls.every((u) => u.includes('/hemlig-nyckel?')));
  assert.ok(!JSON.stringify(body).includes('hemlig'));
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://eliassahli.github.io');
});

test('Proxy: utanför Göteborg anropas inte API:t', async () => {
  const res = await worker.fetch(req('/parking?lat=59.33&lon=18.06'), env, ctx);
  assert.deepEqual(await res.json(), { time: [], toll: [], private: [], commuter: [], outside: true });
  assert.equal(calls.length, 0);
});

test('Proxy: okänd ursprungsadress får inte CORS för sig själv', async () => {
  const res = await worker.fetch(req('/parking?lat=57.7&lon=11.97', 'https://evil.example'), env, ctx);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://eliassahli.github.io');
});

test('Proxy: saknad nyckel, felaktiga parametrar och hälsokoll', async () => {
  assert.equal((await worker.fetch(req('/parking?lat=57.7&lon=11.97'), {}, ctx)).status, 500);
  assert.equal((await worker.fetch(req('/parking?lat=x'), env, ctx)).status, 400);
  assert.deepEqual(await (await worker.fetch(req('/health'), env, ctx)).json(), { ok: true, key: true });
  assert.equal((await worker.fetch(req('/annat'), env, ctx)).status, 404);
});

test('Proxy: Göteborg nere ger 502', async () => {
  globalThis.fetch = async () => new Response('fel', { status: 503 });
  assert.equal((await worker.fetch(req('/parking?lat=57.7&lon=11.97'), env, ctx)).status, 502);
});

test('Zonkod, delningslänk och betalapp', () => {
  assert.equal(fromGbg({ Lat: 57.7, Long: 11.97, PhoneParkingCode: ' 4115 ' }, 'toll').payCode, '4115');
  assert.equal(shareUrl('https://eliassahli.github.io/parkera/?x=1#a', ''), 'https://eliassahli.github.io/parkera/');
  assert.equal(shareUrl('https://eliassahli.github.io/parkera/', 'abc'), 'https://eliassahli.github.io/parkera/?appid=abc');
  assert.equal(payAppUrl('parkster', true), 'https://www.parkster.com/app');
  assert.equal(payAppUrl('easypark', false), 'https://easypark.app.link/');
  assert.match(payAppUrl('pgbg', true), /apps\.apple\.com\/se\/app\/id1184264972/);
  assert.match(payAppUrl('pgbg', false), /play\.google\.com/);
  assert.equal(payAppUrl('okänd', true), 'https://www.parkster.com/app');
});

import { feeFromText, prepare, fromOsm, opensDirectly } from '../core.js';

test('P-hus och pendelparkeringar från Göteborgs data', () => {
  const g = fromGbg({ Id: 'G', Name: 'P-hus Nordstan', Owner: 'Parkering Göteborg', FreeSpaces: 120, ParkingCost: '40 kr/tim', Lat: 57.708, Long: 11.968 }, 'private');
  assert.equal(g.fee, 'paid');
  assert.equal(g.kind, 'Parkeringshus / anläggning');
  assert.equal(g.operator, 'Parkering Göteborg');
  const c1 = fromGbg({ Name: 'Pendel A', ParkingCost: 'Gratis', Lat: 57.7, Long: 12.1 }, 'commuter');
  const c2 = fromGbg({ Name: 'Pendel B', ParkingCost: '20 kr/dygn', Lat: 57.7, Long: 12.1 }, 'commuter');
  const c3 = fromGbg({ Name: 'Pendel C', Lat: 57.7, Long: 12.1 }, 'commuter');
  assert.deepEqual([c1.fee, c2.fee, c3.fee], ['free', 'paid', 'unknown']);
  assert.equal(feeFromText('Avgiftsfri'), 'free');
});

test('Samma p-hus från OSM och Göteborg slås ihop även om mittpunkterna skiljer 70 m', () => {
  const d = 1 / 111320;
  const gbg = fromGbg({ Id: 'G', Name: 'P-hus Nordstan', ParkingCost: '40 kr/tim', Lat: 57.708, Long: 11.968 }, 'private');
  const osm = fromOsm({ type: 'way', id: 9, center: { lat: 57.708 + 70 * d, lon: 11.968 }, tags: { amenity: 'parking', parking: 'multi-storey', fee: 'yes' } });
  const list = prepare([osm, gbg], { lat: 57.708, lon: 11.968 });
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'gbg');
});

test('Genväg för Parkering Göteborg bara på iPhone', () => {
  assert.equal(payAppUrl('pgbgShortcut', true), 'shortcuts://run-shortcut?name=Betala%20parkering');
  assert.match(payAppUrl('pgbgShortcut', false), /play\.google\.com/);
  assert.equal(opensDirectly('pgbgShortcut', true), true);
  assert.equal(opensDirectly('pgbgShortcut', false), false);
});

import { reportUrl } from '../core.js';
test('Felrapport: förifylld GitHub-issue med källtexter och tolkning', () => {
  const url = reportUrl({ id: 'gbg-private-792', name: 'Nordhemsskolan', source: 'gbg', gbgKind: 'private', lat: 57.69434, lon: 11.94924,
    price: 'P-tillstånd erfordras helgfri mån-fre 07-17.', eval: { ok: false, reason: 'kräver tillstånd' } }, { dur: 30, arrival: '2026-11-23 11:56', version: '0.8.0' });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://github.com/EliasSahli/parkera/issues/new');
  assert.equal(u.searchParams.get('title'), 'Fel vid Nordhemsskolan');
  assert.match(u.searchParams.get('body'), /Pris \(källa\): P-tillstånd erfordras/);
  assert.match(u.searchParams.get('body'), /passar inte – kräver tillstånd/);
  assert.ok(url.length < 6000);
});
