// app.js – UI och flöde
import {
  prepare, pickOptions, applyFilters, navUrl, feeLabel, formatDistance, walkMinutes, fits,
  PAY_APPS, payAppUrl, opensDirectly, shareUrl, reportUrl,
} from './core.js';
import { evaluate, fmtDuration } from './rules.js';
import { initMap, updateMap, openPopupFor } from './map.js';
import {
  geocode, suggest, reverseGeocode, fetchOsmParkings, fetchGbgParkings, testGbgKey, hasProxy, loadSnapshot,
} from './sources.js';

const $ = (id) => document.getElementById(id);
const APP_VERSION = '0.8.1';
const reportLink = (p) => reportUrl(p, { dur: state.dur, arrival: arrival().toLocaleString('sv-SE'), version: APP_VERSION });

// ---------- Inställningar (lagras lokalt i webbläsaren) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('parkera.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('parkera.' + k, JSON.stringify(v)); } catch { /* privat läge */ } },
};
const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const settings = {
  navApp: store.get('navApp', isApple ? 'apple' : 'google'),
  payApp: store.get('payApp2', 'parkster'), // ny nyckel: tidigare sparat val pekade på App Store
  radius: store.get('radius', 1500),
  appId: store.get('appId', ''),
};

// Nyckel via länk: öppna .../?appid=DIN-NYCKEL en gång på en ny enhet så sparas den där.
try {
  const params = new URLSearchParams(location.search);
  const fromUrl = (params.get('appid') || '').trim();
  if (fromUrl) {
    settings.appId = fromUrl;
    store.set('appId', fromUrl);
    params.delete('appid');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  }
} catch { /* ignorera */ }

const state = {
  dest: null,
  all: [],
  maxDist: store.get('maxDist', 800),
  fee: 'all',
  dur: store.get('dur', 120),
  onlyFits: store.get('onlyFits', true),
  arriveIn: 0, // minuter från nu, eller null när en egen tid är vald
  arriveAt: null, // Date när en egen tid är vald
  req: 0,
  loading: false,
};

// ---------- Karta ----------
let mapStarted = false;
function ensureMap() {
  if (mapStarted) return;
  mapStarted = true;
  initMap($('map'), { onSelect: (id) => openPopupFor(id) }).catch((e) => {
    console.warn('Kartan kunde inte laddas', e);
    $('map').innerHTML = '<p class="maperr">Kartan kunde inte laddas just nu. Listan nedan fungerar ändå.</p>';
  });
}

