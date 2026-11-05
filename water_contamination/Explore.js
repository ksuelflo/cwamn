// ==============================================================================
// "Explore Contamination Near You"
//
// Search an address (Census geocoder) or a county / watershed / district (suggestions
// as you type). Then:
//   left   - three numbers for the area: nitrate sites over 10 mg/L since 2020,
//            impaired waters, and PFAS in community water systems
//   middle - map of the area (a circle around the address, or the boundary)
//   right  - the address's districts and representatives
//
// Uses the data map.js already loaded (it fires "mapdata:ready"), so nothing is
// downloaded twice. Representatives come from data/representatives.json.
// ==============================================================================

// ---- Settings -----------------------------------------------------------------

const EXPLORE_RADII = [5, 10, 25];          // miles; must match the buttons in index.html
let exploreRadius = 10;                     // default

// Official "who represents me" lookups, linked under the districts list
// (check these links before launch; they change occasionally)
const REP_LOOKUPS = [
    { label: "Minnesota Legislature: Who represents me?", url: "https://www.gis.lcc.mn.gov/iMaps/districts/" },
    { label: "U.S. House: Find your representative", url: "https://www.house.gov/representatives/find-your-representative" }
];

const WELLS_DIR = DATA_URL + "wells/";      // one CSV per county, written by 06_private_wells.R
const SWBCA_COLOR = "#c96a00";              // Special Well and Boring Construction Areas
const WELL_DOT = "rgba(55, 65, 75, 0.45)";  // partly see-through, so clusters read darker

const NITRATE_LIMIT = 10;                   // mg/L as N
const NITRATE_SINCE = 2020;
const MILES_PER_DEGREE = 69.09;             // along a great circle
const EARTH_RADIUS_MI = 3958.8;

// ---- Elements -----------------------------------------------------------------

const exploreEl = document.getElementById("explore");
const addressForm = document.getElementById("search-address");
const addressStatus = document.getElementById("address-status");
const addressMatches = document.getElementById("address-matches");
const areaInput = document.getElementById("area-input");
const areaList = document.getElementById("area-suggestions");
const radiusGroup = document.getElementById("explore-radius");
const exploreTip = d3.select("#explore-tooltip");

// ---- State ----------------------------------------------------------------------

let exploreSel = null;       // { kind: "address", point, label } or { kind: "area", area }
let exploreLayer = "nitrate"; // which card's data the map shows: "nitrate" | "waters" | "pfas"
let exploreData = null;      // prepared once the map data is ready
let representatives = {};
let cities = [];             // [{ name, population, xy }] from data/mn_cities.geojson, biggest first
let swbca = [];              // [{ f, name, bounds }] Special Well and Boring Construction Areas
const wellsCache = new Map(); // county FIPS -> { promise, rows } (each county is downloaded once)
let wellsWaiting = null;     // counties currently being downloaded (so we only re-render once)

// ==============================================================================
// Data preparation (runs once, after map.js has loaded everything)
// ==============================================================================

const AREA_TYPES = {
    county:    { order: 0, word: "" },
    watershed: { order: 1, word: "Watershed" },
    house:     { order: 2, word: "MN House" },
    senate:    { order: 3, word: "MN Senate" },
    congress:  { order: 4, word: "Congress" }
};

function prepareExplore() {
    if (exploreData) return exploreData;

    // Nitrate: each site's readings since 2020 -> count and highest value
    const stats = new Map();
    data.nitrateDaily.forEach(r => {
        if (r.year < NITRATE_SINCE) return;
        const s = stats.get(r.site_id) ?? { n: 0, max: -Infinity };
        s.n++;
        if (r.nitrate_mgL > s.max) s.max = r.nitrate_mgL;
        stats.set(r.site_id, s);
    });
    const nitrateSites = data.nitrateSites.features
        .filter(f => f.geometry && stats.has(f.properties.site_id))
        .map(f => ({
            f,
            xy: f.geometry.coordinates,
            over: stats.get(f.properties.site_id).max > NITRATE_LIMIT,
            max: stats.get(f.properties.site_id).max
        }));

    // Impaired waters: keep each one's bounding box for quick distance checks
    const waters = data.waterFeatures.map(d => ({ d, bounds: d3.geoBounds(d) }));
    const allGroups = new Set(data.waterGroups);

    // PFAS: tested community water systems
    const pfas = data.pfasFeatures
        .filter(f => f.geometry)
        .map(f => ({ f, xy: f.geometry.coordinates }));

    // Search index for counties, watersheds and districts
    const af = data.areaFeatures;
    const areas = [];
    const add = (type, id, label, aliases, feature, sub = "") =>
        areas.push({ type, id: String(id), label, sub, feature, bounds: d3.geoBounds(feature),
                     search: [label, ...aliases].map(norm) });

    af.county.forEach(f => add("county", f.id, `${f.properties.name} County`, [f.properties.name], f));
    af.watershed.forEach(f => add("watershed", f.properties.huc8, `${f.properties.name} watershed`,
        [f.properties.name, f.properties.huc8], f, `HUC ${f.properties.huc8}`));
    af.house.forEach(f => add("house", f.properties.house, `House District ${f.properties.house}`,
        [`HD ${f.properties.house}`, `${f.properties.house}`, `House ${f.properties.house}`], f,
        `Senate District ${f.properties.senate}`));
    af.senate.forEach(f => add("senate", f.properties.senate, `Senate District ${f.properties.senate}`,
        [`SD ${f.properties.senate}`, `Senate ${f.properties.senate}`], f));
    af.congress.forEach(f => add("congress", f.properties.district, `Congressional District ${f.properties.district}`,
        [`CD ${f.properties.district}`, `MN-${f.properties.district}`], f));

    exploreData = { nitrateSites, waters, allGroups, pfas, areas };
    return exploreData;
}

const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function whenDataReady(fn) {
    if (typeof data !== "undefined" && data.ready) fn();
    else window.addEventListener("mapdata:ready", fn, { once: true });
}

fetch(DATA_URL + "Representatives.json")
    .then(r => r.ok ? r.json() : {})
    .then(j => { representatives = j ?? {}; if (exploreSel?.kind === "address") renderDistricts(); })
    .catch(() => { representatives = {}; });

// City points for map labels (MnGeo population centers, written by 01_boundaries.R)
d3.json(DATA_URL + "mn_cities.geojson").then(geo => {
    cities = geo.features
        .filter(f => f.geometry)
        .map(f => ({ name: f.properties.name, population: +f.properties.population || 0,
                     xy: f.geometry.coordinates }))
        .sort((a, b) => b.population - a.population);
    if (exploreSel && exploreData) renderExploreMap(collectArea());
});

// Special Well and Boring Construction Areas (MDH), written by 06_private_wells.R
d3.json(DATA_URL + "swbca.geojson").then(geo => {
    swbca = geo.features
        .filter(f => f.geometry)
        .map(f => ({ f, name: f.properties.name, bounds: d3.geoBounds(f) }));
    if (exploreSel && exploreData) renderExplore();
});

