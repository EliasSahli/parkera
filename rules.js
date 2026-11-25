// rules.js – tolkar Göteborgs parkeringsregler i fritext (maxtid, pris, P-förbud, tillstånd)
// och räknar ut om en plats passar för en viss parkeringstid och vad den kostar.
// Ren logik utan nätverk/DOM, testbar i Node. Testad mot verkliga texter (tests/real-texts.test.js).

// ---------- Kalender: svenska helgdagar och "dag före sön- och helgdag" ----------
function easter(y) {
  // Anonym gregoriansk algoritm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
const holidayCache = new Map();
export function swedishHolidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const set = new Set();
  const add = (d) => set.add(`${d.getMonth() + 1}-${d.getDate()}`);
  const e = easter(y);
  const rel = (n) => new Date(y, e.getMonth(), e.getDate() + n);
  [new Date(y, 0, 1), new Date(y, 0, 6), rel(-2), e, rel(1), new Date(y, 4, 1), rel(39), rel(49),
    new Date(y, 5, 6), new Date(y, 11, 25), new Date(y, 11, 26)].forEach(add);
  // Midsommardagen: lördag 20–26 juni. Alla helgons dag: lördag 31 okt–6 nov.
  for (let d = 20; d <= 26; d++) { const t = new Date(y, 5, d); if (t.getDay() === 6) add(t); }
  for (let d = 0; d <= 6; d++) { const t = new Date(y, 9, 31 + d); if (t.getDay() === 6) add(t); }
  holidayCache.set(y, set);
  return set;
}
export function isHoliday(date) {
  return swedishHolidays(date.getFullYear()).has(`${date.getMonth() + 1}-${date.getDate()}`);
}
// Dag enligt skyltlogik: helgdag = söndag (0), vardag före helgdag = lördag (6)
export function effectiveDay(date) {
  if (date.getDay() === 0 || isHoliday(date)) return 0;
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  if (date.getDay() !== 6 && isHoliday(next)) return 6;
  return date.getDay();
}
export function isoWeek(date) {
  const t = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 864e5 + 1) / 7);
}

// ---------- Textnormalisering ----------
const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
const MON_RE = `(${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sep|sept|okt|nov|dec)`;

// "vardag före sön- och helgdag" och liknande = lördag i skyltspråk
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/(?:vardag(?:ar)?|dag(?:ar)?)\s+före\s+sön-?\s*(?:och|&)\s*helgdag(?:ar)?/g, ' lördag ')
    .replace(/(?:vardag(?:ar)?|dag(?:ar)?)\s+före\s+(?:söndag|helgdag)(?:ar)?/g, ' lördag ')
    .replace(/sön-?\s*(?:och|&)\s*helgdag(?:ar)?/g, ' söndag ');
}

const DAY_WORDS = [
  [/alla dagar|dagligen|varje dag/, [0, 1, 2, 3, 4, 5, 6]],
  [/vardag|mån(?:dag)?\s*[-–]\s*fre(?:dag)?/, [1, 2, 3, 4, 5]],
  [/helgdag/, [0]],
  [/helg(?!fri)|lör(?:dag)?\s*[-–]\s*sön(?:dag)?/, [0, 6]],
  [/lördag/, [6]],
  [/söndag/, [0]],
  [/måndag/, [1]],
  [/tisdag/, [2]],
  [/onsdag/, [3]],
  [/torsdag/, [4]],
  [/fredag/, [5]],
];

const DAY_ABBR = [['sö', 0], ['må', 1], ['ti', 2], ['on', 3], ['to', 4], ['fr', 5], ['lö', 6]];
const dayIdx = (w) => DAY_ABBR.find(([a]) => w.startsWith(a))?.[1];
// "må-fr", "lö-sö", "fre-lör", "måndag-fredag" -> dagar (även över helgen, t.ex. fre-mån)
const RANGE_RE = /(?<![a-zåäö])(må|mån|måndag|ti|tis|tisdag|on|ons|onsdag|to|tor|torsdag|fr|fre|fredag|lö|lör|lördag|sö|sön|söndag)(?:ar)?\s*[-–]\s*(må|mån|måndag|ti|tis|tisdag|on|ons|onsdag|to|tor|torsdag|fr|fre|fredag|lö|lör|lördag|sö|sön|söndag)(?:ar)?(?![a-zåäö])/g;

