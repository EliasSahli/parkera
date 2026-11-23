// Regressionstester med VERKLIGA regeltexter ur Göteborgs Stads ParkingService
// (insamlade 2026-11-22). Varje test motsvarar ett problem i testrapporten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMaxStay, parsePrice, costFor, evaluate, isHoliday, effectiveDay, isoWeek, parseSeason,
} from '../rules.js';
import { parseWKT, toWgs84 } from '../geometry.js';

const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi);
const MON_W48 = at(2026, 11, 23, 10, 30); // måndag, vecka 48 (jämn)
const MON_W49 = at(2026, 11, 30, 10, 30); // måndag, vecka 49 (udda)
const SUN = at(2026, 11, 22, 12);
const SAT = at(2026, 11, 21, 16);
const ok = (p, when, dur) => evaluate(p, when, dur).ok;

test('Kalender: veckonummer, helgdagar och dag före helgdag', () => {
  assert.equal(isoWeek(MON_W48), 48);
  assert.equal(isoWeek(MON_W49), 49);
  assert.ok(isHoliday(at(2026, 12, 25)));
  assert.ok(isHoliday(at(2026, 4, 3)), 'långfredag 2026');
  assert.ok(isHoliday(at(2026, 6, 20)), 'midsommardagen 2026');
  assert.ok(isHoliday(at(2026, 10, 31)), 'alla helgons dag 2026');
  assert.equal(effectiveDay(at(2026, 12, 25)), 0, 'juldagen räknas som söndag');
  assert.equal(effectiveDay(at(2026, 4, 2)), 6, 'skärtorsdag = dag före helgdag = lördag');
  assert.equal(effectiveDay(MON_W48), 1);
});

test('1. Jämna/udda veckor', () => {
  const odd = { fee: 'free', extra: 'P-förbud måndagar klockan 09.00 - 12.00 udda veckor.' };
  const even = { fee: 'free', extra: 'P-förbud måndagar klockan 09.00 - 12.00 jämna veckor.' };
  assert.equal(ok(odd, MON_W48, 60), true);
  assert.equal(ok(odd, MON_W49, 60), false);
  assert.equal(ok(even, MON_W48, 60), false);
  assert.equal(ok(even, MON_W49, 60), true);
});

test('2. Förbud bara under en säsong', () => {
  const spring = { fee: 'free', extra: 'P-förbud måndagar klockan 09.00 - 12.00 jämna veckor under tiden 15:e mars - 30:e april.' };
  assert.equal(ok(spring, MON_W48, 60), true, 'november: inget förbud');
  assert.equal(isoWeek(at(2026, 4, 13)), 16);
  assert.equal(ok(spring, at(2026, 4, 13, 10, 30), 60), false, 'måndag 13 april, vecka 16 (jämn): förbud');
  assert.equal(ok(spring, at(2026, 4, 20, 10, 30), 60), true, 'måndag 20 april, vecka 17 (udda): inget förbud');
  const winter = { fee: 'free', extra: 'P-förbud måndagar klockan 09.00 - 12.00 udda veckor under tiden 1:a oktober - 30:e april.' };
  assert.equal(ok(winter, MON_W49, 60), false, 'december udda vecka: förbud');
  assert.equal(ok(winter, at(2026, 6, 1, 10, 30), 60), true, 'juni: inget förbud');
  assert.deepEqual(parseSeason('under tiden 15 mars - 30 april'), { from: [3, 15], to: [4, 30] });
  assert.deepEqual(parseSeason('Avgift 1/6-30/9.'), { from: [6, 1], to: [9, 30] });
});

test('3. Tillståndsplatser och förhyrda platser föreslås inte när de gäller', () => {
  const permit = { fee: 'paid', price: '20 kr/tim', extra: 'P-tillstånd erfordras helgfri Mån-Fre 07-17.' };
  assert.equal(evaluate(permit, MON_W48, 60).reason, 'kräver tillstånd');
  assert.equal(ok(permit, SUN, 60), true, 'söndag: fritt');
  assert.equal(ok(permit, at(2026, 11, 23, 18), 60), true, 'måndag kväll: fritt');
  assert.equal(ok({ fee: 'paid', price: '20 kr/tim', extra: 'Förhyrda platser 07-17.' }, MON_W48, 60), false);
});