// ---------- Status ----------
function status(msg, { err = false, spin = false } = {}) {
  const el = $('status');
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'status' + (err ? ' err' : '');
  el.innerHTML = (spin ? '<span class="spinner"></span>' : '') + escapeHtml(msg);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Sök med förslag medan man skriver ----------
const input = $('q');
const sugBox = $('suggestions');
let sugItems = [];
let sugActive = -1;
let sugTimer = null;
let sugCtrl = null;

input.addEventListener('input', () => {
  clearTimeout(sugTimer);
  const q = input.value.trim();
  if (q.length < 2) { q.length ? hideSuggestions() : showRecentAsSuggestions(); return; }
  sugTimer = setTimeout(() => runSuggest(q), 180);
});
input.addEventListener('focus', () => {
  if (!input.value.trim()) showRecentAsSuggestions();
  else if (sugItems.length) sugBox.hidden = false;
});
input.addEventListener('blur', () => setTimeout(hideSuggestions, 150));
input.addEventListener('keydown', (e) => {
  if (sugBox.hidden || !sugItems.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = sugItems.length;
    sugActive = (sugActive + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    paintActive();
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

async function runSuggest(q) {
  sugCtrl?.abort();
  sugCtrl = new AbortController();
  const mine = sugCtrl;
  try {
    const hits = await suggest(q, mine.signal);
    if (mine !== sugCtrl || input.value.trim() !== q) return; // gammalt svar
    showSuggestions(hits, q);
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('Förslag misslyckades', err);
  }
}

function showSuggestions(hits, q = '') {
  sugItems = hits;
  sugActive = hits.length ? 0 : -1;
  sugBox.innerHTML = '';
  if (!hits.length) {
    sugBox.innerHTML = `<li class="none">Inga förslag – tryck Sök för att söka bredare</li>`;
    sugBox.hidden = !q;
    return;
  }
  hits.forEach((h, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="k">${h.kind || '🕘'}</span><span class="tx"><b>${highlight(h.title || h.label, q)}</b>${h.sub ? `<small>${escapeHtml(h.sub)}</small>` : ''}</span>`;
    // pointerdown hinner före blur – annars stängs listan innan klicket registreras
    li.addEventListener('pointerdown', (e) => { e.preventDefault(); pick(i); });
    sugBox.appendChild(li);
  });
  paintActive();
  sugBox.hidden = false;
}
function paintActive() {
  [...sugBox.children].forEach((li, i) => li.classList.toggle('on', i === sugActive));
}
function highlight(text, q) {
  const t = escapeHtml(text);
  if (!q) return t;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t;
  return escapeHtml(text.slice(0, i)) + '<u>' + escapeHtml(text.slice(i, i + q.length)) + '</u>' + escapeHtml(text.slice(i + q.length));
}
function pick(i) {
  const h = sugItems[i];
  if (!h) return;
  hideSuggestions();
  input.blur();
  chooseDest(h);
}
function hideSuggestions() { sugBox.hidden = true; }
function showRecentAsSuggestions() {
  const recent = store.get('recent', []).map((r) => ({ ...r, title: r.label.split(',')[0], sub: r.label.split(',').slice(1).join(',').trim(), kind: '🕘' }));
  if (recent.length) showSuggestions(recent);
  else hideSuggestions();
}

$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  if (!sugBox.hidden && sugItems.length && sugActive >= 0) return pick(sugActive);
  // Inga förslag ännu – gör en bredare sökning
  clearTimeout(sugTimer);
  input.blur();
  hideSuggestions();
  status('Söker adress…', { spin: true });
  try {
    const hits = await geocode(q);
    if (!hits.length) return status('Hittade ingen adress. Prova att lägga till stad, t.ex. "…, Göteborg".', { err: true });
    if (hits.length === 1) return chooseDest(hits[0]);
    status('');
    showSuggestions(hits.map((h) => ({ ...h, title: h.label, sub: h.full, kind: '📍' })));
  } catch (err) {
    console.error(err);
    status('Adressökningen svarar inte just nu. Försök igen om en stund.', { err: true });
  }
});

// ---------- Parkera här (min position) ----------
$('hereBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return status('Din webbläsare kan inte dela position.', { err: true });
  hideSuggestions();
  status('Hämtar din position…', { spin: true });
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      const dest = { label: 'Min position', full: '', lat, lon, isHere: true };
      chooseDest(dest);
      const street = await reverseGeocode(lat, lon);
      if (street && state.dest === dest) {
        dest.label = `Nära ${street}`;
        input.value = dest.label;
        $('destLabel').textContent = destHeading();
      }
    },
    (err) => {
      const msg = err.code === 1
        ? 'Du behöver tillåta platstjänster för Parkera (Inställningar → Integritet → Platstjänster → Safari).'
        : 'Kunde inte hitta din position. Försök igen utomhus eller sök på en adress.';
      status(msg, { err: true });
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
  );
});

// ---------- Hämta parkeringar (visar första källan direkt, fyller på med resten) ----------
async function chooseDest(dest) {
  const req = ++state.req;
  state.dest = dest;
  state.all = [];
  input.value = dest.label;
  if (!dest.isHere) saveRecent(dest);
  status(dest.isHere ? 'Letar parkeringar runt dig…' : 'Letar parkeringar runt ' + dest.label + '…', { spin: true });

  const radius = Number(settings.radius) || 1500;
  const parts = { osm: null, gbg: null };
  let pending = 2;
  let errors = 0;

  const merge = () => {
    if (req !== state.req) return; // användaren har hunnit söka något annat
    state.all = prepare([...(parts.osm || []), ...(parts.gbg || [])], dest);
    state.loading = pending > 0;
    if (state.all.length || pending === 0) render();
    if (pending > 0) status(state.all.length ? 'Hämtar fler parkeringar…' : 'Letar parkeringar runt ' + dest.label + '…', { spin: true });
    else if (!state.all.length && errors === 2) status('Kunde inte hämta parkeringsdata just nu. Försök igen om en stund.', { err: true });
    else status('');
  };

  fetchOsmParkings(dest.lat, dest.lon, radius)
    .then((items) => { parts.osm = items; })
    .catch((e) => { console.warn(e); errors++; })
    .finally(() => { pending--; merge(); });

  fetchGbgParkings(settings.appId, dest.lat, dest.lon, radius, (partial) => {
    // visa varje Göteborgslista så fort den har kommit
    parts.gbg = partial;
    merge();
  })
    .then((res) => {
      parts.gbg = res.items;
      $('gbgCredit').hidden = !res.items.length;
      if (res.transport === 'snapshot') {
        setGbgState([`Göteborgs data: uppdaterad ${new Date(res.generated).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })} – ingen egen nyckel behövs.`, 'ok']);
      } else if (settings.appId) {
        setGbgState(res.ok
          ? [`Kopplad till Göteborgs Stad – ${res.items.length} platser vid senaste sökningen.`, 'ok']
          : [`Göteborgs Stad svarade inte (${res.reason}). Appen använder bara OpenStreetMap.`, 'bad']);
      }
      if (!res.ok) errors++;
    })
    .catch((e) => { console.warn(e); errors++; })
    .finally(() => { pending--; merge(); });
}

// ---------- Bedömning för vald parkeringstid ----------
function arrival() {
  if (state.arriveAt) return new Date(state.arriveAt.getTime());
  return new Date(Date.now() + state.arriveIn * 60000);
}
// Lediga platser just nu säger inget om läget om en timme
const occupancyRelevant = () => arrival().getTime() - Date.now() <= 30 * 60000;

function evaluateAll() {
  const start = arrival();
  const occ = occupancyRelevant();
  state.all.forEach((p) => {
    if (p.freeSpacesNow === undefined) p.freeSpacesNow = p.freeSpaces;
    p.freeSpaces = occ ? p.freeSpacesNow : null;
    p.eval = evaluate(p, start, state.dur);
  });
}

const hhmm = (d) => d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
function destHeading() {
  const a = arrival();
  const sameDay = a.toDateString() === new Date().toDateString();
  const when = state.arriveIn === 0 && !state.arriveAt ? '' :
    ` · ankomst ${sameDay ? '' : a.toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short' }) + ' '}${hhmm(a)}`;
  return (state.dest.isHere ? state.dest.label : 'Mål: ' + state.dest.label) + when;
}

function costText(p) {
  const e = p.eval;
  const d = fmtDuration(state.dur);
  if (!e) return feeLabel(p);
  if (!e.ok) return `Passar inte: ${e.reason}`;
  if (e.cost === 0) return `${d}: gratis`;
  if (e.cost != null) return `${d}: ${e.approx ? 'ca ' : ''}${e.cost} kr${e.note ? ` (${e.note})` : ''}`;
  if (p.fee === 'paid') return 'Avgift (pris okänt)';
  return 'Avgift okänd';
}
function costClass(p) {
  const e = p.eval;
  if (e && !e.ok) return 'bad';
  if (e?.cost === 0 || p.fee === 'free') return 'free';
  if (p.fee === 'paid') return 'paid';
  return 'unknown';
}

// ---------- Rendering ----------
function render() {
  const { dest, all } = state;
  evaluateAll();
  $('results').hidden = false;
  $('destLabel').textContent = destHeading();

  const { nearest, nearestFree, nearestTitle } = pickOptions(all);
  const wait = state.loading ? 'Söker…' : null;
  const opts = $('options');
  opts.innerHTML = '';
  opts.append(
    ...(dest.isHere ? [] : [optionCard('dest-opt', '➜', 'Till målet', dest.label, 'Kör direkt till adressen', dest)]),
    nearest
      ? optionCard('near', 'P', nearestTitle, nearest.name, metaLine(nearest), nearest)
      : emptyCard('near', 'P', 'Närmaste parkering', wait || `Ingen parkering för ${fmtDuration(state.dur)} hittad i närheten`),
    nearestFree
      ? optionCard('free', '0', 'Närmaste gratis', nearestFree.name, metaLine(nearestFree), nearestFree)
      : emptyCard('free', '0', 'Närmaste gratis', wait || `Ingen gratisparkering för ${fmtDuration(state.dur)} inom ${formatDistance(Number(settings.radius))}`),
  );

  renderList();
  renderMap(nearest, nearestFree);
}

function metaLine(p) {
  const bits = [`${formatDistance(p.distance)} · ${walkMinutes(p.distance)} min gång`, costText(p)];
  if (p.freeSpaces != null) bits.push(`${p.freeSpaces} lediga`);
  if (p.access === 'customers') bits.push('endast kunder');
  return bits.join(' · ');
}

function optionCard(cls, icon, title, name, meta, target) {
  const div = document.createElement('div');
  div.className = 'opt ' + cls;
  div.innerHTML = `
    <div class="ico">${icon}</div>
    <div style="min-width:0">
      <div class="t">${escapeHtml(title)}</div>
      <div class="n">${escapeHtml(name)}</div>
      <div class="m">${escapeHtml(meta)}</div>
    </div>`;
  div.appendChild(actions(target, name));
  return div;
}
function actions(p, label, small = false) {
  const go = goLink(p, label, small);
  if (!(p.fee === 'paid' && p.payCode && p.eval?.ok !== false)) return go;
  const box = document.createElement('div');
  box.className = 'actions';
  const pay = document.createElement('button');
  pay.type = 'button';
  pay.className = 'pay';
  pay.textContent = 'Betala';
  pay.addEventListener('click', () => openPay(p));
  box.append(go, pay);
  return box;
}
function emptyCard(cls, icon, title, msg) {
  const div = document.createElement('div');
  div.className = 'opt none ' + cls;
  div.innerHTML = `<div class="ico">${icon}</div><div><div class="t">${escapeHtml(title)}</div><div class="m">${escapeHtml(msg)}</div></div><span></span>`;
  return div;
}
function goLink(target, label, small = false) {
  const a = document.createElement('a');
  a.className = 'go' + (small ? ' small' : '');
  a.href = navUrl(settings.navApp, target.lat, target.lon, label);
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = 'Kör';
  return a;
}

function currentFilter() {
  return { maxDistance: state.maxDist, fee: state.fee, onlyFits: state.onlyFits };
}

function renderList() {
  const items = applyFilters(state.all, currentFilter());
  const hidden = state.onlyFits ? applyFilters(state.all, { ...currentFilter(), onlyFits: false }).length - items.length : 0;
  $('hiddenCount').textContent = hidden > 0 ? `(${hidden} dolda)` : '';
  const ul = $('list');
  ul.innerHTML = '';
  if (!items.length) {
    ul.innerHTML = `<li class="empty">${state.loading ? 'Hämtar…' : 'Inga parkeringar matchar. Öka avståndet, välj kortare tid eller visa alla.'}</li>`;
    return;
  }
  items.slice(0, 40).forEach((p) => {
    const li = document.createElement('li');
    if (!fits(p)) li.className = 'nofit';
    const rule = p.fee === 'free' && p.maxStay && fits(p) ? `<span class="tag unknown">max ${escapeHtml(p.maxStay)}</span>` : '';
    const priceTxt = p.fee === 'paid' && p.price ? `<div class="m">${escapeHtml(p.price)}</div>` : '';
    const tags = [
      `<span class="tag ${costClass(p)}">${escapeHtml(costText(p))}</span>`,
      rule,
      p.freeSpaces != null ? `<span class="tag occ">${p.freeSpaces} lediga</span>` : '',
      p.access === 'customers' ? '<span class="tag cust">Endast kunder</span>' : '',
      p.gbgKind === 'private' ? '<span class="tag kind">P-hus / anläggning</span>' : '',
      p.gbgKind === 'commuter' ? '<span class="tag kind">Pendelparkering</span>' : '',
      p.source === 'gbg' ? '<span class="tag gbg">Göteborgs Stad</span>' : '',
    ].join('');
    const notes = [p.extra, p.restriction].filter(Boolean).map((t) => `<div class="m">${escapeHtml(t)}</div>`).join('')
      + `<div class="m"><a class="report" href="${escapeHtml(reportLink(p))}" target="_blank" rel="noopener">Rapportera fel</a></div>`;
    const cap = p.capacity ? ` · ${p.capacity} platser` : p.capacityEst ? ` · ca ${p.capacityEst} platser` : '';
    li.innerHTML = `<div>
        <div class="n">${escapeHtml(p.name)}</div>
        <div class="m">${tags}</div>
        <div class="m">${formatDistance(p.distance)} · ${walkMinutes(p.distance)} min gång${cap}${p.operator && p.operator !== p.name ? ' · ' + escapeHtml(p.operator) : ''}</div>${priceTxt}${notes}
      </div>`;
    li.appendChild(actions(p, p.name, true));
    ul.appendChild(li);
  });
}

function renderMap(nearest, nearestFree) {
  ensureMap();
  const { dest } = state;
  const fitTo = [[dest.lon, dest.lat]];
  const parkings = applyFilters(state.all, currentFilter()).slice(0, 80).map((p) => {
    const focus = p === nearest || p === nearestFree;
    const ok = fits(p);
    const free = ok && p.eval?.cost === 0;
    if (focus) fitTo.push([p.lon, p.lat]);
    return {
      p,
      fits: ok,
      focus,
      cls: ok ? (free ? 'free' : p.fee) : 'nofit',
      label: free ? '0' : 'P',
    };
  });
  updateMap({
    dest,
    parkings,
    fitTo,
    popupHtml: (p) => `<b>${escapeHtml(p.name)}</b><br>${escapeHtml(costText(p))}`
      + `${p.capacity ? `<br>${p.capacity} platser` : p.capacityEst ? `<br>ca ${p.capacityEst} platser (uppskattat från ytan)` : ''}${p.freeSpaces != null ? ` · ${p.freeSpaces} lediga` : ''}`
      + `${p.geomEst ? '<br><small>Streckad yta = ungefärligt läge och storlek</small>' : ''}`
      + `<br>${formatDistance(p.distance)} från målet`
      + `<br><a href="${navUrl(settings.navApp, p.lat, p.lon, p.name)}" target="_blank" rel="noopener">Kör hit</a>`
      + ` · <a class="report" href="${escapeHtml(reportLink(p))}" target="_blank" rel="noopener">Rapportera fel</a>`,
  });
}

// ---------- Parkeringstid ----------
function paintDur() {
  document.querySelectorAll('#durBar button').forEach((b) => b.classList.toggle('on', Number(b.dataset.min) === state.dur));
}
document.querySelectorAll('#durBar button').forEach((b) =>
  b.addEventListener('click', () => {
    state.dur = Number(b.dataset.min);
    store.set('dur', state.dur);
    paintDur();
    if (state.dest) render();
  }),
);
paintDur();

// ---------- Ankomsttid ----------
function paintArrive() {
  document.querySelectorAll('#arriveBar button').forEach((b) => {
    const on = state.arriveAt ? b.dataset.in === 'pick' : Number(b.dataset.in) === state.arriveIn && b.dataset.in !== 'pick';
    b.classList.toggle('on', on);
  });
  $('arrivePickBtn').textContent = state.arriveAt ? hhmm(state.arriveAt) + (state.arriveAt.toDateString() === new Date().toDateString() ? '' : ' ' + state.arriveAt.toLocaleDateString('sv-SE', { weekday: 'short' })) : 'Välj tid…';
}
document.querySelectorAll('#arriveBar button').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.in === 'pick') {
      // Dator: öppna väljaren via kod. Mobil: inputen ligger ovanpå knappen och tar trycket själv.
      prefillPicker();
      try { $('arrivePick').showPicker(); } catch { $('arrivePick').focus(); }
      return;
    }
    state.arriveAt = null;
    state.arriveIn = Number(b.dataset.in);
    paintArrive();
    if (state.dest) render();
  }),
);
const isTouch = matchMedia('(pointer: coarse)').matches;
if (!isTouch) document.documentElement.classList.add('no-touch');
function prefillPicker() {
  const d = arrival();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  $('arrivePick').value = d.toISOString().slice(0, 16);
}
$('arrivePick').addEventListener('pointerdown', prefillPicker);
$('arrivePick').addEventListener('change', (e) => {
  const v = e.target.value;
  if (!v) return;
  state.arriveAt = new Date(v);
  paintArrive();
  if (state.dest) render();
});
paintArrive();

// ---------- Betala ----------
let payTarget = null;
function openPay(p) {
  payTarget = p;
  const app = PAY_APPS[settings.payApp] || PAY_APPS.pgbg;
  $('payTitle').textContent = p.name;
  $('payPrice').textContent = [p.price, p.eval?.cost != null ? `Uppskattat: ${p.eval.cost} kr för ${fmtDuration(state.dur)}` : ''].filter(Boolean).join(' · ');
  $('payCode').textContent = p.payCode;
  setPayLink($('payOpen'), settings.payApp);
  $('payOpen').textContent = opensDirectly(settings.payApp, isIos) ? `Öppna ${app.name}` : `Öppna ${app.name} (App Store)`;
  $('payHow').textContent = settings.payApp === 'pgbgShortcut'
    ? 'Zonkoden kopieras och genvägen "Betala parkering" öppnar appen. Klistra in koden i appens sökfält. Saknas genvägen? Se ⚙︎ → Betala med.'
    : 'Zonkoden kopieras när du trycker. Klistra in den i appens sökfält. Kontrollera alltid zonkoden på skylten.';
  // Andra appar som alternativ (samma app bara en gång)
  const others = Object.keys(PAY_APPS).filter((k) => k !== settings.payApp && !(PAY_APPS[k].name === app.name) && !(PAY_APPS[k].iosOnly && !isIos));
  const box = $('payOthers');
  box.innerHTML = 'Eller betala med ';
  others.forEach((k, i) => {
    const link = document.createElement('a');
    link.textContent = PAY_APPS[k].name;
    setPayLink(link, k);
    box.append(link, document.createTextNode(i < others.length - 2 ? ', ' : i === others.length - 2 ? ' eller ' : '.'));
  });
  $('paySheet').hidden = false;
  $('sheetBg').hidden = false;
}
function setPayLink(a, key) {
  a.href = payAppUrl(key, isIos);
  // Universal Links öppnar appen bäst i samma flik; appbutiken i ny flik
  if (opensDirectly(key, isIos)) { a.removeAttribute('target'); a.removeAttribute('rel'); }
  else { a.target = '_blank'; a.rel = 'noopener'; }
  a.onclick = () => { copyCode(); };
}
async function copyCode() {
  try { await navigator.clipboard.writeText(payTarget?.payCode || ''); return true; } catch { return false; }
}
function closePay() { $('paySheet').hidden = true; $('sheetBg').hidden = true; }
$('closePay').addEventListener('click', closePay);
$('copyCode').addEventListener('click', async () => {
  $('copyCode').textContent = (await copyCode()) ? 'Kopierad ✓' : 'Markera koden';
  setTimeout(() => ($('copyCode').textContent = 'Kopiera'), 1800);
});

// ---------- Dela ----------
let snapshotAvailable = false;
loadSnapshot().then((snap) => { snapshotAvailable = Boolean(snap); });
function paintShare() {
  const proxy = hasProxy() || snapshotAvailable;
  $('shareKeyRow').hidden = proxy || !settings.appId;
  $('shareState').textContent = proxy
    ? 'Dina vänner får Göteborgs data automatiskt.'
    : settings.appId
      ? 'Utan nyckel får vännerna bara OpenStreetMap-data. Med nyckeln syns den i länken – dela bara med folk du litar på.'
      : '';
}
$('shareBtn').addEventListener('click', async () => {
  const base = location.href.split('#')[0];
  const url = shareUrl(base, !hasProxy() && !snapshotAvailable && $('shareKey').checked ? settings.appId : '');
  const text = 'Parkera – hitta närmaste parkering och gratisparkering i Göteborg';
  try {
    if (navigator.share) { await navigator.share({ title: 'Parkera', text, url }); return; }
    await navigator.clipboard.writeText(url);
    $('shareState').textContent = 'Länken är kopierad.';
  } catch (e) {
    if (e.name !== 'AbortError') $('shareState').textContent = url;
  }
});

// ---------- Filter ----------
const distVal = () => ($('distVal').textContent = formatDistance(state.maxDist));
$('maxDist').value = state.maxDist;
distVal();
const refreshListAndMap = () => { if (state.dest) { renderList(); const o = pickOptions(state.all); renderMap(o.nearest, o.nearestFree); } };
$('maxDist').addEventListener('input', (e) => {
  state.maxDist = Number(e.target.value);
  store.set('maxDist', state.maxDist);
  distVal();
  refreshListAndMap();
});
document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    state.fee = b.dataset.fee;
    refreshListAndMap();
  }),
);
$('onlyFits').checked = state.onlyFits;
$('onlyFits').addEventListener('change', (e) => {
  state.onlyFits = e.target.checked;
  store.set('onlyFits', state.onlyFits);
  refreshListAndMap();
});