// ---- Private wells: downloaded per county, only for the counties a search touches ----

function loadWellsCounty(fips) {
    if (!wellsCache.has(fips)) {
        const entry = { rows: null };
        entry.promise = d3.csv(`${WELLS_DIR}${fips}.csv`, r => ({
                xy: [+r.lon, +r.lat],
                huc8: r.huc8,
                house: r.house,
                senate: String(parseInt(r.house, 10)),   // "64A" -> "64"
                cong: r.cong
            }))
            .catch(() => [])                 // a county with no wells file
            .then(rows => (entry.rows = rows));
        wellsCache.set(fips, entry);
    }
    return wellsCache.get(fips);
}

// Counties whose wells could be in the current selection
function wellCounties() {
    const counties = exploreData.areas.filter(a => a.type === "county");
    if (exploreSel.kind === "address") {
        return counties.filter(c => boxNear(c.bounds, exploreSel.point, exploreRadius)).map(c => c.id);
    }
    const a = exploreSel.area;
    if (a.type === "county") return [a.id];
    const [[w, s], [e, n]] = a.bounds;
    return counties
        .filter(({ bounds: [[cw, cs], [ce, cn]] }) => cw <= e && ce >= w && cs <= n && cn >= s)
        .map(c => c.id);
}

// Wells in the selection, or null while their counties are still downloading
// (the page re-renders by itself once they arrive)
function collectWells() {
    const ids = wellCounties();
    const entries = ids.map(loadWellsCounty);

    if (entries.some(e => !e.rows)) {
        const key = ids.join(",");
        if (wellsWaiting !== key) {
            wellsWaiting = key;
            const sel = exploreSel;
            Promise.all(entries.map(e => e.promise)).then(() => {
                wellsWaiting = null;
                if (exploreSel === sel) renderExplore();
            });
        }
        return null;
    }

    const rows = entries.flatMap(e => e.rows);
    if (exploreSel.kind === "address") {
        return rows.filter(r => distMiles(exploreSel.point, r.xy) <= exploreRadius);
    }
    // Each well already carries its watershed and districts from R, so no shape tests needed
    const a = exploreSel.area;
    const match = {
        county:    () => true,
        watershed: r => r.huc8 === a.id,
        house:     r => r.house === a.id,
        senate:    r => r.senate === a.id,
        congress:  r => r.cong === a.id
    }[a.type];
    return rows.filter(match);
}

// Special construction areas that touch the selection
function collectSwbca() {
    if (exploreSel.kind === "address") {
        const pt = exploreSel.point, R = exploreRadius;
        return swbca.filter(z => boxNear(z.bounds, pt, R) &&
            (d3.geoContains(z.f, pt) || someCoord(z.f.geometry, c => distMiles(pt, c) <= R)));
    }
    const a = exploreSel.area;
    const [[w, s], [e, n]] = a.bounds;
    return swbca.filter(({ f, bounds: [[zw, zs], [ze, zn]] }) =>
        zw <= e && ze >= w && zs <= n && zn >= s &&
        someCoord(f.geometry, c => inBox(c, a.bounds) && d3.geoContains(a.feature, c)));
}

// Warning-triangle icon (map and legend)
const HAZARD_PATH = "M0,-7.5 L7.5,6 L-7.5,6 Z";
function hazardSvg(size = 14) {
    return `<svg width="${size}" height="${size}" viewBox="-8.5 -8.8 17 16" aria-hidden="true">` +
        `<path d="${HAZARD_PATH}" fill="${SWBCA_COLOR}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>` +
        `<rect x="-0.9" y="-3.6" width="1.8" height="5" rx="0.9" fill="#fff"/>` +
        `<circle cx="0" cy="3.6" r="1" fill="#fff"/></svg>`;
}

// ==============================================================================
// Geometry helpers
// ==============================================================================

function distMiles([lon1, lat1], [lon2, lat2]) {
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
}

// Calls fn(coord) for every coordinate; stops early if fn returns true
function someCoord(geom, fn) {
    if (!geom) return false;
    const walk = (c, depth) => depth === 0 ? fn(c) : c.some(x => walk(x, depth - 1));
    switch (geom.type) {
        case "Point":           return fn(geom.coordinates);
        case "MultiPoint":
        case "LineString":      return walk(geom.coordinates, 1);
        case "MultiLineString":
        case "Polygon":         return walk(geom.coordinates, 2);
        case "MultiPolygon":    return walk(geom.coordinates, 3);
        case "GeometryCollection": return geom.geometries.some(g => someCoord(g, fn));
        default: return false;
    }
}

// Is a bounding box ([[w, s], [e, n]]) possibly within `miles` of the point?
function boxNear([[w, s], [e, n]], [lon, lat], miles) {
    const dLat = miles / MILES_PER_DEGREE;
    const dLon = miles / (MILES_PER_DEGREE * Math.cos(lat * Math.PI / 180));
    return lon >= w - dLon && lon <= e + dLon && lat >= s - dLat && lat <= n + dLat;
}

const inBox = ([lon, lat], [[w, s], [e, n]]) => lon >= w && lon <= e && lat >= s && lat <= n;

// Which county / watershed / district contains a point
function areaAt(type, point) {
    return exploreData.areas.find(a => a.type === type && inBox(point, a.bounds) && d3.geoContains(a.feature, point)) ?? null;
}

// Impaired waters carry their county / watershed / district from R; this maps area types to those columns
const WATER_AREA_PROP = {
    county: p => p.county_fips,
    watershed: p => p.huc8,
    house: p => p.house_dist,
    senate: p => p.senate_dist,
    congress: p => p.cong_dist
};

// ==============================================================================
// What's in the selected area
// ==============================================================================

function collectArea() {
    const D = exploreData;

    if (exploreSel.kind === "address") {
        const pt = exploreSel.point, R = exploreRadius;
        return {
            wells: collectWells(),
            swbca: collectSwbca(),
            nitrate: D.nitrateSites.filter(s => distMiles(pt, s.xy) <= R),
            waters: D.waters.filter(w => boxNear(w.bounds, pt, R) &&
                                         someCoord(w.d.geometry, c => distMiles(pt, c) <= R)).map(w => w.d),
            pfas: D.pfas.filter(s => distMiles(pt, s.xy) <= R),
            nearestPfas: D.pfas
                .map(s => ({ ...s, dist: distMiles(pt, s.xy) }))
                .sort((a, b) => a.dist - b.dist)
                .slice(0, 3)
        };
    }

    const a = exploreSel.area;
    const inside = xy => inBox(xy, a.bounds) && d3.geoContains(a.feature, xy);
    const prop = WATER_AREA_PROP[a.type];
    // Use the district columns from R when the file has them; otherwise test the geometry
    const hasProp = D.waters.some(w => prop(w.d.properties) != null);
    const firstCoord = g => { let c = null; someCoord(g, x => (c = x, true)); return c; };

    return {
        wells: collectWells(),
        swbca: collectSwbca(),
        nitrate: D.nitrateSites.filter(s => inside(s.xy)),
        waters: D.waters
            .filter(w => hasProp ? String(prop(w.d.properties)) === a.id
                                 : (c => c && inside(c))(firstCoord(w.d.geometry)))
            .map(w => w.d),
        pfas: D.pfas.filter(s => inside(s.xy))
    };
}