test('4–5. "Högst X i följd", även nattregel', () => {
  const p30 = { fee: 'free', maxStay: '24 tim', restriction: 'Parkering är dock tillåten under högst 30 min i följd.' };
  assert.equal(ok(p30, MON_W48, 30), true);
  assert.equal(ok(p30, MON_W48, 120), false);
  const night = { fee: 'free', maxStay: '24 tim', restriction: 'Parkering är dock tillåten under högst 4 tim i följd vardag utom vardag före sön- och helgdag klockan 22.00 - 06.00.' };
  assert.equal(ok(night, at(2026, 11, 23, 22), 480), false, 'måndag natt, 8 h');
  assert.equal(ok(night, at(2026, 11, 23, 10), 480), true, 'dagtid 8 h');
});

test('6. "Vardag före sön- och helgdag" är lördag, och tidsgränser med två fönster', () => {
  const r = 'Tidsbegränsningen gäller vardag utom vardag före sön- och helgdag klockan 09.00 - 18.00 och vardag före sön- och helgdag klockan 09.00 - 15.00.';
  const p = { fee: 'free', maxStay: '30 min', restriction: r };
  assert.equal(ok(p, SUN, 120), true, 'söndag: ingen tidsgräns');
  assert.equal(ok(p, SAT, 120), true, 'lördag 16: gränsen slutade 15');
  assert.equal(ok(p, at(2026, 11, 21, 12), 120), false, 'lördag 12: gränsen gäller');
  assert.equal(ok(p, MON_W48, 120), false, 'måndag förmiddag: gränsen gäller');
  assert.equal(ok(p, at(2026, 12, 25, 12), 120), true, 'juldagen: helgdag');
  const morning = { fee: 'free', maxStay: '30 min', restriction: 'Tidsbegränsningen gäller vardagar utom vardag före sön- och helgdag klockan 07.00 - 09.00.' };
  assert.equal(ok(morning, MON_W48, 120), true, '10:30 – efter fönstret');
  assert.equal(ok(morning, at(2026, 11, 23, 7, 30), 120), false);
  const std = { fee: 'paid', price: '34 kr/tim 8-22 alla dagar. Övrig tid: 2 kr/tim', maxStay: '24 tim', restriction: 'Tidsbegränsningen gäller vardag utom dag före sön- och helgdag klockan 00.00 - 24.00.' };
  assert.equal(ok(std, at(2026, 11, 20, 12), 60 * 30), false, 'fredag, 30 h > 24 h');
});

test('7. Förbud uppdelat i två meningar', () => {
  const p = { fee: 'paid', price: '20 kr/tim', extra: 'P-förbud alla dagar 23-24. alla dagar 00-06.' };
  assert.equal(ok(p, at(2026, 11, 23, 2), 60), false, 'kl 02');
  assert.equal(ok(p, at(2026, 11, 23, 23, 15), 30), false, 'kl 23:15');
  assert.equal(ok(p, MON_W48, 60), true, 'dagtid');
});

test('8. Avgift bara under säsong', () => {
  const s1 = { fee: 'paid', price: '20 kr/tim alla dagar 08-22.', extra: '60 kr/dygn. Avgift 1/6-30/9.' };
  assert.equal(evaluate(s1, MON_W48, 60).cost, 0, 'november gratis');
  assert.equal(evaluate(s1, at(2026, 7, 6, 10), 60).cost, 20, 'juli 20 kr');
  const s2 = { fee: 'paid', price: '34 kr/tim 8-22 alla dagar. Övrig tid: 2 kr/tim', restriction: 'Avgiftsplikten gäller under tiden 1:a april - 30 september.' };
  assert.equal(evaluate(s2, MON_W48, 60).cost, 0);
  assert.equal(evaluate(s2, at(2026, 7, 6, 10), 60).cost, 34);
});