// Text -> mängd veckodagar (0 = söndag). null = ingen dag nämnd (gäller alla dagar)
export function parseDays(text) {
  // "vardag utom lördag klockan…" – undantaget räknas inte som dagar
  let t = normalize(text).replace(/utom[^0-9]*?(?=klockan|kl\.|\d|$)/g, ' ');
  const days = new Set();
  t = t.replace(RANGE_RE, (_, a, b) => {
    let i = dayIdx(a);
    const end = dayIdx(b);
    for (let n = 0; n < 7; n++) { days.add(i); if (i === end) break; i = (i + 1) % 7; }
    return ' ';
  });
  let rest = t;
  for (const [re, ds] of DAY_WORDS) {
    if (re.test(rest)) {
      ds.forEach((d) => days.add(d));
      rest = rest.replace(new RegExp(re.source, 'g'), ' ');
    }
  }
  return days.size ? days : null;
}

// "8-22", "08.00 - 10.00", "9:30–18", "23-24" -> {from, to} i minuter efter midnatt
export function parseWindow(text) {
  const re = /(\d{1,2})(?:[.:](\d{2}))?\s*[-–]\s*(\d{1,2})(?:[.:](\d{2}))?(?!\s*\/|\d|:e|:a)/g;
  let m;
  while ((m = re.exec(text))) {
    // hoppa över datum som "1/6-30/9"
    if (/\/\s*$/.test(text.slice(0, m.index))) continue;
    const from = Number(m[1]) * 60 + Number(m[2] || 0);
    const to = Number(m[3]) * 60 + Number(m[4] || 0);
    if (from > 24 * 60 || to > 24 * 60) continue;
    return { from, to };
  }
  return null;
}

// "under tiden 15:e mars - 30:e april", "1:a oktober - 30 april", "1/6-30/9" -> {from:[m,d], to:[m,d]}
export function parseSeason(text) {
  const t = String(text || '').toLowerCase();
  let m = new RegExp(`(\\d{1,2})(?::[ae])?\\s*${MON_RE}\\s*[-–]\\s*(\\d{1,2})(?::[ae])?\\s*${MON_RE}`).exec(t);
  if (m) return { from: [monthIndex(m[2]), Number(m[1])], to: [monthIndex(m[4]), Number(m[3])] };
  m = /(\d{1,2})\s*\/\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*\/\s*(\d{1,2})/.exec(t);
  if (m) return { from: [Number(m[2]), Number(m[1])], to: [Number(m[4]), Number(m[3])] };
  return null;
}
function monthIndex(name) {
  const i = MONTHS.findIndex((mo) => mo.startsWith(name.slice(0, 3)));
  return i + 1;
}
function inSeason(season, date) {
  if (!season) return true;
  const md = (date.getMonth() + 1) * 100 + date.getDate();
  const f = season.from[0] * 100 + season.from[1];
  const to = season.to[0] * 100 + season.to[1];
  return f <= to ? md >= f && md <= to : md >= f || md <= to;
}
function parseParity(text) {
  if (/jämna veckor/i.test(text)) return 0;
  if (/udda veckor/i.test(text)) return 1;
  return null;
}
// Ta bort säsong och veckor innan dagar/tider tolkas
function stripMeta(text) {
  return String(text || '')
    .replace(new RegExp(`under tiden.*$`, 'i'), ' ')
    .replace(/\d{1,2}\s*\/\s*\d{1,2}\s*[-–]\s*\d{1,2}\s*\/\s*\d{1,2}/g, ' ')
    .replace(/(jämna|udda) veckor/gi, ' ');
}

// Ett regelfönster: dagar + tid (+ ev. jämna/udda veckor och säsong)
function makeRule(text, extra = {}) {
  const core = stripMeta(text);
  const w = parseWindow(core);
  return {
    days: parseDays(core),
    from: w?.from ?? 0,
    to: w?.to ?? 1440,
    hasWindow: Boolean(w),
    parity: parseParity(text),
    season: parseSeason(text),
    text,
    ...extra,
  };
}

// Är tidpunkten inom regeln? Fönster över midnatt (22-06) räknas till dagen då det började.
export function inRule(rule, date) {
  const min = date.getHours() * 60 + date.getMinutes();
  let anchor = date;
  if (rule.from > rule.to) {
    if (min >= rule.from) anchor = date;
    else if (min < rule.to) anchor = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1, 12);
    else return false;
  } else if (!(min >= rule.from && min < rule.to)) {
    return false;
  }
  if (rule.days && !rule.days.has(effectiveDay(anchor))) return false;
  if (rule.parity != null && isoWeek(anchor) % 2 !== rule.parity) return false;
  if (!inSeason(rule.season, anchor)) return false;
  return true;
}

