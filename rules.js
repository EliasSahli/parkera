// rules.js – tolkar parkeringsregler i fritext (maxtid, pris, P-förbud)
// och räknar ut om en plats passar för en viss parkeringstid och vad den kostar.
// Ren logik utan nätverk/DOM, testbar i Node.

const DAY_WORDS = [
  [/alla dagar|dagligen|varje dag/, [0, 1, 2, 3, 4, 5, 6]],
  [/vardag|mån(?:dag)?\s*[-–]\s*fre(?:dag)?/, [1, 2, 3, 4, 5]],
  [/helgdag/, [0]],
  [/helg|lör(?:dag)?\s*[-–]\s*sön(?:dag)?/, [0, 6]],
  [/lördag/, [6]],
  [/söndag/, [0]],
  [/måndag/, [1]],
  [/tisdag/, [2]],
  [/onsdag/, [3]],
  [/torsdag/, [4]],
  [/fredag/, [5]],
];

// Text -> mängd veckodagar (0 = söndag). null = ingen dag nämnd (gäller alla dagar)
export function parseDays(text) {
  // "vardag utom dag före sön- och helgdag" – undantaget ska inte räknas som dagar
  const t = text.toLowerCase().replace(/utom[^0-9]*?(?=klockan|kl\.|\d|$)/g, ' ');
  const days = new Set();
  let rest = t;
  for (const [re, ds] of DAY_WORDS) {
    if (re.test(rest)) {
      ds.forEach((d) => days.add(d));
      rest = rest.replace(new RegExp(re.source, 'g'), ' ');
    }
  }
  return days.size ? days : null;
}

// "8-22", "08.00 - 10.00", "9:30–18" -> {from, to} i minuter efter midnatt
export function parseWindow(text) {
  const m = /(\d{1,2})(?:[.:](\d{2}))?\s*[-–]\s*(\d{1,2})(?:[.:](\d{2}))?/.exec(text);
  if (!m) return null;
  const from = Number(m[1]) * 60 + Number(m[2] || 0);
  const to = Number(m[3]) * 60 + Number(m[4] || 0);
  if (from > 24 * 60 || to > 24 * 60) return null;
  return { from, to };
}

// "30 min", "3 tim", "2 timmar", "2 hours", "1 h", "1 dygn", "PT2H" -> minuter
export function parseMaxStay(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().replace(',', '.');
  const iso = /^p?t?(\d+)h$/i.exec(t.replace(/\s/g, ''));
  if (iso) return Number(iso[1]) * 60;
  let total = 0;
  let found = false;
  const re = /(\d+(?:\.\d+)?)\s*(dygn|d(?:ay|ays)?\b|tim(?:me|mar)?|h(?:ours?|rs?)?\b|min(?:ut(?:er|es?)?)?)/g;
  let m;
  while ((m = re.exec(t))) {
    const n = Number(m[1]);
    const u = m[2];
    found = true;
    if (u.startsWith('dygn') || u.startsWith('d')) total += n * 1440;
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

// Pristext -> { rules: [{rate, days, from, to}], otherRate } eller null om okänt
// Ex: "34 kr/tim 8-22 alla dagar. Övrig tid: 2 kr/tim"
export function parsePrice(text) {
  if (!text) return null;
  const rules = [];
  let otherRate = null;
  for (const s of sentences(text)) {
    const rateM = /(\d+(?:[.,]\d+)?)\s*(?:kr|:-|sek)\s*\/?\s*(?:per\s*)?(?:påbörjad\s*)?(tim(?:me)?|h)\b/i.exec(s);
    if (!rateM) continue;
    const rate = Number(rateM[1].replace(',', '.'));
    if (/övrig/i.test(s)) {
      otherRate = rate;
      continue;
    }
    const w = parseWindow(s.replace(rateM[0], ' '));
    rules.push({ rate, days: parseDays(s), from: w?.from ?? 0, to: w?.to ?? 1440 });
  }
  if (!rules.length && otherRate == null) return null;
  return { rules, otherRate };
}

// Text med P-förbud -> lista med förbudsfönster
// Ex: "P-förbud måndagar klockan 08.00 - 10.00."
export function parseBans(text) {
  const bans = [];
  for (const s of sentences(text)) {
    if (!/p-förbud|parkeringsförbud|städ/i.test(s)) continue;
    const w = parseWindow(s);
    if (!w) continue;
    bans.push({ days: parseDays(s), from: w.from, to: w.to, text: s });
  }
  return bans;
}

function inWindow(rule, date) {
  const day = date.getDay();
  if (rule.days && !rule.days.has(day)) return false;
  const min = date.getHours() * 60 + date.getMinutes();
  if (rule.from <= rule.to) return min >= rule.from && min < rule.to;
  return min >= rule.from || min < rule.to; // över midnatt, t.ex. 22-06
}

const STEP = 15; // minuter

// Kostnad för [start, start+durMin]. Returnerar kronor (heltal) eller null om okänd.
export function costFor(price, start, durMin) {
  if (!price) return null;
  let cost = 0;
  const t = new Date(start.getTime());
  t.setSeconds(0, 0);
  for (let m = 0; m < durMin; m++) {
    const rule = price.rules.find((r) => inWindow(r, t));
    const rate = rule ? rule.rate : price.otherRate ?? 0;
    cost += rate / 60;
    t.setMinutes(t.getMinutes() + 1);
  }
  return Math.round(cost);
}

export function banDuring(bans, start, durMin) {
  const t = new Date(start.getTime());
  for (let m = 0; m <= durMin; m += STEP) {
    const hit = bans.find((b) => inWindow(b, t));
    if (hit) return hit;
    t.setMinutes(t.getMinutes() + STEP);
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
export const fmtMin = (min) => `${pad(Math.floor(min / 60))}.${pad(min % 60)}`;
export function fmtDuration(min) {
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1).replace('.', ',')} h`;
}

// "Tillåtelsen gäller vardag klockan 08.00 - 22.00" -> fönster då tidsgränsen gäller
export function limitWindow(text) {
  if (!text || !/gäller/i.test(text)) return null;
  const w = parseWindow(text);
  return w ? { days: parseDays(text), from: w.from, to: w.to } : null;
}

// Bedöm en plats för vald tid.
// -> { ok, reason, cost (kr|null), approx }
export function evaluate(p, start, durMin) {
  const extra = [p.extra, p.restriction].filter(Boolean).join('. ');
  const maxMin = p.maxStayMin ?? parseMaxStay(p.maxStay);
  // "Tillåtelsen gäller vardag klockan 08.00 - 22.00" = tidsgränsen gäller bara då
  const limitWin = limitWindow(p.restriction);
  const limitApplies = !limitWin || banDuring([limitWin], start, durMin - 1) != null;
  if (maxMin != null && maxMin < durMin && limitApplies) {
    return { ok: false, reason: `max ${fmtDuration(maxMin)}`, cost: null, approx: false };
  }
  const ban = banDuring(parseBans(extra), start, durMin);
  if (ban) {
    return { ok: false, reason: `P-förbud ${fmtMin(ban.from)}–${fmtMin(ban.to)}`, cost: null, approx: false };
  }
  if (p.fee === 'free') return { ok: true, reason: '', cost: 0, approx: false };
  if (p.fee === 'paid') {
    const parsed = parsePrice(p.price);
    let cost = costFor(parsed, start, durMin);
    let approx = false;
    if (cost == null && p.currentRate != null) {
      cost = Math.round((p.currentRate * durMin) / 60);
      approx = true;
    }
    return { ok: true, reason: '', cost, approx };
  }
  return { ok: true, reason: '', cost: null, approx: false };
}