test('9–10. Dygnstak och pris per 30 min', () => {
  assert.equal(costFor(parsePrice('7 kr/tim alla dagar 08-22. Övrig tid 2 kr/tim. Maxpris 42 kr/dygn.'), MON_W48, 600), 42);
  assert.equal(evaluate({ fee: 'paid', price: '32 kr/tim alla dagar 08-22. Övrig tid 2 kr/tim.', extra: 'Maxpris 42 kr/dygn.' }, MON_W48, 600).cost, 42);
  assert.equal(costFor(parsePrice('5 kr/30 min alla dagar 00-24.'), MON_W48, 60), 10);
  assert.equal(costFor(parsePrice('32 kr/tim alla dagar 08-22. Övrig tid 2 kr/tim.'), MON_W48, 60), 32);
  // Två dygn med tak 42 kr/dygn = 84
  assert.equal(costFor(parsePrice('34 kr/tim alla dagar 00-24. Maxpris 42 kr/dygn.'), MON_W48, 2880), 84);
});

test('11. Helgdagar räknas som söndag i prisregler', () => {
  const p = parsePrice('15 kr/tim vardagar 9-18');
  assert.equal(costFor(p, at(2026, 12, 25, 12), 60), 0, 'juldagen');
  assert.equal(costFor(p, at(2026, 12, 23, 12), 60), 15, 'vanlig onsdag');
});

test('12. Maxtidsformat ur riktig data', () => {
  const cases = { '30 min': 30, '1 tim': 60, '2 tim': 120, '24 tim': 1440, '48 tim': 2880, '7 dag': 10080, '7 dagar': 10080, '7 dygn': 10080, '0,5': 30, 24: 1440, 2: 120, '3 tim': 180, '12 tim': 720 };
  for (const [s, exp] of Object.entries(cases)) assert.equal(parseMaxStay(s), exp, s);
});

test('13. GEOMETRYCOLLECTION ger form', () => {
  const g = parseWKT('GEOMETRYCOLLECTION (POLYGON ((11.9 57.7, 11.901 57.7, 11.901 57.701, 11.9 57.7)), LINESTRING (11.9 57.7, 11.901 57.701))');
  assert.equal(g.type, 'GeometryCollection');
  assert.equal(g.geometries.length, 2);
  assert.ok(toWgs84(g, 57.7, 11.9), 'omräkningen klarar samlingar');
});

test('Vanliga texter fungerar fortfarande', () => {
  assert.equal(costFor(parsePrice('34 kr/tim 8-22 alla dagar. Övrig tid: 2 kr/tim'), MON_W48, 120), 68);
  assert.equal(ok({ fee: 'free', extra: 'P-förbud måndagar klockan 08.00 - 10.00.' }, MON_W48, 60), true, '10:30 är efter förbudet');
  assert.equal(ok({ fee: 'free', extra: 'P-förbud måndagar klockan 08.00 - 10.00.' }, at(2026, 11, 23, 7, 30), 60), false);
  assert.equal(ok({ fee: 'free', extra: 'P-förbud onsdagar klockan 02.00 - 07.00.' }, at(2026, 11, 25, 1), 120), false);
});

test('Nordhemsskolan: tillstånd i prisfältet, pris i ExtraInfo (verklig post)', async () => {
  const { fromGbg } = await import('../core.js');
  const p = fromGbg({ Id: '792', Name: 'Nordhemsskolan', Owner: 'Göteborgs Stads Parkering',
    ParkingCost: 'P-tillstånd erfordras helgfri mån-fre 07-17.',
    ExtraInfo: '10 kr/tim alla dagar 08-22. Övrig tid 2 kr/tim.',
    Lat: 57.69434, Long: 11.94924, WKT: 'POINT (11.94924 57.69434)' }, 'private');
  assert.equal(evaluate(p, at(2026, 11, 23, 11, 56), 30).reason, 'kräver tillstånd', 'måndag 11:56');
  const evening = evaluate(p, at(2026, 11, 23, 18), 60);
  assert.equal(evening.ok, true, 'måndag 18: öppet för alla');
  assert.equal(evening.cost, 10, 'priset hämtas ur ExtraInfo');
  assert.equal(evaluate(p, at(2026, 11, 22, 12), 60).ok, true, 'söndag');
});