// ==============================================================================
// Rendering
// ==============================================================================

function renderExplore() {
    if (!exploreSel || !exploreData) return;
    const found = collectArea();
    const isAddress = exploreSel.kind === "address";
    const where = isAddress ? `within ${exploreRadius} miles` : `in ${exploreSel.area.label}`;

    radiusGroup.hidden = !isAddress;
    d3.selectAll("#explore-radius button")
        .classed("is-active", function () { return +this.dataset.miles === exploreRadius; })
        .attr("aria-pressed", function () { return +this.dataset.miles === exploreRadius; });

    d3.select("#explore-place").text(isAddress ? exploreSel.label : exploreSel.area.label);

    renderKpis(found, where, isAddress);
    decorateCards();
    renderExploreMap(found);
    renderDistricts();
}

// ---- The three cards double as the map's layer switch ----------------------------

const CARD_LAYERS = [
    { id: "nitrate", card: "kpi-nitrate", tag: "Nitrate",              showing: "nitrate monitoring sites" },
    { id: "waters",  card: "kpi-waters",  tag: "Impaired waterbodies", showing: "impaired lakes, rivers and wetlands" },
    { id: "pfas",    card: "kpi-pfas",    tag: "PFAS",                 showing: "community water systems tested for PFAS" },
    { id: "wells",   card: "kpi-wells",   tag: "Private wells",        showing: "recorded private drinking-water wells" }
];

// One-time setup: make each card a toggle button and add the "click a card" hint
(function setUpCardSwitch() {
    const hint = document.createElement("p");
    hint.className = "explore-kpis-hint";
    hint.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">` +
        `<path d="M8 1.5c-2.5 0-4.5 2-4.5 4.4 0 3.3 4.5 8.6 4.5 8.6s4.5-5.3 4.5-8.6C12.5 3.5 10.5 1.5 8 1.5z" fill="currentColor"/>` +
        `<circle cx="8" cy="6" r="1.7" fill="#fff"/></svg>` +
        `Click a card to show it on the map`;
    const firstCard = document.getElementById(CARD_LAYERS[0].card);
    firstCard.parentElement.insertBefore(hint, firstCard);

    CARD_LAYERS.forEach(L => {
        const el = document.getElementById(L.card);
        el.classList.add("is-switch");
        el.setAttribute("role", "button");
        el.setAttribute("tabindex", "0");
        el.setAttribute("aria-controls", "explore-map");
        const choose = () => {
            if (exploreLayer === L.id) return;
            exploreLayer = L.id;
            exploreTip.style("opacity", 0);
            decorateCards();
            renderExploreMap(collectArea());
            // On phones the map is above the cards: bring it back into view
            const mapWrap = document.querySelector(".explore-map-wrap");
            if (window.matchMedia("(max-width: 56.25em)").matches && mapWrap.getBoundingClientRect().top < 0) {
                mapWrap.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        };
        el.addEventListener("click", choose);
        el.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); }
        });
    });

    // "Showing: ..." line under the map title
    const showing = document.createElement("p");
    showing.className = "explore-showing";
    showing.id = "explore-showing";
    document.getElementById("explore-place").insertAdjacentElement("afterend", showing);
})();

// Highlights the active card, adds each card's "Show on map" / "Shown on map" footer,
// and updates the "Showing" line above the map
function decorateCards() {
    CARD_LAYERS.forEach(L => {
        const el = document.getElementById(L.card);
        const on = L.id === exploreLayer;
        el.classList.toggle("is-active", on);
        el.setAttribute("aria-pressed", on);
        el.querySelector(".explore-kpi-cta")?.remove();

        // Data-layer label in the card's top-right corner
        el.querySelector(".explore-kpi-tag")?.remove();
        const tag = document.createElement("span");
        tag.className = "explore-kpi-tag";
        tag.textContent = L.tag;
        el.prepend(tag);

        const cta = document.createElement("div");
        cta.className = "explore-kpi-cta";
        cta.innerHTML = on
            ? `<span class="explore-kpi-dot" aria-hidden="true"></span>Shown on the map`
            : `Show on the map <span aria-hidden="true">→</span>`;
        el.appendChild(cta);
    });
    const L = CARD_LAYERS.find(x => x.id === exploreLayer);
    d3.select("#explore-showing").html(`Showing <strong>${L.showing}</strong>` +
        (exploreSel?.kind === "address" && exploreLayer === "pfas" ? " (numbers match the list)" : ""));
}

function kpiHtml({ value, label, note }) {
    return `<div class="stat-value">${value}</div>` +
           `<div class="stat-label">${label}</div>` +
           (note ? `<div class="stat-note">${note}</div>` : "");
}

