// map.js – kartan (MapLibre GL + OpenFreeMap, färgsatt som Apple Kartor)
// Visar parkeringsytor som gröna konturer och nålar för varje plats.
import { appleStyle, STYLE_URL } from './mapstyle.js';

let map = null;
let ready = null;
let baseStyle = null;
let markers = [];
let destMarker = null;
let pending = null;
let onPick = null;

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => darkQuery.matches;

const AREA_SRC = 'parkera-areas';

// Ytornas färg matchar nålen: grönt = gratis, gult = avgift, grått = okänt / passar inte
export const AREA_COLORS = {
  free: '#2fb34f',
  freeDark: '#3ccf62',
  paid: '#e8a317',
  paidDark: '#f0b429',
  unknown: '#8e95a3',
  nofit: '#8e95a3',
};

async function loadBaseStyle() {
  if (baseStyle) return baseStyle;
  const res = await fetch(STYLE_URL);
  if (!res.ok) throw new Error('Kartstilen kunde inte hämtas');
  baseStyle = await res.json();
  return baseStyle;
}

function addOverlayLayers() {
  if (map.getSource(AREA_SRC)) return;
  const dark = isDark();
  const color = ['match', ['get', 'cls'],
    'free', dark ? AREA_COLORS.freeDark : AREA_COLORS.free,
    'paid', dark ? AREA_COLORS.paidDark : AREA_COLORS.paid,
    AREA_COLORS.nofit];
  map.addSource(AREA_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  // Fyllning för ytor (parkeringsplatser, p-hus)
  map.addLayer({
    id: 'parkera-fill',
    type: 'fill',
    source: AREA_SRC,
    filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
    paint: { 'fill-color': color, 'fill-opacity': ['case', ['==', ['get', 'fits'], true], 0.22, 0.12] },
  });
  // Kontur för ytor
  map.addLayer({
    id: 'parkera-outline',
    type: 'line',
    source: AREA_SRC,
    filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
    paint: {
      'line-color': color,
      'line-width': ['interpolate', ['linear'], ['zoom'], 14, ['case', ['get', 'focus'], 2, 1.2], 18, ['case', ['get', 'focus'], 4, 2.5]],
      'line-opacity': 0.95,
    },
  });
  // Gatuparkering som remsor längs gatan
  map.addLayer({
    id: 'parkera-strip',
    type: 'line',
    source: AREA_SRC,
    filter: ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': color,
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2, 16, 6, 19, 14],
      'line-opacity': ['case', ['==', ['get', 'focus'], true], 0.8, ['==', ['get', 'fits'], true], 0.55, 0.3],
    },
  });
  for (const id of ['parkera-fill', 'parkera-strip']) {
    map.on('click', id, (e) => {
      const f = e.features?.[0];
      if (f && onPick) onPick(f.properties.id);
    });
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
}

export function initMap(container, { onSelect } = {}) {
  if (map) return ready;
  if (!window.maplibregl) return Promise.reject(new Error('MapLibre saknas'));
  onPick = onSelect;
  ready = loadBaseStyle().then((style) => new Promise((resolve) => {
    map = new maplibregl.Map({
      container,
      style: appleStyle(style, isDark()),
      center: [11.9746, 57.7089],
      zoom: 14,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    map.on('load', () => {
      addOverlayLayers();
      resolve(map);
      if (pending) { const p = pending; pending = null; updateMap(p); }
    });
    // Följ telefonens ljust/mörkt läge
    darkQuery.addEventListener('change', () => {
      map.setStyle(appleStyle(baseStyle, isDark()));
      map.once('styledata', () => {
        addOverlayLayers();
        if (lastData) updateMap(lastData);
      });
    });
  }));
  return ready;
}

let lastData = null;

// MapLibre styr ytterelementets transform (positionen), så droppformen roteras på ett inre element
function pinEl(cls, text, title) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `mpin-wrap ${cls.includes('focus') ? 'focus' : ''}`;
  el.setAttribute('aria-label', title);
  el.innerHTML = `<div class="mpin ${cls}"><span>${text}</span></div>`;
  return el;
}

// data: { dest, parkings: [{p, cls, label, fits, focus}], fitTo: [[lon,lat],...] , popupHtml(p) }
export function updateMap(data) {
  lastData = data;
  if (!map || !map.isStyleLoaded() || !map.getSource(AREA_SRC)) { pending = data; return; }
  const { dest, parkings, fitTo, popupHtml } = data;

  // Ytor
  const features = parkings
    .filter(({ p }) => p.geom && p.geom.type !== 'Point')
    .map(({ p, fits, focus, cls }) => ({ type: 'Feature', geometry: p.geom, properties: { id: p.id, fits, cls, focus: Boolean(focus) } }));
  map.getSource(AREA_SRC).setData({ type: 'FeatureCollection', features });

  // Nålar
  markers.forEach((m) => m.remove());
  markers = parkings.map(({ p, cls, label, focus }) => {
    const el = pinEl(`${cls}${focus ? ' focus' : ''}`, label, p.name);
    const mk = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([p.lon, p.lat])
      .setPopup(new maplibregl.Popup({ offset: 30, closeButton: false, maxWidth: '260px' }).setHTML(popupHtml(p)))
      .addTo(map);
    return mk;
  });

  // Mål / min position
  destMarker?.remove();
  const del = document.createElement('div');
  del.className = 'mdest-wrap';
  del.innerHTML = `<div class="${dest.isHere ? 'mdot' : 'mdest'}"></div>`;
  destMarker = new maplibregl.Marker({ element: del, anchor: dest.isHere ? 'center' : 'bottom' })
    .setLngLat([dest.lon, dest.lat]).addTo(map);

  // Zooma in på målet och förslagen
  map.resize();
  if (fitTo.length > 1) {
    const lons = fitTo.map((c) => c[0]);
    const lats = fitTo.map((c) => c[1]);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
      padding: { top: 70, bottom: 40, left: 50, right: 50 }, maxZoom: 17, duration: 600,
    });
  } else {
    map.easeTo({ center: [dest.lon, dest.lat], zoom: 16, duration: 600 });
  }
}

export function openPopupFor(id) {
  const i = lastData?.parkings.findIndex(({ p }) => p.id === id);
  if (i == null || i < 0) return;
  markers.forEach((m) => m.getPopup()?.isOpen() && m.togglePopup());
  markers[i].togglePopup();
}