test('Massprov 23 nov: förkortade dagar, Max P-tid, fri parkering, stängt, 24:00:00', async () => {
  const { parseDays, parseExtraRules } = await import('../rules.js');
  const { fromGbg } = await import('../core.js');
  assert.deepEqual([...parseDays('Må-Fr 17-22')].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseDays('3 tim Lö-Sö 08-22')].sort(), [0, 6]);
  assert.deepEqual([...parseDays('Fre-Lör 06.00-02.00')].sort(), [5, 6]);
  assert.deepEqual([...parseDays('P-tillstånd erfordras helgfri Mån-Fre 07-17')].sort(), [1, 2, 3, 4, 5]);
  assert.equal(parseDays('Storgatan 8-22'), null);
  assert.equal(parseMaxStay('24:00:00'), 1440);

  // Max P-tid i ExtraInfo, bara vardagar 10-18
  const max = { fee: 'paid', price: '20 kr/tim alla dagar 08-22.', extra: 'Max P-tid 2 tim Mån-Fre 10-18.' };
  assert.equal(evaluate(max, MON_W48, 180).reason, 'max 2 h');
  assert.equal(ok(max, SUN, 180), true, 'söndag gäller inte maxtiden');
  assert.equal(ok({ fee: 'paid', price: '20 kr/tim', extra: 'Del av plan 1, Max P-tid 2 tim. Öppet dygnet runt.' }, MON_W48, 180), false);

  // Fri parkering första timmarna (med digital biljett), fortsättningsmening för helgen
  const extra = 'Fri parkering 3 tim Må-Fr 17-22. 3 tim Lö-Sö 08-22. med digital biljett.';
  const { freeRules } = parseExtraRules(extra);
  assert.equal(freeRules.length, 2);
  const fp = { fee: 'paid', price: '20 kr/tim alla dagar 08-22. Övrig tid 2 kr/tim.', extra };
  const eve = evaluate(fp, at(2026, 11, 23, 18), 120);
  assert.equal(eve.cost, 0, 'måndag 18, 2 h: inom de fria 3 h');
  assert.match(eve.note, /första 3 h gratis med digital biljett/);
  assert.equal(evaluate(fp, at(2026, 11, 23, 18), 300).cost, 22, '5 h från 18: 18–21 fritt, 21–22 à 20 kr, 22–23 à 2 kr');
  assert.equal(evaluate(fp, MON_W48, 60).cost, 20, 'förmiddag: ingen fri period');
  // "Fri kund" gäller bara kunder – ingen rabatt
  assert.equal(evaluate({ fee: 'paid', price: '20 kr/tim alla dagar 08-22.', extra: 'Fri kund P-2 tim alla dagar 08-22 med biljett.' }, MON_W48, 60).cost, 20);

  // Stängt p-hus nattetid
  const closed = { fee: 'paid', price: '20 kr/tim', extra: 'P-huset är öppet alla dagar 05-24. OBS! P-hus stängt kl.00-05 och kan ej öppnas.' };
  assert.equal(evaluate(closed, at(2026, 11, 23, 23), 180).reason, 'stängt 00.00–05.00');
  assert.equal(ok(closed, MON_W48, 180), true);

  // Anläggning helt utan pris -> okänd avgift (inte "avgift")
  assert.equal(fromGbg({ Id: '129', Name: 'Slätten', Lat: 57.71, Long: 12.0 }, 'private').fee, 'unknown');
});