function renderKpis(found, where, isAddress) {
    // Nitrate
    const over = found.nitrate.filter(s => s.over).length;
    d3.select("#kpi-nitrate").html(found.nitrate.length
        ? kpiHtml({
            value: over.toLocaleString(),
            label: `monitoring sites had a nitrate reading over ${NITRATE_LIMIT} mg/L since ${NITRATE_SINCE}`,
            note: `of ${found.nitrate.length.toLocaleString()} sites monitored ${where} · mostly rivers, lakes and streams, not tap water`
        })
        : kpiHtml({
            value: "—",
            label: `No nitrate monitoring sites ${where}`,
            note: isAddress ? "Try a larger radius." : ""
        }));

    // Impaired waters
    const needs = found.waters.filter(d => d.needsPlan).length;
    d3.select("#kpi-waters").html(kpiHtml({
        value: found.waters.length.toLocaleString(),
        label: `impaired lakes, rivers and wetlands ${where}`,
        note: found.waters.length ? `${needs.toLocaleString()} still need a cleanup plan` : ""
    }));

    // PFAS: nearest systems for an address, a count for an area
    const isDetected = s => s.f.properties.pfas_category !== PFAS_NOT_DETECTED;
    if (isAddress) {
        const rows = found.nearestPfas.map(s => {
            const p = s.f.properties;
            const cat = p.pfas_category;
            const swatch = cat === PFAS_NOT_DETECTED
                ? `<span class="explore-swatch" style="border:1.5px solid #888;background:#fff"></span>`
                : `<span class="explore-swatch" style="background:${pfasColor(cat)}"></span>`;
            return `<li><strong>${escapeHtml(p.name ?? "Water system")}</strong>` +
                   `<span class="explore-sys-meta">${s.dist.toFixed(1)} mi` +
                   (p.pop_serv ? ` · serves ${formatPeople(+p.pop_serv)}` : "") + `</span>` +
                   `<span class="explore-sys-result">${swatch}${escapeHtml(cat)}</span></li>`;
        }).join("");
        d3.select("#kpi-pfas").html(
            `<div class="stat-label explore-kpi-heading">Nearest community water systems tested for PFAS</div>` +
            `<ol class="explore-systems">${rows}</ol>` +
            `<div class="stat-note">The nearest system may not be yours: check your water bill or city to confirm your supplier. Private wells aren't included.</div>`);
    } else {
        const detected = found.pfas.filter(isDetected);
        const people = d3.sum(detected, s => +s.f.properties.pop_serv || 0);
        d3.select("#kpi-pfas").html(found.pfas.length
            ? kpiHtml({
                value: detected.length.toLocaleString(),
                label: `community water systems with PFAS detected`,
                note: `of ${found.pfas.length.toLocaleString()} tested ${where}` +
                      (people ? ` · serving ${formatPeople(people)} people` : "")
            })
            : kpiHtml({ value: "—", label: `No tested community water systems ${where}` }));
    }

    // Private wells (+ a notice when special construction areas are in the selection)
    if (found.wells === null) {
        d3.select("#kpi-wells").html(kpiHtml({ value: "…", label: `Counting private wells ${where}` }));
        return;
    }
    const areaNames = [...new Set(found.swbca.map(z => z.name))];
    const insideNames = isAddress
        ? [...new Set(found.swbca.filter(z => d3.geoContains(z.f, exploreSel.point)).map(z => z.name))]
        : [];
    let notice = "";
    if (insideNames.length) {
        notice = `This address is inside the <strong>${escapeHtml(insideNames[0])}</strong> Special Well and ` +
                 `Boring Construction Area. Groundwater here is contaminated, and new or repaired wells need state approval.`;
    } else if (areaNames.length) {
        notice = `${areaNames.length} Special Well and Boring Construction Area${areaNames.length > 1 ? "s" : ""} ` +
                 `${where}: places with contaminated groundwater (shown on the map).`;
    }
    d3.select("#kpi-wells").html(
        kpiHtml({
            value: found.wells.length.toLocaleString(),
            label: `recorded private drinking-water wells ${where}`,
            note: "From state well construction records. Some older wells aren't recorded."
        }) +
        (notice ? `<div class="explore-swbca-notice">${hazardSvg(16)}<span>${notice}</span></div>` : ""));
}

// ---- Districts + representatives (addresses only, for now) ------------------

function repLine(rep) {
    if (!rep || !rep.name) return "";
    const party = rep.party ? ` (${escapeHtml(rep.party)})` : "";
    const name = rep.url
        ? `<a href="${encodeURI(rep.url)}" target="_blank" rel="noopener">${escapeHtml(rep.name)}</a>`
        : escapeHtml(rep.name);
    return `<div class="explore-rep">${name}${party}</div>`;
}

function renderDistricts() {
    const panel = d3.select("#explore-districts");
    if (!exploreSel || exploreSel.kind !== "address") {
        panel.html("");   // left empty for county / district searches (for now)
        return;
    }

    const pt = exploreSel.point;
    const county = areaAt("county", pt);
    const shed = areaAt("watershed", pt);
    const house = areaAt("house", pt);
    const senate = areaAt("senate", pt);
    const cong = areaAt("congress", pt);
    const reps = representatives ?? {};

    const row = (label, value, rep = "") =>
        `<li><span class="explore-dist-label">${label}</span>` +
        `<span class="explore-dist-value">${value ? escapeHtml(value) : "—"}</span>${rep}</li>`;

    const senators = (reps.us_senate ?? []).map(repLine).join("");

    panel.html(
        `<h2 class="panel-title">Your districts</h2>` +
        `<ul class="explore-dist-list">` +
        row("County", county?.label) +
        row("Watershed", shed?.label.replace(/ watershed$/, "")) +
        row("MN House", house && `District ${house.id}`, repLine(reps.mn_house?.[house?.id])) +
        row("MN Senate", senate && `District ${senate.id}`, repLine(reps.mn_senate?.[senate?.id])) +
        row("U.S. House", cong && `District ${cong.id}`, repLine(reps.us_house?.[cong?.id])) +
        (senators ? row("U.S. Senate", "Statewide", senators) : "") +
        `</ul>` +
        `<p class="explore-dist-note">Confirm your districts and contact your representatives:</p>` +
        `<ul class="explore-dist-links">` +
        REP_LOOKUPS.map(l => `<li><a href="${encodeURI(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a></li>`).join("") +
        `</ul>`);
}

// ---- Map -------------------------------------------------------------------------