// ---------- Senaste sökningar ----------
function saveRecent(d) {
  const list = store.get('recent', []).filter((r) => r.label !== d.label);
  list.unshift({ label: d.label, full: d.full, lat: d.lat, lon: d.lon });
  store.set('recent', list.slice(0, 5));
}

// ---------- Inställningar ----------
function openSettings(open) {
  $('settings').hidden = !open;
  $('sheetBg').hidden = !open;
}
$('navApp').value = settings.navApp;
$('payApp').value = settings.payApp;
const paintHowto = () => { $('shortcutHowto').hidden = $('payApp').value !== 'pgbgShortcut' || !isIos; };
$('payApp').addEventListener('change', () => { paintHowto(); $('shortcutHowto').open = $('payApp').value === 'pgbgShortcut'; });
paintHowto();
$('radius').value = String(settings.radius);
$('appId').value = settings.appId;
$('settingsBtn').addEventListener('click', () => { paintShare(); openSettings(true); });
$('sheetBg').addEventListener('click', () => ($('paySheet').hidden ? closeSettings() : closePay()));
$('closeSettings').addEventListener('click', () => closeSettings());

function setGbgState([msg, cls]) {
  const el = $('gbgState');
  el.textContent = msg;
  el.className = 'hint ' + (cls || '');
}
loadSnapshot().then((snap) => {
  if (snap) setGbgState([`Göteborgs data: uppdaterad ${new Date(snap.generated).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })} – ingen egen nyckel behövs.`, 'ok']);
});
if (hasProxy()) setGbgState(['Göteborgs data hämtas via Parkeras server – ingen egen nyckel behövs.', 'ok']);
else if (settings.appId) setGbgState(['Nyckel sparad. Tryck "Testa" för att kontrollera den.', '']);

