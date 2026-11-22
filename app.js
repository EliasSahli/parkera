// app.js – UI och flöde
import {
  prepare, pickOptions, applyFilters, navUrl, feeLabel, formatDistance, walkMinutes,
} from './core.js';
import { geocode, fetchOsmParkings, fetchGbgParkings, testGbgKey } from './sources.js';

const $ = (id) => document.getElementById(id);

// ---------- Inställningar (lagras lokalt i webbläsaren) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('parkera.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('parkera.' + k, JSON.stringify(v)); } catch { /* privat läge */ } },
};
const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
const settings = {
  navApp: store.get('navApp', isApple ? 'apple' : 'google'),
  radius: store.get('radius', 1500),
  appId: store.get('appId', ''),
};

// Nyckel via länk: öppna .../?appid=DIN-NYCKEL en gång på en ny enhet så sparas den där.
// Nyckeln tas sedan bort ur adressfältet.
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

const state = { dest: null, all: [], maxDist: store.get('maxDist', 800), fee: 'all' };

// ---------- Karta ----------
let map, layer;
function ensureMap() {
  if (map || !window.L) return;
  map = L.map('map', { zoomControl: false, attributionControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
}
function pin(cls, text) {
  return L.divIcon({ className: '', html: `<div class="pin ${cls}">${text}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
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

// ---------- Sök ----------
$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  $('q').blur();
  hideSuggestions();
  status('Söker adress…', { spin: true });
  try {
    const hits = await geocode(q);
    if (!hits.length) return status('Hittade ingen adress. Prova att lägga till stad, t.ex. "…, Göteborg".', { err: true });
    if (hits.length === 1) return chooseDest(hits[0]);
    showSuggestions(hits);
    status('');
  } catch (err) {
    console.error(err);
    status('Adressökningen svarar inte just nu. Försök igen om en stund.', { err: true });
  }
});

function showSuggestions(hits) {
  const ul = $('suggestions');
  ul.innerHTML = '';
  hits.forEach((h) => {
    const li = document.createElement('li');
    li.innerHTML = `${escapeHtml(h.label)}<small>${escapeHtml(h.full)}</small>`;
    li.addEventListener('click', () => { hideSuggestions(); chooseDest(h); });
    ul.appendChild(li);
  });
  ul.hidden = false;
}
function hideSuggestions() { $('suggestions').hidden = true; }

async function chooseDest(dest) {
  state.dest = dest;
  $('q').value = dest.label;
  saveRecent(dest);
  status('Letar parkeringar runt ' + dest.label + '…', { spin: true });
  $('results').hidden = true;

  const radius = Number(settings.radius) || 1500;
  const [osm, gbg] = await Promise.allSettled([
    fetchOsmParkings(dest.lat, dest.lon, radius),
    fetchGbgParkings(settings.appId, dest.lat, dest.lon, radius),
  ]);

  const osmItems = osm.status === 'fulfilled' ? osm.value : [];
  const gbgRes = gbg.status === 'fulfilled' ? gbg.value : { items: [], ok: false, reason: String(gbg.reason) };
  $('gbgCredit').hidden = !gbgRes.items.length;
  if (settings.appId) {
    setGbgState(gbgRes.ok
      ? [`Kopplad till Göteborgs Stad – ${gbgRes.items.length} platser vid senaste sökningen.`, 'ok']
      : [`Göteborgs Stad svarade inte (${gbgRes.reason}). Appen använder bara OpenStreetMap.`, 'bad']);
  }

  if (osm.status === 'rejected' && !gbgRes.items.length) {
    console.error(osm.reason);
    status('Kunde inte hämta parkeringsdata just nu. Försök igen om en stund.', { err: true });
    return;
  }

  state.all = prepare([...osmItems, ...gbgRes.items], dest);
  status('');
  render();
}

// ---------- Rendering ----------
function render() {
  const { dest, all } = state;
  $('results').hidden = false;
  $('destLabel').textContent = 'Mål: ' + dest.label;

  const { nearest, nearestFree } = pickOptions(all);
  const opts = $('options');
  opts.innerHTML = '';
  opts.append(
    optionCard('dest-opt', '➜', 'Till målet', dest.label, 'Kör direkt till adressen', dest),
    nearest
      ? optionCard('near', 'P', 'Närmaste parkering', nearest.name, metaLine(nearest), nearest)
      : emptyCard('near', 'P', 'Närmaste parkering', 'Ingen parkering hittad i närheten'),
    nearestFree
      ? optionCard('free', '0', 'Närmaste gratis', nearestFree.name, metaLine(nearestFree), nearestFree)
      : emptyCard('free', '0', 'Närmaste gratis', `Ingen känd gratisparkering inom ${formatDistance(Number(settings.radius))}`),
  );

  renderList();
  renderMap(nearest, nearestFree);
}

function metaLine(p) {
  const bits = [`${formatDistance(p.distance)} · ${walkMinutes(p.distance)} min gång`, feeLabel(p)];
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
  div.appendChild(goLink(target, name));
  return div;
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

function renderList() {
  const items = applyFilters(state.all, { maxDistance: state.maxDist, fee: state.fee });
  const ul = $('list');
  ul.innerHTML = '';
  if (!items.length) {
    ul.innerHTML = '<li class="empty">Inga parkeringar matchar filtret. Öka avståndet eller välj "Alla".</li>';
    return;
  }
  items.slice(0, 40).forEach((p) => {
    const li = document.createElement('li');
    const tags = [
      `<span class="tag ${p.fee}">${escapeHtml(feeLabel(p))}</span>`,
      p.freeSpaces != null ? `<span class="tag occ">${p.freeSpaces} lediga</span>` : '',
      p.access === 'customers' ? '<span class="tag cust">Endast kunder</span>' : '',
      p.source === 'gbg' ? '<span class="tag gbg">Göteborgs Stad</span>' : '',
    ].join('');
    const extra = p.extra ? `<div class="m">${escapeHtml(p.extra)}</div>` : '';
    const cap = p.capacity ? ` · ${p.capacity} platser` : '';
    li.innerHTML = `<div>
        <div class="n">${escapeHtml(p.name)}</div>
        <div class="m">${tags}</div>
        <div class="m">${formatDistance(p.distance)} · ${walkMinutes(p.distance)} min gång${cap}${p.operator && p.operator !== p.name ? ' · ' + escapeHtml(p.operator) : ''}</div>${extra}
      </div>`;
    li.appendChild(goLink(p, p.name, true));
    ul.appendChild(li);
  });
}

function renderMap(nearest, nearestFree) {
  ensureMap();
  if (!map) return;
  layer.clearLayers();
  const { dest } = state;
  const pts = [[dest.lat, dest.lon]];
  L.marker([dest.lat, dest.lon], { icon: pin('dest', '★'), zIndexOffset: 1000 }).addTo(layer).bindPopup(escapeHtml(dest.label));
  applyFilters(state.all, { maxDistance: state.maxDist, fee: state.fee }).slice(0, 60).forEach((p) => {
    const highlight = p === nearest || p === nearestFree;
    L.marker([p.lat, p.lon], { icon: pin(p.fee, p.fee === 'free' ? '0' : 'P'), zIndexOffset: highlight ? 500 : 0 })
      .addTo(layer)
      .bindPopup(`<b>${escapeHtml(p.name)}</b><br>${escapeHtml(feeLabel(p))}<br>${formatDistance(p.distance)} från målet<br><a href="${navUrl(settings.navApp, p.lat, p.lon, p.name)}" target="_blank" rel="noopener">Kör hit</a>`);
    if (highlight) pts.push([p.lat, p.lon]);
  });
  setTimeout(() => {
    map.invalidateSize();
    if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 17 });
    else map.setView(pts[0], 16);
  }, 50);
}

// ---------- Filter ----------
const distVal = () => ($('distVal').textContent = formatDistance(state.maxDist));
$('maxDist').value = state.maxDist;
distVal();
$('maxDist').addEventListener('input', (e) => {
  state.maxDist = Number(e.target.value);
  store.set('maxDist', state.maxDist);
  distVal();
  if (state.dest) { renderList(); renderMap(...Object.values(pickOptions(state.all))); }
});
document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    state.fee = b.dataset.fee;
    if (state.dest) { renderList(); renderMap(...Object.values(pickOptions(state.all))); }
  }),
);

// ---------- Senaste sökningar ----------
function saveRecent(d) {
  const list = store.get('recent', []).filter((r) => r.label !== d.label);
  list.unshift({ label: d.label, full: d.full, lat: d.lat, lon: d.lon });
  store.set('recent', list.slice(0, 5));
  renderRecent();
}
function renderRecent() {
  const box = $('recent');
  box.innerHTML = '';
  store.get('recent', []).forEach((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = r.label.split(',')[0];
    b.title = r.full || r.label;
    b.addEventListener('click', () => chooseDest(r));
    box.appendChild(b);
  });
}
renderRecent();

// ---------- Inställningar ----------
function openSettings(open) {
  $('settings').hidden = !open;
  $('sheetBg').hidden = !open;
}
$('navApp').value = settings.navApp;
$('radius').value = String(settings.radius);
$('appId').value = settings.appId;
$('settingsBtn').addEventListener('click', () => openSettings(true));
$('sheetBg').addEventListener('click', () => closeSettings());
$('closeSettings').addEventListener('click', () => closeSettings());
function setGbgState([msg, cls]) {
  const el = $('gbgState');
  el.textContent = msg;
  el.className = 'hint ' + (cls || '');
}
if (settings.appId) setGbgState(['Nyckel sparad. Tryck "Testa" för att kontrollera den.', '']);

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
  settings.radius = Number($('radius').value);
  settings.appId = $('appId').value.trim();
  Object.entries(settings).forEach(([k, v]) => store.set(k, v));
  openSettings(false);
  if (!state.dest) return;
  if (prevRadius !== settings.radius || prevApp !== settings.appId) chooseDest(state.dest);
  else render(); // uppdatera Kör-länkar för ny kartapp
}

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