function renderExploreMap(found) {
    const svgEl = document.getElementById("explore-map");
    const box = svgEl.parentElement.getBoundingClientRect();
    if (!box.width || !box.height) return;   // tab hidden; drawn again when shown
    const w = box.width, h = box.height;
    const k = symbolScale(w);                 // smaller symbols on a narrow (phone-sized) map
    const kn = Math.max(0.75, k);             // numbered PFAS squares shrink less, so the numbers stay readable

    const svgX = d3.select(svgEl).attr("viewBox", [0, 0, w, h]).attr("width", w).attr("height", h);
    svgX.selectAll("*").remove();

    // The selection shape: a true 5/10/25-mile circle, or the boundary
    const shape = exploreSel.kind === "address"
        ? d3.geoCircle().center(exploreSel.point).radius(exploreRadius / MILES_PER_DEGREE).precision(2)()
        : exploreSel.area.feature;

    // For an address's PFAS view, also fit the 3 nearest systems (they can be outside the circle)
    const nearest = exploreSel.kind === "address" && exploreLayer === "pfas" ? found.nearestPfas : [];
    const fitTo = nearest.length
        ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: shape.geometry ?? shape },
              ...nearest.map(s => ({ type: "Feature", geometry: { type: "Point", coordinates: s.xy } }))] }
        : shape;

    const proj = d3.geoTransverseMercator().rotate([93, 0])
        .fitExtent([[28, 28], [w - 28, h - 28]], fitTo);
    const gp = d3.geoPath(proj);

    const g = svgX.append("g");

    // Private wells go on a canvas behind the SVG (thousands of dots draw fast there).
    // Always called, so switching away from the wells card clears it.
    drawWells(exploreLayer === "wells" ? found.wells : null, proj, w, h, k);

    // Background: counties + state outline (no fill, so the wells canvas shows through;
    // the map box's own background is white)
    g.append("g").selectAll("path")
        .data(data.areaFeatures.county)
        .join("path")
        .attr("d", gp)
        .attr("fill", "none")
        .attr("stroke", "#d9d6cd")
        .attr("stroke-width", 0.7);
    g.append("path").datum(data.mnOutline).attr("d", gp)
        .attr("fill", "none").attr("stroke", "#4f4c45").attr("stroke-width", 1.2);

    // Selected area
    g.append("path").datum(shape).attr("d", gp)
        .attr("fill", PIN_COLOR).attr("fill-opacity", 0.06)
        .attr("stroke", PIN_COLOR).attr("stroke-width", 2 * kn)
        .attr("stroke-dasharray", exploreSel.kind === "address" ? "6 4" : null);

    const tipOn = html => event => {
        const [mx, my] = d3.pointer(event, svgEl.parentElement);
        exploreTip.html(html(event)).style("opacity", 1)
            .style("left", `${mx + 12}px`).style("top", `${my + 12}px`);
    };
    const tipOff = () => exploreTip.style("opacity", 0);
    const swatch = (fill, stroke = "none", shapeType = "rect") => shapeType === "circle"
        ? `<svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="${fill}" stroke="${stroke}"/></svg>`
        : `<svg width="12" height="12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="${fill}" stroke="${stroke}"/></svg>`;
    const legend = d3.select("#explore-legend");

    // ---- Nitrate sites: dark red if any reading over 10 mg/L since 2020 ----
    if (exploreLayer === "nitrate") {
        g.append("g").selectAll("circle")
            .data(found.nitrate.slice().sort((a, b) => a.over - b.over))
            .join("circle")
            .attr("cx", s => proj(s.xy)[0]).attr("cy", s => proj(s.xy)[1])
            .attr("r", s => (s.over ? 5 : 4) * k)
            .attr("fill", s => s.over ? nitrateColors[3] : "#fff")
            .attr("stroke", s => s.over ? "#fff" : "#8a8a8a")
            .attr("stroke-width", 1.2 * kn)
            .on("mousemove", (event, s) => tipOn(() =>
                `<strong>${escapeHtml(s.f.properties.name ?? s.f.properties.site_id)}</strong><br>` +
                `Nitrate monitoring site<br>Highest since ${NITRATE_SINCE}: ${s.max.toFixed(1)} mg/L`)(event))
            .on("mouseleave", tipOff);

        legend.html(
            `<span>${swatch(nitrateColors[3], "none", "circle")}A reading over ${NITRATE_LIMIT} mg/L since ${NITRATE_SINCE}</span>` +
            `<span>${swatch("#fff", "#8a8a8a", "circle")}Never over ${NITRATE_LIMIT} mg/L</span>`);
    }

    // ---- Impaired waters: colored by main problem if a plan is still needed, grey if plans are in place ----
    if (exploreLayer === "waters") {
        const PLANNED = "#c3c8cc";
        const colorOf = d => d.needsPlan ? waterGroupColor.get(waterDisplayGroup(d, exploreData.allGroups)) : PLANNED;
        g.append("g").selectAll("path")
            .data(found.waters.slice().sort((a, b) => a.needsPlan - b.needsPlan))   // bold on top
            .join("path")
            .attr("d", gp)
            .attr("fill", d => d.kind === "line" ? "none" : colorOf(d))
            .attr("fill-opacity", 0.85)
            .attr("stroke", colorOf)
            .attr("stroke-width", d => (d.kind === "line" ? (d.needsPlan ? 2.4 : 1.6) : 0.8) * k)
            .attr("stroke-linecap", "round")
            .on("mousemove", (event, d) => tipOn(() =>
                `<strong>${escapeHtml(d.properties.name ?? "Impaired water")}</strong><br>` +
                `${escapeHtml([...d.groups].join(", "))}<br>` +
                (d.needsPlan ? "Still needs a cleanup plan" : "Cleanup plans in place"))(event))
            .on("mouseleave", tipOff);

        // Legend: only the problems that actually appear among the waters still needing a plan
        const present = new Set(found.waters.filter(d => d.needsPlan)
            .map(d => waterDisplayGroup(d, exploreData.allGroups)));
        const groups = data.waterGroups.filter(gid => present.has(gid));
        legend.html(
            (groups.length ? `<span class="explore-legend-head">Still needs a cleanup plan, by main problem:</span>` : "") +
            groups.map(gid => `<span>${swatch(waterGroupColor.get(gid))}${escapeHtml(gid)}</span>`).join("") +
            `<span>${swatch(PLANNED)}Cleanup plans in place</span>`);
    }

    // ---- PFAS water systems: colored by result; for an address, the 3 nearest are numbered ----
    if (exploreLayer === "pfas") {
        const shown = [...new Map(nearest.concat(found.pfas).map(s => [s.f.properties.pwsid, s])).values()];
        const rank = new Map(nearest.map((s, i) => [s.f.properties.pwsid, i + 1]));
        const fillOf = s => s.f.properties.pfas_category === PFAS_NOT_DETECTED ? "#fff" : pfasColor(s.f.properties.pfas_category);
        const darkFill = s => [pfasColors[2], pfasColors[3]].includes(fillOf(s));

        const sys = g.append("g").selectAll("g")
            .data(shown.sort((a, b) => (rank.get(a.f.properties.pwsid) ? 1 : 0) - (rank.get(b.f.properties.pwsid) ? 1 : 0)))
            .join("g")
            .attr("transform", s => `translate(${proj(s.xy)})`)
            .on("mousemove", (event, s) => tipOn(() =>
                `<strong>${escapeHtml(s.f.properties.name ?? "Water system")}</strong><br>` +
                `Community water system` +
                (s.f.properties.pop_serv ? ` · serves ${formatPeople(+s.f.properties.pop_serv)}` : "") +
                `<br>PFAS: ${escapeHtml(s.f.properties.pfas_category)}`)(event))
            .on("mouseleave", tipOff);

        sys.append("rect")
            .attr("x", s => rank.get(s.f.properties.pwsid) ? -9 * kn : -5 * k)
            .attr("y", s => rank.get(s.f.properties.pwsid) ? -9 * kn : -5 * k)
            .attr("width", s => rank.get(s.f.properties.pwsid) ? 18 * kn : 10 * k)
            .attr("height", s => rank.get(s.f.properties.pwsid) ? 18 * kn : 10 * k)
            .attr("rx", 2)
            .attr("fill", fillOf)
            .attr("stroke", s => s.f.properties.pfas_category === PFAS_NOT_DETECTED ? "#777" : "#fff")
            .attr("stroke-width", 1.4 * kn);

        sys.filter(s => rank.get(s.f.properties.pwsid))
            .append("text")
            .attr("text-anchor", "middle")
            .attr("dy", "0.35em")
            .attr("font-size", 11 * kn)
            .attr("font-weight", 700)
            .attr("font-family", "var(--cwa-nav-font)")
            .attr("fill", s => darkFill(s) ? "#fff" : "#222")
            .style("pointer-events", "none")
            .text(s => rank.get(s.f.properties.pwsid));

        const cats = ALL_PFAS_CATEGORIES.filter(c => shown.some(s => s.f.properties.pfas_category === c));
        legend.html(cats.map(c => c === PFAS_NOT_DETECTED
                ? `<span>${swatch("#fff", "#777")}${escapeHtml(c)}</span>`
                : `<span>${swatch(pfasColor(c))}${escapeHtml(c)}</span>`).join("") +
            (nearest.length ? `<span class="explore-legend-note">Numbered squares = the nearest systems listed in the card</span>` : ""));
    }

    // ---- Private wells: dots on the canvas (above); special construction areas hatched, with a hazard icon ----
    const reserved = [];     // boxes labels must avoid: the pin, then each placed area label
    if (exploreSel.kind === "address") {
        const [px, py] = proj(exploreSel.point);
        reserved.push([px - 14 * kn, py - 34 * kn, px + 14 * kn, py + 2]);
    }
    let zoneBoxes = [];
    if (exploreLayer === "wells") {
        // Area outlines also count as taken, so one area's label doesn't sit on another area
        zoneBoxes = found.swbca.map(z => { const [[a, b], [c, d]] = gp.bounds(z.f); return [a, b, c, d]; });
        reserved.push(...zoneBoxes);
        const defs = svgX.insert("defs", ":first-child");
        const hatch = defs.append("pattern")
            .attr("id", "swbca-hatch")
            .attr("patternUnits", "userSpaceOnUse")
            .attr("width", 7).attr("height", 7)
            .attr("patternTransform", "rotate(45)");
        hatch.append("rect").attr("width", 7).attr("height", 7)
            .attr("fill", SWBCA_COLOR).attr("fill-opacity", 0.08);
        hatch.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 7)
            .attr("stroke", SWBCA_COLOR).attr("stroke-width", 2).attr("stroke-opacity", 0.5);

        const tip = z => `<strong>${escapeHtml(z.name)}</strong><br>Special Well and Boring Construction Area` +
            (z.f.properties.effective ? ` (since ${escapeHtml(z.f.properties.effective.slice(0, 4))})` : "") +
            `<br>Contaminated groundwater: drilling, repairing or sealing a well here needs state approval`;

        const zonesG = g.append("g");
        d3.group(found.swbca, z => z.name).forEach((zones, name) => {
            zonesG.append("g").selectAll("path")
                .data(zones)
                .join("path")
                .attr("d", z => gp(z.f))
                .attr("fill", "url(#swbca-hatch)")
                .attr("stroke", SWBCA_COLOR)
                .attr("stroke-width", 1.6 * kn)
                .on("mousemove", (event, z) => tipOn(() => tip(z))(event))
                .on("mouseleave", tipOff);

            // Hazard icon + name beside the area. Try right, left, above, below; take the first
            // spot that's inside the map and clear of the pin, other area labels and area outlines.
            const [[x0, y0], [x1, y1]] = gp.bounds({ type: "FeatureCollection", features: zones.map(z => z.f) });
            const labelPx = k < 0.8 ? 9.5 : 11;               // matches the CSS (smaller on phones)
            const textW = name.length * labelPx * 0.56;
            const cy = (y0 + y1) / 2, cx = (x0 + x1) / 2;
            const sides = tw => [
                { ix: x1 + 10,                 iy: cy,      left: false, tw },   // right
                { ix: x0 - 10,                 iy: cy,      left: true,  tw },   // left
                { ix: cx - (22 + tw) / 2 + 9,  iy: y0 - 12, left: false, tw },   // above
                { ix: cx - (22 + tw) / 2 + 9,  iy: y1 + 12, left: false, tw }    // below
            ];
            const boxOf = c => c.left ? [c.ix - 13 - c.tw, c.iy - 9, c.ix + 9, c.iy + 8]
                                      : [c.ix - 9, c.iy - 9, c.ix + 13 + c.tw, c.iy + 8];
            const clear = b => b[0] >= 4 && b[2] <= w - 4 && b[1] >= 4 && b[3] <= h - 4 &&
                !reserved.some(p => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
            // Icon + name if there's room; otherwise just the icon (the name is in the tooltip and the card)
            let spot = sides(textW).find(c => clear(boxOf(c))) ?? sides(-4).find(c => clear(boxOf(c)));
            if (!spot) spot = { ix: Math.max(12, Math.min(x1 + 10, w - 12)), iy: Math.max(12, Math.min(cy, h - 12)),
                                left: false, tw: -4 };
            const { ix, iy, left } = spot;
            const showName = spot.tw > 0;

            const mark = zonesG.append("g")
                .attr("class", "explore-swbca-mark")
                .attr("transform", `translate(${ix},${iy})`)
                .style("pointer-events", "none");
            const icon = mark.append("g").attr("transform", `scale(${kn})`);
            icon.append("path").attr("d", HAZARD_PATH)
                .attr("fill", SWBCA_COLOR).attr("stroke", "#fff").attr("stroke-width", 1.2).attr("stroke-linejoin", "round");
            icon.append("rect").attr("x", -0.9).attr("y", -3.6).attr("width", 1.8).attr("height", 5).attr("rx", 0.9).attr("fill", "#fff");
            icon.append("circle").attr("cy", 3.6).attr("r", 1).attr("fill", "#fff");
            if (showName) mark.append("text")
                .attr("x", left ? -11 : 11)
                .attr("dy", "0.35em")
                .attr("text-anchor", left ? "end" : "start")
                .text(name);

            reserved.push(boxOf(spot));
        });

        const hatchSwatch = `<svg width="14" height="12" aria-hidden="true"><defs>` +
            `<pattern id="swbca-hatch-key" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">` +
            `<rect width="4" height="4" fill="${SWBCA_COLOR}" fill-opacity="0.08"/>` +
            `<line x1="0" y1="0" x2="0" y2="4" stroke="${SWBCA_COLOR}" stroke-width="1.5" stroke-opacity="0.6"/></pattern></defs>` +
            `<rect x="1" y="1" width="12" height="10" rx="1.5" fill="url(#swbca-hatch-key)" stroke="${SWBCA_COLOR}" stroke-width="1.2"/></svg>`;

        legend.html(found.wells === null
            ? `<span>Loading private wells…</span>`
            : `<span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="2.5" fill="${WELL_DOT}"/></svg>` +
              `Recorded private well (one dot each)</span>` +
              (found.swbca.length
                  ? `<span>${hatchSwatch}${hazardSvg(13)}Special Well and Boring Construction Area (contaminated groundwater)</span>`
                  : ""));
    }

    // City names, on top of the data
    const pinXY = exploreSel.kind === "address" ? proj(exploreSel.point) : null;
    drawCityLabels(g, proj, w, h, pinXY, reserved.filter(b => !zoneBoxes.includes(b)), kn);   // cities may sit inside areas

    // Address pin
    if (pinXY) {
        const [px, py] = pinXY;
        const pin = g.append("g").attr("transform", `translate(${px},${py}) scale(${1.6 * kn})`).style("pointer-events", "none");
        pin.append("path").attr("d", PIN_PATH).attr("fill", PIN_COLOR).attr("stroke", "#fff").attr("stroke-width", 1.2);
        pin.append("circle").attr("cy", -16).attr("r", 3.5).attr("fill", "#fff");
    }
}

