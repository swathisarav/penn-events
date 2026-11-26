/* Penn Grad Events — map + cards. Data comes from data/events.json (built daily). */
(() => {
  "use strict";

  const TZ = "America/New_York";
  const MAX_BOUNDS = [[-75.2140, 39.9340], [-75.1760, 39.9620]]; // campus + Pennovation only
  const VIEWS = {
    campus: { center: [-75.1958, 39.9527], zoom: 15.9, pitch: 42, bearing: -12 },
    pennovation: { center: [-75.2012, 39.9409], zoom: 16.6, pitch: 42, bearing: -12 },
    all: { center: [-75.1975, 39.9465], zoom: 15.0, pitch: 38, bearing: -12 },
  };
  const ROADS = ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"];
  const CATEGORY_LABEL = { academic: "ACADEMIC", career: "CAREER", festive: "FESTIVE", food: "FOOD", social: "SOCIAL" };

  const $ = (s) => document.querySelector(s);
  const state = { data: null, day: null, filters: new Set(), markers: [], popup: null, is3d: true, today: null };

  // ───────────────────────── utilities
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (u && /^https?:\/\//i.test(u) ? u : null);
  const pad = (n) => String(n).padStart(2, "0");

  function nowET() {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
  }
  function toMin(t) {
    const m = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m/i.exec(t || "");
    if (!m) return null;
    return ((+m[1] % 12) + (m[3].toLowerCase() === "p" ? 12 : 0)) * 60 + +(m[2] || 0);
  }
  const asDate = (iso) => new Date(iso + "T12:00:00Z");
  function addDays(iso, n) {
    const d = asDate(iso); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const fmt = (iso, opts) => asDate(iso).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });

  function status(e) {
    const n = nowET();
    if (e.date !== n.date) return e.date < n.date ? "past" : "future";
    const s = toMin(e.start);
    if (s == null) return "future";
    // End = listed end time, else start + listed duration, else assume 1 hour.
    const end = toMin(e.end) ?? s + (e.durationMin || 60);
    if (n.min >= end) return "past";
    if (n.min >= s) return "now";
    if (s - n.min <= 60) return "soon";
    return "future";
  }
  const minsUntil = (e) => toMin(e.start) - nowET().min;
  function timeRange(e) {
    if (!e.start) return "TIME TBA";
    return e.end ? `${e.start} – ${e.end}` : e.start;
  }
  // Most campus events are free but the emails rarely say so, so the FREE filter only
  // hides events the sheet explicitly marks as paid. Tags still show confirmed info only.
  const isFree = (e) => e.cost !== "paid";
  const COST_TAG = {
    free: `<span class="tag solid">FREE</span>`,
    "likely-free": `<span class="tag solid" title="No cost mentioned in the listing">FREE?</span>`,
    "partly-free": `<span class="tag" title="Some parts are free">PARTLY FREE</span>`,
    paid: `<span class="tag">PAID</span>`,
  };

  // ───────────────────────── wireframe poster (fallback)
  function wrap(text, max, lines) {
    const words = text.split(/\s+/); const out = [""];
    for (const w of words) {
      const cur = out[out.length - 1];
      if ((cur + " " + w).trim().length <= max) out[out.length - 1] = (cur + " " + w).trim();
      else if (out.length < lines) out.push(w.length > max ? w.slice(0, max - 1) + "…" : w);
      else { out[out.length - 1] = cur.replace(/.?$/, "…"); break; }
    }
    return out;
  }
  const MOTIFS = {
    academic: `<path d="M0-78L68-39V39L0 78-68 39V-39Z"/><path d="M-68-39L0 0 68-39M0 0V78"/>
      <ellipse rx="104" ry="30" transform="rotate(-22)" stroke-dasharray="4 4"/><circle r="5" cx="88" cy="-34" fill="#000"/>`,
    career: `<path d="M-80 70H85"/><rect x="-70" y="30" width="28" height="40"/><rect x="-30" y="0" width="28" height="70"/>
      <rect x="10" y="-30" width="28" height="100"/><rect x="50" y="-60" width="28" height="130"/>
      <path d="M-74 10L-20-25 20-45 70-90M52-90H70V-72" stroke-dasharray="0"/>`,
    festive: Array.from({ length: 16 }, (_, i) => {
      const a = (i * Math.PI) / 8, r = i % 2 ? 60 : 92;
      return `<path d="M${(22 * Math.cos(a)).toFixed(1)} ${(22 * Math.sin(a)).toFixed(1)}L${(r * Math.cos(a)).toFixed(1)} ${(r * Math.sin(a)).toFixed(1)}"/>`;
    }).join("") + `<circle r="14"/><circle r="100" stroke-dasharray="2 6"/>`,
    food: `<circle r="62"/><circle r="44" stroke-dasharray="4 3"/><path d="M-92-55V-15M-100-55V-25Q-92-12-84-25V-55M-92-15V70"/>
      <path d="M92 70V-55Q108-30 92-5"/><path d="M-20-80q8-10 0-20t0-20M0-80q8-10 0-20t0-20M20-80q8-10 0-20t0-20"/>`,
    social: `<circle cx="-30" cy="-20" r="50"/><circle cx="30" cy="-20" r="50"/><circle cx="0" cy="32" r="50"/>
      <circle r="6" fill="#000"/>`,
  };
  function posterSVG(e, idx) {
    const title = wrap((e.title || "").toUpperCase(), 17, 4);
    let grid = "";
    for (let x = 20; x < 300; x += 20) grid += `<path d="M${x} 0V400"/>`;
    for (let y = 20; y < 400; y += 20) grid += `<path d="M0 ${y}H300"/>`;
    const place = e.places?.[0]?.name || (e.virtual ? "VIRTUAL" : (e.where || "TBA"));
    return `<svg viewBox="0 0 300 400" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Poster: ${esc(e.title)}">
      <rect width="300" height="400" fill="#fff"/>
      <g stroke="#ececec" stroke-width="1">${grid}</g>
      <rect x="12" y="12" width="276" height="376" fill="none" stroke="#000" stroke-width="1.5"/>
      <g font-family="IBM Plex Mono, monospace" font-size="10" letter-spacing="1.5" fill="#000">
        <text x="24" y="34">NO.${esc(idx)} / ${CATEGORY_LABEL[e.category] || "EVENT"}</text>
        <text x="276" y="34" text-anchor="end">${esc(fmt(e.date, { month: "short", day: "numeric" }).toUpperCase())}</text>
      </g>
      <path d="M12 46H288" stroke="#000"/>
      <g transform="translate(150 148)" fill="none" stroke="#000" stroke-width="1.4" stroke-linejoin="round">${MOTIFS[e.category] || MOTIFS.social}</g>
      <path d="M12 246H288" stroke="#000"/>
      <g font-family="Space Grotesk, Arial, sans-serif" font-weight="700" font-size="19" fill="#000">
        ${title.map((l, i) => `<text x="24" y="${274 + i * 22}">${esc(l)}</text>`).join("")}
      </g>
      <path d="M12 352H288" stroke="#000" stroke-dasharray="3 3"/>
      <g font-family="IBM Plex Mono, monospace" font-size="10" letter-spacing="1" fill="#000">
        <text x="24" y="372">${esc(timeRange(e).toUpperCase())}</text>
        <text x="276" y="372" text-anchor="end">${esc(wrap(place.toUpperCase(), 20, 1)[0])}</text>
      </g>
    </svg>`;
  }
  function posterHTML(e, idx) {
    const url = safeUrl(e.poster);
    return url ? `<img src="${esc(url)}" alt="Poster for ${esc(e.title)}" loading="lazy" referrerpolicy="no-referrer"
      onerror="this.replaceWith(document.createRange().createContextualFragment(this.dataset.fb))" data-fb="${esc(posterSVG(e, idx))}">`
      : posterSVG(e, idx);
  }

  // ───────────────────────── map
  const W = (major, minor, service) => ["match", ["get", "class"],
    ["motorway", "trunk", "primary", "secondary"], major, "tertiary", major * 0.8, "minor", minor, service];
  const roadW = (x = 0) => ["interpolate", ["exponential", 1.6], ["zoom"], 14, W(3 + x, 1.4 + x, 0.6 + x), 18, W(26 + x, 14 + x, 6 + x)];
  const roadWidth = roadW();
  const style = {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      omt: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
      hl: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    light: { anchor: "viewport", color: "#ffffff", intensity: 0.5, position: [1.4, 200, 35] },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#fbfbfa" } },
      { id: "park", type: "fill", source: "omt", "source-layer": "park", paint: { "fill-color": "#f2f2f0" } },
      { id: "green", type: "fill", source: "omt", "source-layer": "landcover",
        filter: ["in", ["get", "class"], ["literal", ["grass", "wood"]]], paint: { "fill-color": "#f2f2f0" } },
      { id: "campus", type: "fill", source: "omt", "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["university", "college"]]], paint: { "fill-color": "#f6f6f6" } },
      { id: "campus-edge", type: "line", source: "omt", "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["university", "college"]]],
        paint: { "line-color": "#000", "line-width": 1, "line-dasharray": [4, 3], "line-opacity": 0.55 } },
      // Lawns / open spaces hosting events get colour.
      { id: "lawn-hl", type: "fill", source: "hl", filter: ["==", ["get", "kind"], "lawn"],
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.85 } },
      { id: "lawn-hl-edge", type: "line", source: "hl", filter: ["==", ["get", "kind"], "lawn"],
        paint: { "line-color": "#000", "line-width": 1.2 } },
      { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": "#eeeeee" } },
      { id: "water-edge", type: "line", source: "omt", "source-layer": "water", paint: { "line-color": "#000", "line-width": 1.1 } },
      { id: "path", type: "line", source: "omt", "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ["path", "track"]]],
        paint: { "line-color": "#8a8a8a", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.4, 18, 1.4], "line-dasharray": [2, 2] } },
      { id: "rail", type: "line", source: "omt", "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ["rail", "transit"]]],
        paint: { "line-color": "#000", "line-width": 1, "line-dasharray": [6, 3] } },
      { id: "road-casing", type: "line", source: "omt", "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ROADS]], layout: { "line-join": "round" },
        paint: { "line-color": "#111", "line-width": roadW(1.6) } },
      { id: "road", type: "line", source: "omt", "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ROADS]], layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": roadWidth } },
      { id: "building-foot", type: "line", source: "omt", "source-layer": "building",
        paint: { "line-color": "#000", "line-width": 0.7 } },
      { id: "building-3d", type: "fill-extrusion", source: "omt", "source-layer": "building", minzoom: 14,
        paint: {
          "fill-extrusion-color": "#ffffff",
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": 0.72,
          "fill-extrusion-vertical-gradient": true,
        } },
      // Buildings hosting events: drawn in (approximately) their real exterior colour.
      { id: "building-hl", type: "fill-extrusion", source: "hl", filter: ["==", ["get", "kind"], "building"],
        paint: {
          "fill-extrusion-color": ["get", "color"],
          "fill-extrusion-height": ["+", ["get", "h"], 0.4],
          "fill-extrusion-base": ["get", "b"],
          "fill-extrusion-opacity": 0.97,
          "fill-extrusion-vertical-gradient": true,
        } },
      { id: "road-label", type: "symbol", source: "omt", "source-layer": "transportation_name", minzoom: 15,
        filter: ["in", ["get", "class"], ["literal", ROADS]],
        layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"],
          "text-size": 10, "text-letter-spacing": 0.15, "text-transform": "uppercase" },
        paint: { "text-color": "#222", "text-halo-color": "#fff", "text-halo-width": 2 } },
      { id: "water-label", type: "symbol", source: "omt", "source-layer": "waterway",
        layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-font": ["Noto Sans Italic"],
          "text-size": 11, "text-letter-spacing": 0.3, "text-transform": "uppercase" },
        paint: { "text-color": "#555", "text-halo-color": "#eee", "text-halo-width": 2 } },
    ],
  };

  const map = new maplibregl.Map({
    container: "map", style, ...VIEWS.campus,
    maxBounds: MAX_BOUNDS, minZoom: 14.2, maxZoom: 19, maxPitch: 70,
    antialias: true, attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.on("error", (ev) => console.error("map:", ev.error?.message || ev));
  new ResizeObserver(() => map.resize()).observe(document.getElementById("map"));
  map.on("mousemove", (ev) => {
    $("#coords").textContent = `LAT ${ev.lngLat.lat.toFixed(5)}  LNG ${ev.lngLat.lng.toFixed(5)}  Z ${map.getZoom().toFixed(1)}`;
  });
  for (const [label, lngLat] of [["PENNOVATION WORKS", [-75.2006, 39.9396]]]) {
    const el = document.createElement("div"); el.className = "landmark"; el.textContent = label;
    new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(lngLat).addTo(map);
  }
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("[data-view]").forEach((x) => x.classList.toggle("on", x === b));
    const v = VIEWS[b.dataset.view];
    map.flyTo({ ...v, pitch: state.is3d ? v.pitch : 0, bearing: state.is3d ? v.bearing : 0, duration: 1400 });
  }));
  $("#toggle3d").addEventListener("click", () => {
    state.is3d = !state.is3d;
    $("#toggle3d").textContent = state.is3d ? "3D ✓" : "3D ✗";
    map.easeTo({ pitch: state.is3d ? 42 : 0, bearing: state.is3d ? -12 : 0, duration: 900 });
  });

  // ───────────────────────── rendering
  // Filter menu. "all" groups: an event must match every ticked item.
  // "any" groups: an event must match at least one ticked item. Add new filters here.
  const startMin = (e) => toMin(e.start);
  const FILTER_GROUPS = [
    { label: "OFFERED", mode: "all", items: [
      ["food", "Food", (e) => !!e.food],
      ["free", "Free", isFree, "Hides only events the sheet marks as paid"],
      ["norsvp", "No RSVP needed", (e) => !e.registration],
    ] },
    { label: "WHERE", mode: "any", items: [
      ["map", "On campus", (e) => e.places.length > 0, "Events on campus or at Pennovation"],
      ["virtual", "Virtual / hybrid", (e) => e.virtual],
      ["away", "Beyond campus", (e) => !e.places.length && !e.virtual],
    ] },
    { label: "TYPE", mode: "any", items: [
      ["academic", "Academic", (e) => e.category === "academic"],
      ["career", "Career", (e) => e.category === "career"],
      ["social", "Social", (e) => e.category === "social" || e.category === "food"],
      ["festive", "Festive", (e) => e.category === "festive"],
    ] },
    { label: "WHEN", mode: "any", items: [
      ["morning", "Morning", (e) => startMin(e) != null && startMin(e) < 720],
      ["afternoon", "Afternoon", (e) => startMin(e) >= 720 && startMin(e) < 1020],
      ["evening", "Evening", (e) => startMin(e) >= 1020],
    ] },
    { label: "STATUS", mode: "all", items: [
      ["hideEnded", "Hide ended", (e) => status(e) !== "past"],
    ] },
  ];
  function passesFilters(e) {
    return FILTER_GROUPS.every(({ mode, items }) => {
      const on = items.filter(([key]) => state.filters.has(key));
      if (!on.length) return true;
      return mode === "all" ? on.every(([, , test]) => test(e)) : on.some(([, , test]) => test(e));
    });
  }
  const QUICK = ["map", "free"];          // shown outside the FILTERS button
  const chip = ([key, text, , tip]) => `<button class="chip" data-filter="${key}" aria-pressed="${state.filters.has(key)}"${tip ? ` title="${esc(tip)}"` : ""}>${esc(text.toUpperCase())}</button>`;
  function renderFilterPanel() {
    const all = FILTER_GROUPS.flatMap((g) => g.items);
    $("#quick-filters").innerHTML = QUICK.map((k) => chip(all.find(([key]) => key === k))).join("");
    $("#filter-panel").innerHTML = FILTER_GROUPS.map(({ label, items }) => {
      const rest = items.filter(([key]) => !QUICK.includes(key));
      return rest.length ? `<div class="fgroup"><div class="fgroup-label">${label}</div>
        <div class="fgroup-chips">${rest.map(chip).join("")}</div></div>` : "";
    }).join("");
    const n = [...state.filters].filter((k) => !QUICK.includes(k)).length;
    $("#filter-count").textContent = n ? ` · ${n}` : "";
    $("#filter-toggle").classList.toggle("active", n > 0);
    $("#filter-clear").hidden = !state.filters.size;
  }

  function dayEvents() {
    const evs = state.data.events.filter((e) => e.date === state.day);
    return evs.map((e, i) => ({ ...e, idx: pad(i + 1) })).filter(passesFilters);
  }

  function renderDays() {
    const today = state.today;
    const dates = new Set([today, addDays(today, 1)]);
    state.data.events.forEach((e) => { if (e.date >= today) dates.add(e.date); });
    const html = [...dates].sort().map((d) => {
      const n = state.data.events.filter((e) => e.date === d).length;
      const name = d === today ? "TODAY" : d === addDays(today, 1) ? "TMRW" : fmt(d, { weekday: "short" }).toUpperCase();
      return `<button class="day" role="tab" data-day="${d}" aria-selected="${d === state.day}">
        <span class="dname">${name}</span><span class="dnum">${fmt(d, { day: "numeric" })}</span>
        <span class="dcount">${n || "–"}</span></button>`;
    }).join("");
    $("#days").innerHTML = html;
    $("#days").querySelectorAll(".day").forEach((b) => b.addEventListener("click", () => selectDay(b.dataset.day)));
  }

  function card(e) {
    const st = status(e);
    const tags = [];
    if (COST_TAG[e.cost]) tags.push(COST_TAG[e.cost]);
    if (e.food) tags.push(`<span class="tag solid">FOOD</span>`);
    if (e.registration) tags.push(`<span class="tag">RSVP</span>`);
    if (e.virtual) tags.push(`<span class="tag">${e.places.length ? "HYBRID" : "VIRTUAL"}</span>`);
    if (!e.places.length && !e.virtual) tags.push(`<span class="tag">OFF MAP</span>`);
    tags.push(`<span class="tag">${CATEGORY_LABEL[e.category] || "EVENT"}</span>`);
    const badge = st === "now" ? `<span class="badge-now">● NOW</span>`
      : st === "soon" ? `<span class="badge-soon">IN ${minsUntil(e)} MIN</span>`
      : st === "past" ? `<span class="badge-past">✓ ENDED</span>` : "";
    const place = e.places[0]?.name || e.where || "Location TBA";
    return `<article class="card ${st}" data-id="${esc(e.id)}" tabindex="0" aria-label="${esc(e.title)}">
      <div class="card-poster">${posterHTML(e, e.idx)}</div>
      <div class="card-body">
        <div class="card-meta"><span class="idx">${e.idx}</span><span class="time">${esc(timeRange(e))}</span>${badge}</div>
        <h3>${esc(e.title)}</h3>
        <p class="place">${e.places[0] ? `<i class="swatch" style="background:${okColor(e.places[0].color)}"></i>` : "◎ "}${esc(place)}</p>
        <div class="tags">${tags.join("")}</div>
      </div>
    </article>`;
  }

  function emptyState(total) {
    const next = state.data.events.find((e) => e.date > state.day && e.places.length);
    const msg = !total ? "No events listed for this day."
      : state.filters.size ? "Nothing matches these filters."
      : "Nothing on campus or at Pennovation — see the events further afield below.";
    return `<div class="empty">
      <svg viewBox="0 0 120 90" fill="none" stroke="#000" stroke-width="1.3">
        <path d="M10 80H110M25 80V40L60 20 95 40V80M25 40H95"/><path d="M45 80V55H75V80" stroke-dasharray="3 3"/>
        <path d="M60 20V8M54 8H66"/></svg>
      <h4>${state.day === state.today ? "QUIET DAY ON CAMPUS" : "NOTHING ON THE MAP"}</h4>
      <p>${msg}</p>
      ${next ? `<button class="btn" data-goto="${next.date}">NEXT: ${fmt(next.date, { weekday: "short", month: "short", day: "numeric" }).toUpperCase()} →</button>` : ""}
    </div>`;
  }

  function render(tick = false) {
    const evs = dayEvents();
    const total = state.data.events.filter((e) => e.date === state.day).length;
    const onMap = evs.filter((e) => e.places.length);
    const off = evs.filter((e) => !e.places.length);
    $("#count").textContent = `${pad(evs.length)} EVENTS · ${pad(onMap.length)} ON MAP · ${fmt(state.day, { weekday: "long", month: "long", day: "numeric" }).toUpperCase()}`
      + (state.filters.has("free") ? " · FREE = NOT MARKED PAID" : "");

    let html = "";
    // Completed events sink to their own faded section at the bottom (pins stay, dashed + faded).
    const live = (arr) => arr.filter((e) => status(e) !== "past");
    const ended = evs.filter((e) => status(e) === "past");
    if (!onMap.length) html += emptyState(total);
    if (live(onMap).length) html += `<div class="section-label">ON THE MAP</div>` + live(onMap).map(card).join("");
    if (live(off).length) html += `<div class="section-label">VIRTUAL / BEYOND CAMPUS</div>` + live(off).map(card).join("");
    if (ended.length) html += `<div class="section-label">ENDED · ${pad(ended.length)}</div>` + ended.map(card).join("");
    const list = $("#list");
    const scroll = list.scrollTop;
    list.innerHTML = html;
    if (tick) list.scrollTop = scroll;
    list.querySelectorAll(".card").forEach((c) => {
      const e = evs.find((x) => x.id === c.dataset.id);
      c.addEventListener("click", () => openEvent(e));
      c.addEventListener("keydown", (k) => { if (k.key === "Enter" || k.key === " ") { k.preventDefault(); openEvent(e); } });
      c.addEventListener("mouseenter", () => highlightPin(e.id, true));
      c.addEventListener("mouseleave", () => highlightPin(e.id, false));
    });
    list.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => selectDay(b.dataset.goto)));
    renderPins(onMap, tick);
  }

  // ───────────────────────── colour the event buildings / lawns
  const DEFAULT_COLOR = "#b0634a";
  const LAWN_CLASSES = ["park", "grass", "pitch", "recreation_ground", "garden", "stadium", "playground", "meadow"];
  const hitCache = new Map();            // "lat,lng" -> outline found in the tiles
  let hlTargets = [];
  const okColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || "") ? c : DEFAULT_COLOR);
  function pale(hex, k = 0.72) {         // mix with white for ended events
    const n = parseInt(hex.slice(1), 16), m = (v) => Math.round(v + (255 - v) * k);
    return "#" + [n >> 16, (n >> 8) & 255, n & 255].map((v) => m(v).toString(16).padStart(2, "0")).join("");
  }
  const xy = (lng, lat) => [lng * 85000, lat * 111000];  // metres, good enough at Penn's latitude
  const polygons = (g) => (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []);
  function inside(pt, poly) {           // even-odd test over outer ring + holes
    let hit = false;
    for (const ring of poly) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }
  function area(poly) {
    const r = poly[0].map((c) => xy(...c)); let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    return Math.abs(a / 2);
  }
  function distM(pt, poly) {
    const [px, py] = xy(...pt); let best = Infinity;
    for (const ring of poly) for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = xy(...ring[i - 1]), [bx, by] = xy(...ring[i]);
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
      best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
    }
    return best;
  }
  function findFeature(t) {
    const pt = [t.lng, t.lat];
    if (t.kind === "lawn") {            // smallest park / grass polygon containing the point
      let best = null;
      for (const sl of ["park", "landcover", "landuse"]) for (const f of map.querySourceFeatures("omt", { sourceLayer: sl })) {
        const cls = f.properties.class;
        if (sl === "park" ? !["park", "garden"].includes(cls) : !LAWN_CLASSES.includes(cls)) continue;
        for (const poly of polygons(f.geometry)) if (inside(pt, poly)) {
          const a = area(poly);
          if (!best || a < best.a) best = { a, poly };
        }
      }
      return best && { kind: "lawn", poly: best.poly };
    }
    // Buildings: the tiles merge neighbouring buildings into one multipolygon, so pick out
    // just the single outline that contains the point (or the nearest one within 35 m).
    let near = null, nd = 35;
    for (const f of map.querySourceFeatures("omt", { sourceLayer: "building" })) {
      for (const poly of polygons(f.geometry)) {
        const hit = { kind: "building", poly, h: f.properties.render_height ?? 8, b: f.properties.render_min_height ?? 0 };
        if (inside(pt, poly)) return hit;
        const d = distM(pt, poly);
        if (d < nd) { nd = d; near = hit; }
      }
    }
    return near;
  }
  let lastHL = "";
  function applyHighlights() {
    if (!map.isStyleLoaded() || !map.getSource("hl")) return;
    const features = [], sig = [];
    for (const t of hlTargets) {
      const key = `${t.lat},${t.lng}`;
      let hit = hitCache.get(key);
      if (!hit) { hit = findFeature(t); if (hit) hitCache.set(key, hit); }
      if (!hit) continue;
      const color = t.ended ? pale(okColor(t.color)) : okColor(t.color);
      sig.push(key + color);
      features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: hit.poly },
        properties: { kind: hit.kind, color, h: hit.h ?? 0, b: hit.b ?? 0 } });
    }
    const s = sig.join("|");
    if (s === lastHL) return;
    lastHL = s;
    map.getSource("hl").setData({ type: "FeatureCollection", features });
  }
  map.on("idle", applyHighlights);
  map.on("load", applyHighlights);

  function renderPins(evs, tick) {
    state.markers.forEach((m) => m.remove());
    state.markers = [];
    if (!tick) state.popup?.remove();
    const groups = new Map();
    for (const e of evs) for (const p of e.places) {
      const key = `${p.lat},${p.lng}`;
      if (!groups.has(key)) groups.set(key, { place: p, events: [] });
      groups.get(key).events.push(e);
    }
    hlTargets = [...groups.values()].map(({ place, events }) => ({
      ...place, ended: events.every((e) => status(e) === "past"),
    }));
    applyHighlights();
    for (const { place, events } of groups.values()) {
      const sts = events.map(status);
      const cls = sts.includes("now") ? "now" : sts.every((s) => s === "past") ? "past" : "";
      const el = document.createElement("div");
      el.className = `pin ${cls}`;
      el.dataset.ids = events.map((e) => e.id).join(" ");
      const label = events.length === 1
        ? `${events[0].idx} · ${events[0].start || "TBA"}`
        : `${events.map((e) => e.idx).join("+")} · ${events.length} EVENTS`;
      el.innerHTML = `<div class="pin-label">${esc(label)}<small>${esc(place.name)}</small></div><div class="pin-stem"></div><div class="pin-dot"></div>`;
      el.title = events.map((e) => `${e.start || ""} ${e.title}`).join("\n");
      el.style.zIndex = cls === "now" ? 3 : cls === "past" ? 1 : 2;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (events.length === 1) return openEvent(events[0]);
        state.popup?.remove();
        const box = document.createElement("div");
        box.className = "pop";
        box.innerHTML = `<h5>${esc(place.name.toUpperCase())}</h5>` + events.map((e) =>
          `<button data-id="${esc(e.id)}">${esc(e.idx)} · ${esc(timeRange(e))}<b>${esc(e.title)}</b></button>`).join("");
        box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => openEvent(events.find((e) => e.id === b.dataset.id))));
        state.popup = new maplibregl.Popup({ offset: 40, closeButton: false, maxWidth: "280px" })
          .setLngLat([place.lng, place.lat]).setDOMContent(box).addTo(map);
      });
      el.addEventListener("mouseenter", () => events.forEach((e) => document.querySelector(`.card[data-id="${CSS.escape(e.id)}"]`)?.classList.add("hl")));
      el.addEventListener("mouseleave", () => document.querySelectorAll(".card.hl").forEach((c) => c.classList.remove("hl")));
      state.markers.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([place.lng, place.lat]).addTo(map));
    }
  }

  function highlightPin(id, on) {
    state.markers.forEach((m) => {
      const el = m.getElement();
      if (el.dataset.ids.split(" ").includes(id)) el.classList.toggle("hl", on);
    });
  }

  // ───────────────────────── modal
  function row(k, v) { return v ? `<tr><th>${k}</th><td>${esc(v)}</td></tr>` : ""; }
  function openEvent(e) {
    if (!e) return;
    const p = e.places[0];
    if (p) map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 17), pitch: state.is3d ? 45 : 0, duration: 1200 });
    const link = safeUrl(e.link);
    const mapsQ = p ? `${p.lat},${p.lng}` : `${e.where || ""} Philadelphia`;
    const st = status(e);
    $("#m-poster").innerHTML = posterHTML(e, e.idx || "--");
    $("#m-body").innerHTML = `
      <div class="kicker">NO.${esc(e.idx || "--")} · ${CATEGORY_LABEL[e.category] || "EVENT"}${st === "now" ? " · ● HAPPENING NOW" : st === "past" ? " · ENDED" : ""}</div>
      <h2 id="m-title">${esc(e.title)}</h2>
      <table class="spec">
        ${row("DATE", fmt(e.date, { weekday: "long", month: "long", day: "numeric" }))}
        ${row("TIME", timeRange(e))}
        ${row("WHERE", e.where || "Not listed")}
        ${row("HOST", e.organiser)}
        ${row("FOOD", e.food)}
        ${row("COST", e.free)}
        ${row("RSVP", e.registration || e.linkNote)}
      </table>
      ${e.about ? `<p class="about">${esc(e.about)}</p>` : ""}
      ${e.notes ? `<p class="note">${esc(e.notes)}</p>` : ""}
      <div class="actions">
        ${link ? `<a class="btn primary" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${e.registration ? "REGISTER" : "MORE INFO"} ↗</a>` : ""}
        ${e.where && !/^virtual/i.test(e.where) ? `<a class="btn" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQ)}" target="_blank" rel="noopener noreferrer">DIRECTIONS ↗</a>` : ""}
      </div>`;
    const dlg = $("#modal");
    if (!dlg.open) dlg.showModal();
  }
  $("#modal-close").addEventListener("click", () => $("#modal").close());
  $("#modal").addEventListener("click", (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });

  // ───────────────────────── controls + boot
  function selectDay(d) {
    state.day = d;
    document.querySelectorAll(".day").forEach((b) => b.setAttribute("aria-selected", b.dataset.day === d));
    render();
    document.querySelector(`.day[data-day="${d}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" });
    frameDay();
  }

  // Glide the camera so every building with an event that day is in view (and gets coloured).
  function frameDay() {
    const pts = dayEvents().flatMap((e) => e.places).map((p) => [p.lng, p.lat]);
    if (!pts.length) return;
    const pitch = state.is3d ? VIEWS.campus.pitch : 0, bearing = state.is3d ? VIEWS.campus.bearing : 0;
    const bounds = pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    const cam = map.cameraForBounds(bounds, { padding: { top: 200, bottom: 160, left: 150, right: 170 }, bearing, maxZoom: 16.8 });
    if (cam) map.easeTo({ ...cam, zoom: Math.min(cam.zoom, 16.8), pitch, bearing, duration: 1400 });
  }
  renderFilterPanel();
  $("#filter-toggle").addEventListener("click", () => {
    const open = $("#filter-panel").hidden;
    $("#filter-panel").hidden = !open;
    $("#filter-toggle").setAttribute("aria-expanded", open);
  });
  const onFilterClick = (ev) => {
    const b = ev.target.closest("[data-filter]");
    if (!b) return;
    const f = b.dataset.filter;
    state.filters.has(f) ? state.filters.delete(f) : state.filters.add(f);
    renderFilterPanel();
    render();
  };
  $("#quick-filters").addEventListener("click", onFilterClick);
  $("#filter-panel").addEventListener("click", onFilterClick);
  $("#filter-clear").addEventListener("click", () => { state.filters.clear(); renderFilterPanel(); render(); });

  function tickClock() {
    const t = new Date().toLocaleString("en-US", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    $("#clock").textContent = t.toUpperCase().replace(/,/g, " ·") + " ET";
  }

  async function load() {
    const res = await fetch("data/events.json", { cache: "no-cache" });
    state.data = await res.json();
    const u = state.data.lastUpdated || "";
    $("#updated").textContent = `SHEET SYNCED ${u.replace("T", " · ")} ET`;
  }

  async function boot() {
    tickClock();
    state.today = nowET().date;
    try { await load(); } catch (err) {
      $("#list").innerHTML = `<div class="empty"><h4>COULDN'T LOAD EVENTS</h4><p>${esc(err.message)}</p></div>`;
      return;
    }
    const fromHash = /^#(\d{4}-\d{2}-\d{2})$/.exec(location.hash)?.[1];
    state.day = fromHash && fromHash >= state.today ? fromHash : state.today;
    renderDays();
    selectDay(state.day);
    setInterval(async () => {
      tickClock();
      const t = nowET().date;
      if (t !== state.today) {          // midnight rollover: pick up the new day + fresh data
        state.today = t; state.day = t;
        try { await load(); } catch (_) { /* keep old data */ }
        renderDays();
      }
      render(true);                      // refresh NOW / ENDED badges
    }, 60_000);
  }
  boot();
})();
