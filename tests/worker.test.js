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
      : [{ Id: 'P', Name: 'Storgatan', Lat: 57.701, Long: 11.971, PhoneParkingCode: '4115', ParkingCost: '34 kr/tim 8-22 alla dagar' }];
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
  assert.equal(calls.length, 2);
  assert.ok(calls.every((u) => u.includes('/hemlig-nyckel?')));
  assert.ok(!JSON.stringify(body).includes('hemlig'));
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://eliassahli.github.io');
});

test('Proxy: utanför Göteborg anropas inte API:t', async () => {
  const res = await worker.fetch(req('/parking?lat=59.33&lon=18.06'), env, ctx);
  assert.deepEqual(await res.json(), { time: [], toll: [], outside: true });
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