// Symbol size multiplier from the map's width: 1 at 640px and wider, down to 0.55 on a phone
function symbolScale(w) {
    return Math.max(0.55, Math.min(1, w / 640));
}

// ---- Private wells on the canvas behind the map ----------------------------------------

function drawWells(rows, proj, w, h, k = 1) {
    const canvas = document.getElementById("explore-wells");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!rows || !rows.length) return;

    ctx.fillStyle = WELL_DOT;
    if (rows.length <= 5000) {
        // Round dots; each filled separately so overlapping dots darken
        for (const r of rows) {
            const [x, y] = proj(r.xy);
            ctx.beginPath();
            ctx.arc(x, y, Math.max(1, 1.8 * k), 0, 2 * Math.PI);
            ctx.fill();
        }
    } else {
        // Many wells: tiny squares (much faster, and look the same at this size)
        const s = Math.max(1, (rows.length > 20000 ? 1.6 : 2.4) * k);
        for (const r of rows) {
            const [x, y] = proj(r.xy);
            ctx.fillRect(x - s / 2, y - s / 2, s, s);
        }
    }
}

// ---- City labels -------------------------------------------------------------------
// Biggest cities in view first; a city is skipped if its name would overlap one already
// placed (or the address pin). So a statewide view shows only the big cities, and a
// 5-mile view shows the small towns. Label text sits right of the dot, or left near the edge.