// ---------- Maxtid ----------
// "30 min", "3 tim", "2 timmar", "7 dagar", "7 dygn", "0,5", "24", "PT2H" -> minuter
export function parseMaxStay(text) {
  if (text == null || text === '') return null;
  const t = String(text).toLowerCase().replace(',', '.').trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60); // bara siffra = timmar
  const hms = /^(\d{1,3}):(\d{2})(?::\d{2})?$/.exec(t); // "24:00:00"
  if (hms) return Number(hms[1]) * 60 + Number(hms[2]);
  const iso = /^p?t?(\d+)h$/i.exec(t.replace(/\s/g, ''));
  if (iso) return Number(iso[1]) * 60;
  let total = 0;
  let found = false;
  const re = /(\d+(?:\.\d+)?)\s*(dygn|dagar|dag|days?\b|d\b|tim(?:me|mar)?|h(?:ours?|rs?)?\b|min(?:ut(?:er|es?)?)?)/g;
  let m;
  while ((m = re.exec(t))) {
    const n = Number(m[1]);
    const u = m[2];
    found = true;
    if (u.startsWith('dygn') || u.startsWith('dag') || u.startsWith('day') || u === 'd') total += n * 1440;
    else if (u.startsWith('t') || u.startsWith('h')) total += n * 60;
    else total += n;
  }
  return found ? Math.round(total) : null;
}