$('testKey').addEventListener('click', async () => {
  const key = $('appId').value.trim();
  if (!key) return setGbgState(['Klistra in din APPID först.', 'bad']);
  setGbgState(['Testar mot Göteborgs Stad…', '']);
  const res = await testGbgKey(key);
  if (res.ok) {
    const free = res.items.filter((p) => p.fee === 'free').length;
    const occ = res.items.filter((p) => p.freeSpaces != null).length;
    setGbgState([`Fungerar! ${res.items.length} platser runt Kungsportsplatsen (${free} gratis${occ ? `, ${occ} med lediga platser` : ''}). Tryck Klar för att spara.`, 'ok']);
  } else {
    setGbgState([`Fungerade inte: ${res.reason}. Kontrollera att nyckeln är rätt kopierad.`, 'bad']);
  }
});

function closeSettings() {
  const prevRadius = settings.radius;
  const prevApp = settings.appId;
  settings.navApp = $('navApp').value;
  settings.payApp = $('payApp').value;
  settings.radius = Number($('radius').value);
  settings.appId = $('appId').value.trim();
  Object.entries(settings).forEach(([k, v]) => store.set(k === 'payApp' ? 'payApp2' : k, v));
  openSettings(false);
  if (!state.dest) return;
  if (prevRadius !== settings.radius || prevApp !== settings.appId) chooseDest(state.dest);
  else render(); // uppdatera Kör-länkar för ny kartapp
}

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