const CITY_MAX_LABELS = 14;      // most names on the map at once
const CITY_BIG = 50000;          // population drawn in the larger font

function drawCityLabels(g, proj, w, h, pinXY, reserved = [], k = 1) {
    if (!cities.length) return;
    const pad = 6;
    const placed = [...reserved]; // boxes already taken: [x0, y0, x1, y1]
    if (pinXY) placed.push([pinXY[0] - 12, pinXY[1] - 30, pinXY[0] + 12, pinXY[1] + 2]);
    const overlaps = b => placed.some(p => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);

    const shown = [];
    for (const c of cities) {
        if (shown.length >= CITY_MAX_LABELS) break;
        const [x, y] = proj(c.xy);
        if (x < pad || x > w - pad || y < pad || y > h - pad) continue;   // outside the view

        const big = c.population >= CITY_BIG;
        const size = (big ? 12.5 : 11) * k;
        const textW = c.name.length * size * 0.56;                       // rough width of the name
        const left = x + 5 + textW > w - pad;                            // flip to the left near the edge
        const x0 = left ? x - 5 - textW : x - 3;
        const x1 = left ? x + 3 : x + 5 + textW;
        const box = [x0 - 2, y - size * 0.7, x1 + 2, y + size * 0.55];
        if (overlaps(box)) continue;

        placed.push(box);
        shown.push({ ...c, x, y, big, size, left });
    }

    const cityG = g.append("g").attr("class", "explore-cities").style("pointer-events", "none");
    const city = cityG.selectAll("g").data(shown).join("g")
        .attr("transform", d => `translate(${d.x},${d.y})`);

    city.append("circle")
        .attr("r", d => (d.big ? 3 : 2.3) * k)
        .attr("fill", "#333")
        .attr("stroke", "#fff")
        .attr("stroke-width", 1);

    city.append("text")
        .attr("x", d => d.left ? -5 : 5)
        .attr("dy", "0.35em")
        .attr("text-anchor", d => d.left ? "end" : "start")
        .attr("font-size", d => d.size)
        .attr("font-weight", d => d.big ? 700 : 600)
        .text(d => d.name);
}

// ==============================================================================
// Selecting something
// ==============================================================================

function selectExplore(sel) {
    exploreSel = sel;

    // Shareable link for counties / districts (addresses stay out of the URL)
    const url = new URL(window.location.href);
    if (sel.kind === "area") url.searchParams.set("area", `${sel.area.type}:${sel.area.id}`);
    else url.searchParams.delete("area");
    history.replaceState(null, "", url);

    const apply = () => {
        exploreEl.classList.add("has-result");
        renderExplore();
    };
    // Smoothly move the search box to the corner the first time (where supported)
    if (!exploreEl.classList.contains("has-result") && document.startViewTransition &&
        document.visibilityState === "visible" &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        // A skipped animation still runs apply(); the catch just stops the console error
        document.startViewTransition(apply).ready.catch(() => {});
    } else {
        apply();
    }
}

// ---- Address search (Census geocoder, JSONP since it doesn't allow CORS) ------

let geoCallbackId = 0;

function censusGeocode({ street, city, zip }) {
    return new Promise((resolve, reject) => {
        const cb = `cwaGeocode${++geoCallbackId}`;
        const params = new URLSearchParams({ street, state: "MN", benchmark: "Public_AR_Current",
                                             format: "jsonp", callback: cb });
        if (city) params.set("city", city);
        if (zip) params.set("zip", zip);

        const script = document.createElement("script");
        const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 15000);
        function cleanup() { clearTimeout(timer); delete window[cb]; script.remove(); }

        window[cb] = json => { cleanup(); resolve(json); };
        script.onerror = () => { cleanup(); reject(new Error("network")); };
        script.src = `https://geocoding.geo.census.gov/geocoder/locations/address?${params}`;
        document.head.appendChild(script);
    });
}

// "520 LAFAYETTE RD N, SAINT PAUL, MN, 55155" -> "520 Lafayette Rd N, Saint Paul, MN 55155"
function tidyAddress(a) {
    const parts = String(a).split(",").map(s => s.trim());
    const title = s => s.toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase())
        .replace(/\b(Ne|Nw|Se|Sw|N|S|E|W)\b/g, m => m.toUpperCase());
    if (parts.length >= 4) return `${title(parts[0])}, ${title(parts[1])}, ${parts[2]} ${parts[3]}`;
    return title(a);
}

function setStatus(text, isError = false) {
    addressStatus.textContent = text;
    addressStatus.classList.toggle("is-error", isError);
}