function sentences(text) {
  return String(text || '')
    .split(/\.(?=\s|$)|;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- Pris ----------
// "34 kr/tim 8-22 alla dagar. Övrig tid: 2 kr/tim", "5 kr/30 min alla dagar 00-24", "Maxpris 42 kr/dygn"
// -> { rules: [{rate (kr/h), days, from, to}], otherRate, dayCap } eller null om okänt
const RATE_RE = /(\d+(?:[.,]\d+)?)\s*(?:kr|:-|sek)\s*\/\s*(?:per\s*)?(?:påbörjad\s*)?(\d+(?:[.,]\d+)?)?\s*(tim(?:me|mar)?|h|min(?:ut(?:er)?)?)\b/i;
export function parsePrice(text) {
  if (!text) return null;
  const rules = [];
  let otherRate = null;
  let dayCap = null;
  for (const s of sentences(text)) {
    const cap = /(\d+)\s*(?:kr|:-)\s*\/\s*dygn/i.exec(s);
    if (cap) dayCap = Number(cap[1]);
    const rateM = RATE_RE.exec(s);
    if (!rateM) continue;
    const n = Number(rateM[1].replace(',', '.'));
    const per = Number((rateM[2] || '1').replace(',', '.'));
    const unitMin = /^min/i.test(rateM[3]) ? 1 : 60;
    const rate = (n * 60) / (per * unitMin); // kr per timme
    if (/övrig/i.test(s)) { otherRate = rate; continue; }
    rules.push(makeRule(s.replace(rateM[0], ' '), { rate }));
  }
  if (!rules.length && otherRate == null && dayCap == null) return null;
  if (!rules.length && otherRate == null) return { rules: [], otherRate: null, dayCap, capOnly: true };
  return { rules, otherRate, dayCap };
}

// Avgiftssäsong: "Avgift 1/6-30/9", "Avgiftsplikten gäller under tiden 1:a april - 30 september"
export function parseFeeSeason(text) {
  for (const s of sentences(text)) {
    if (/avgift/i.test(s)) {
      const season = parseSeason(s);
      if (season) return season;
    }
  }
  return null;
}

// Kostnad för [start, start+durMin] i hela kronor, eller null om okänd.
export function costFor(price, start, durMin, { feeSeason = null, freeFirst = 0 } = {}) {
  if (!price || price.capOnly) return null;
  let cost = 0;
  let block = 0;
  const t = new Date(start.getTime());
  t.setSeconds(0, 0);
  for (let m = 0; m < durMin; m++) {
    if (m < freeFirst) { t.setMinutes(t.getMinutes() + 1); continue; }
    if (m > 0 && m % 1440 === 0) { cost += price.dayCap != null ? Math.min(block, price.dayCap) : block; block = 0; }
    if (inSeason(feeSeason, t)) {
      const rule = price.rules.find((r) => inRule(r, t));
      const rate = rule ? rule.rate : price.otherRate ?? 0;
      block += rate / 60;
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  cost += price.dayCap != null ? Math.min(block, price.dayCap) : block;
  return Math.round(cost);
}

// ---------- Förbud, tillstånd och tidsgränser ----------
// "P-förbud måndagar klockan 08.00 - 10.00 jämna veckor under tiden 15:e mars - 30:e april."
// "P-förbud alla dagar 23-24. alla dagar 00-06." (andra meningen hör till samma förbud)
export function parseBans(text) {
  const bans = [];
  let prevBan = false;
  for (const s of sentences(text)) {
    const isBan = /p-förbud|parkeringsförbud|städ|stängt|låst/i.test(s);
    const continues = prevBan && !/kr|avgift|tillstånd|max|högst|öppet/i.test(s) && parseWindow(stripMeta(s));
    if (isBan || continues) {
      const r = makeRule(s.replace(/kl\./gi, ' '), { closed: /stängt|låst/i.test(s) });
      if (r.hasWindow) bans.push(r);
      prevBan = true;
    } else {
      prevBan = false;
    }
  }
  return bans;
}

// "P-tillstånd erfordras helgfri Mån-Fre 07-17", "Förhyrda platser 07-17"
const PERMIT_RE = /p-tillstånd erfordras|tillstånd (?:krävs|erfordras)|förhyrda platser|endast (?:för )?(?:boende|tillståndshavare|abonnenter|förhyrda)|reserverad(?:e)? platser/i;
export function parsePermits(text) {
  return sentences(text).filter((s) => PERMIT_RE.test(s)).map((s) => makeRule(s));
}

// Tidsgränsens giltighet:
//  "Tidsbegränsningen gäller vardag utom vardag före sön- och helgdag klockan 09.00 - 18.00
//   och vardag före sön- och helgdag klockan 09.00 - 15.00."  -> två fönster
//  "Parkering är dock tillåten under högst 30 min i följd [dagar klockan …]." -> extra maxtid
export function parseLimits(text) {
  const windows = [];
  const extraMax = [];
  for (const s of sentences(text)) {
    const hogst = /högst\s+(\d+(?:[.,]\d+)?\s*(?:min(?:uter)?|tim(?:mar|me)?|h))\s*i\s*följd(.*)$/i.exec(s);
    if (hogst) {
      const minutes = parseMaxStay(hogst[1]);
      const r = makeRule(hogst[2] || '');
      extraMax.push({ minutes, rule: r.hasWindow || r.days ? r : null });
      continue;
    }
    if (!/tidsbegränsning|tillåtelsen|tidsgräns/i.test(s)) continue;
    // Dela "… klockan A och lördag klockan B" i flera fönster
    const parts = normalize(s).split(/\s+och\s+/);
    let carry = '';
    for (const part of parts) {
      const seg = `${carry} ${part}`.trim();
      if (!parseWindow(stripMeta(seg))) { carry = seg; continue; }
      windows.push(makeRule(seg));
      carry = '';
    }
  }
  return { windows, extraMax };
}
// ExtraInfo: "Max P-tid 2 tim Mån-Fre 10-18." och "Fri parkering 3 tim Må-Fr 17-22. 3 tim Lö-Sö 08-22. med digital biljett."
// En mening som bara är "3 tim Lö-Sö 08-22" fortsätter föregående regel.
export function parseExtraRules(text) {
  const maxRules = [];
  const freeRules = [];
  let prev = null;
  for (const s of sentences(text)) {
    const max = /max\.?\s*p-tid:?\s*(\d+(?:[.,]\d+)?\s*(?:min|tim(?:mar|me)?|h|dygn|dagar|dag))(.*)$/i.exec(s);
    const free = /fri\s+(kund\s+)?(?:parkering|p)-?\s*(\d+(?:[.,]\d+)?\s*(?:min|tim(?:mar|me)?|h))(.*)$/i.exec(s);
    const cont = /^(\d+(?:[.,]\d+)?\s*(?:min|tim(?:mar|me)?|h))\s+(.*\d.*)$/i.exec(s);
    if (max) { const r = makeRule(max[2]); maxRules.push({ minutes: parseMaxStay(max[1]), rule: r.hasWindow || r.days ? r : null }); prev = 'max'; }
    else if (free) { if (!free[1]) freeRules.push({ minutes: parseMaxStay(free[2]), rule: makeRule(free[3]) }); prev = free[1] ? null : 'free'; }
    else if (cont && prev) {
      const r = makeRule(cont[2]);
      (prev === 'max' ? maxRules : freeRules).push({ minutes: parseMaxStay(cont[1]), rule: r });
    } else if (!/^med |^mot /i.test(s)) prev = null;
  }
  return { maxRules, freeRules };
}

// Bakåtkompatibelt: första fönstret
export function limitWindow(text) {
  return parseLimits(text).windows[0] || null;
}

// Gäller någon regel någon gång under [start, start+durMin)?
export function ruleDuring(rules, start, durMin, step = 5) {
  const t = new Date(start.getTime());
  for (let m = 0; m < Math.max(durMin, 1); m += step) {
    const hit = rules.find((r) => inRule(r, t));
    if (hit) return hit;
    t.setMinutes(t.getMinutes() + step);
  }
  return null;
}
export const banDuring = ruleDuring;

const pad = (n) => String(n).padStart(2, '0');
export const fmtMin = (min) => `${pad(Math.floor(min / 60))}.${pad(min % 60)}`;
export function fmtDuration(min) {
  if (min < 60) return `${min} min`;
  if (min >= 1440 && min % 1440 === 0) return `${min / 1440} dygn`;
  const h = min / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1).replace('.', ',')} h`;
}

// ---------- Bedömning ----------
// -> { ok, reason, cost (kr|null), approx }
export function evaluate(p, start, durMin) {
  // Göteborgs fält blandas: tillståndskrav kan stå i prisfältet och priset i ExtraInfo
  // (t.ex. Nordhemsskolan: ParkingCost = "P-tillstånd erfordras…", ExtraInfo = "10 kr/tim…").
  const all = [p.price, p.extra, p.restriction].filter(Boolean).join('. ');
  const fail = (reason) => ({ ok: false, reason, cost: null, approx: false });

  // Maxtid, och när den gäller
  const maxMin = p.maxStayMin ?? parseMaxStay(p.maxStay);
  const { windows, extraMax } = parseLimits(p.restriction);
  const limitApplies = !windows.length || ruleDuring(windows, start, durMin) != null;
  if (maxMin != null && maxMin < durMin && limitApplies) return fail(`max ${fmtDuration(maxMin)}`);
  for (const x of extraMax) {
    if (x.minutes != null && x.minutes < durMin && (!x.rule || ruleDuring([x.rule], start, durMin))) {
      return fail(`max ${fmtDuration(x.minutes)} i följd`);
    }
  }

  const { maxRules, freeRules } = parseExtraRules(p.extra);
  for (const x of maxRules) {
    if (x.minutes != null && x.minutes < durMin && (!x.rule || ruleDuring([x.rule], start, durMin))) {
      return fail(`max ${fmtDuration(x.minutes)}`);
    }
  }

  // Tillstånd / förhyrda platser
  const permit = ruleDuring(parsePermits(all), start, durMin);
  if (permit && !p.prh) return fail('kräver tillstånd'); // PRH-platser: tillståndet är förutsättningen

  // P-förbud (med jämna/udda veckor och säsong)
  const ban = ruleDuring(parseBans(all), start, durMin);
  if (ban) return fail(`${ban.closed ? 'stängt' : 'P-förbud'} ${fmtMin(ban.from)}–${fmtMin(ban.to)}`);

  if (p.fee === 'free') return { ok: true, reason: '', cost: 0, approx: false };
  if (p.fee === 'paid') {
    const feeSeason = parseFeeSeason(all);
    const parsed = parsePrice([p.price, p.extra, capText(all)].filter(Boolean).join('. '));
    // "Fri parkering 3 tim Må-Fr 17-22 med digital biljett": första timmarna gratis om man kommer i fönstret
    const free = freeRules.find((f) => f.minutes && inRule(f.rule, start));
    let cost = costFor(parsed, start, durMin, { feeSeason, freeFirst: free ? free.minutes : 0 });
    let approx = false;
    const note = free ? `första ${fmtDuration(free.minutes)} gratis${/biljett|app/i.test(p.extra) ? ' med digital biljett' : ''}` : '';
    if (cost == null && p.currentRate != null) {
      cost = inSeasonAny(feeSeason, start, durMin) ? Math.round((p.currentRate * durMin) / 60) : 0;
      approx = true;
    }
    if (p.priceFrom) approx = true; // operatörens "från"-pris
    return { ok: true, reason: '', cost, approx, note };
  }
  return { ok: true, reason: '', cost: null, approx: false };
}

// Dygnstak kan stå i ExtraInfo ("Maxpris 42 kr/dygn", "70 kr/dygn")
function capText(text) {
  const m = /(\d+)\s*(?:kr|:-)\s*\/\s*dygn/i.exec(text || '');
  return m ? `Maxpris ${m[1]} kr/dygn` : '';
}
function inSeasonAny(season, start, durMin) {
  if (!season) return true;
  return inSeason(season, start) || inSeason(season, new Date(start.getTime() + durMin * 60000));
}
