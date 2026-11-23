import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GBG_APPID = 'hemlig-testnyckel';
const { buildSnapshot } = await import('../scripts/build-gbg-snapshot.mjs');

const sample = {
  PublicTimeParkings: [{ Id: 'T1', Name: 'Vasagatan', MaxParkingTime: '2 tim', Lat: 57.7, Long: 11.97, WKT: 'LINESTRING (11.97 57.7, 11.971 57.7001)' }],
  PublicTollParkings: [{ Id: 'P1', Name: 'Storgatan', ParkingCost: '34 kr/tim 8-22 alla dagar. Övrig tid: 2 kr/tim', PhoneParkingCode: '801', Lat: 57.701, Long: 11.972, WKT: 'MULTILINESTRING ((11.972 57.701, 11.973 57.7012))' }],
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