addressForm.addEventListener("submit", event => {
    event.preventDefault();
    const f = new FormData(addressForm);
    const street = String(f.get("street") ?? "").trim();
    const city = String(f.get("city") ?? "").trim();
    const zip = String(f.get("zip") ?? "").trim();

    addressMatches.hidden = true;
    addressMatches.innerHTML = "";

    if (!street || (!city && !zip)) {
        setStatus("Enter a street address plus a city or ZIP code.", true);
        return;
    }
    if (zip && !/^\d{5}$/.test(zip)) {
        setStatus("ZIP codes are 5 digits.", true);
        return;
    }

    setStatus("Looking up the address…");
    const submit = addressForm.querySelector(".explore-submit");
    submit.disabled = true;

    censusGeocode({ street, city, zip })
        .then(json => {
            const matches = (json?.result?.addressMatches ?? [])
                .filter(m => (m.addressComponents?.state ?? "MN").toUpperCase() === "MN");
            if (!matches.length) {
                setStatus("No Minnesota match found. Check the street address, or add a ZIP code.", true);
                return;
            }
            const choose = m => {
                setStatus("");
                addressMatches.hidden = true;
                whenDataReady(() => {
                    prepareExplore();
                    selectExplore({ kind: "address", point: [m.coordinates.x, m.coordinates.y],
                                    label: tidyAddress(m.matchedAddress) });
                });
            };
            if (matches.length === 1) return choose(matches[0]);

            // Several possible matches: let the visitor pick
            setStatus("Several addresses match. Choose one:");
            matches.slice(0, 6).forEach(m => {
                const li = document.createElement("li");
                const btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = tidyAddress(m.matchedAddress);
                btn.addEventListener("click", () => choose(m));
                li.appendChild(btn);
                addressMatches.appendChild(li);
            });
            addressMatches.hidden = false;
        })
        .catch(() => setStatus("The address lookup isn't responding. Try again in a moment, or search by county or district.", true))
        .finally(() => { submit.disabled = false; });
});

// ---- County / district search (suggestions as you type) ------------------------

let suggestions = [];
let activeSuggestion = -1;

function findAreas(query) {
    const q = norm(query);
    if (!q || !exploreData) return [];
    const words = q.split(" ");
    return exploreData.areas
        .map(a => {
            let score = Infinity;
            a.search.forEach(s => {
                if (s === q) score = Math.min(score, 0);
                else if (s.startsWith(q)) score = Math.min(score, 1);
                else if (words.every(w => s.split(" ").some(t => t.startsWith(w)))) score = Math.min(score, 2);
                else if (s.includes(q)) score = Math.min(score, 3);
            });
            return { a, score };
        })
        .filter(r => r.score < Infinity)
        .sort((x, y) => x.score - y.score || AREA_TYPES[x.a.type].order - AREA_TYPES[y.a.type].order ||
                        x.a.label.localeCompare(y.a.label, undefined, { numeric: true }))
        .slice(0, 8)
        .map(r => r.a);
}

function showSuggestions() {
    suggestions = findAreas(areaInput.value);
    activeSuggestion = suggestions.length ? 0 : -1;
    areaList.innerHTML = "";
    if (!areaInput.value.trim()) { closeSuggestions(); return; }

    if (!suggestions.length) {
        const li = document.createElement("li");
        li.className = "explore-suggestion-empty";
        li.textContent = exploreData ? "No matching county, watershed or district" : "Loading…";
        areaList.appendChild(li);
    }
    suggestions.forEach((a, i) => {
        const li = document.createElement("li");
        li.id = `area-opt-${i}`;
        li.setAttribute("role", "option");
        li.innerHTML = `<span class="explore-sugg-label">${escapeHtml(a.label)}</span>` +
                       `<span class="explore-sugg-type">${escapeHtml(a.sub || AREA_TYPES[a.type].word)}</span>`;
        li.addEventListener("mousedown", e => { e.preventDefault(); chooseArea(a); });
        areaList.appendChild(li);
    });
    areaList.hidden = false;
    areaInput.setAttribute("aria-expanded", "true");
    highlightSuggestion();
}

function highlightSuggestion() {
    Array.from(areaList.querySelectorAll("[role=option]")).forEach((li, i) => {
        li.classList.toggle("is-active", i === activeSuggestion);
        li.setAttribute("aria-selected", i === activeSuggestion);
    });
    if (activeSuggestion >= 0) areaInput.setAttribute("aria-activedescendant", `area-opt-${activeSuggestion}`);
    else areaInput.removeAttribute("aria-activedescendant");
}

function closeSuggestions() {
    areaList.hidden = true;
    areaInput.setAttribute("aria-expanded", "false");
    areaInput.removeAttribute("aria-activedescendant");
}

function chooseArea(a) {
    areaInput.value = a.label;
    closeSuggestions();
    selectExplore({ kind: "area", area: a });
}

areaInput.addEventListener("input", () => whenDataReady(() => { prepareExplore(); showSuggestions(); }));
areaInput.addEventListener("focus", () => { if (areaInput.value.trim() && exploreData) showSuggestions(); });
areaInput.addEventListener("blur", () => setTimeout(closeSuggestions, 100));
areaInput.addEventListener("keydown", e => {
    if (areaList.hidden && e.key === "ArrowDown") { showSuggestions(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!suggestions.length) return;
        activeSuggestion = (activeSuggestion + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length;
        highlightSuggestion();
    } else if (e.key === "Enter") {
        e.preventDefault();
        if (suggestions[activeSuggestion]) chooseArea(suggestions[activeSuggestion]);
    } else if (e.key === "Escape") {
        closeSuggestions();
    }
});

// ---- Address / area mode tabs ------------------------------------------------------

const modeTabs = Array.from(document.querySelectorAll(".explore-mode"));
function setMode(tab) {
    modeTabs.forEach(t => {
        const on = t === tab;
        t.classList.toggle("is-active", on);
        t.setAttribute("aria-selected", on);
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    });
}
modeTabs.forEach((t, i) => {
    t.addEventListener("click", () => setMode(t));
    t.addEventListener("keydown", e => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const next = modeTabs[(i + 1) % modeTabs.length];
        next.focus();
        setMode(next);
    });
});

// ---- Radius buttons ------------------------------------------------------------

radiusGroup.addEventListener("click", e => {
    const btn = e.target.closest("button[data-miles]");
    if (!btn) return;
    exploreRadius = +btn.dataset.miles;
    renderExplore();
});

// ---- Redraw the map when its size changes or the tab is opened ------------------

new ResizeObserver(() => {
    if (exploreSel && exploreData) {
        cancelAnimationFrame(renderExploreMap._frame);
        renderExploreMap._frame = requestAnimationFrame(() => renderExploreMap(collectArea()));
    }
}).observe(document.querySelector(".explore-map-box"));

// ---- Shared link: ?area=house:64A restores that search (and opens this tab unless ?tab= says otherwise) ----

(function openFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const param = params.get("area");
    if (!param) return;
    const [type, ...rest] = param.split(":");
    const id = rest.join(":");
    // Switch to Explore only if the URL names no other page (?tab=..., set by nav.js);
    // otherwise the search is restored in the background, ready when they come back
    const tab = params.get("tab");
    if (!tab || tab === "explore") document.getElementById("tab-near-you")?.click();
    whenDataReady(() => {
        prepareExplore();
        const a = exploreData.areas.find(x => x.type === type && x.id === id);
        if (!a) return;
        setMode(document.getElementById("mode-area"));
        areaInput.value = a.label;
        selectExplore({ kind: "area", area: a });
    });
})();