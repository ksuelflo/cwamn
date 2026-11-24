// Scrollytelling logic for "PFAS in Data Centers".
// - A MapLibre map of Minnesota (lakes, rivers, roads, city/town labels and the
//   data center sites) sits behind the text boxes, which flow up the left side.
//   The scrolly section is always dark (class="theme-dark" in index.html); the intro
//   and the rest of the page stay light.
// - Each .step acts when it reaches the middle of the viewport:
//     data-view="mn"                      fit the whole state, centered
//       data-highlight="proposed,construction,moratorium,abandoned"   show these status labels;
//                                          newly labeled dots pop ("proposed" = Hermantown,
//                                          the key for orange)
//     data-status-colors                  green (under construction) / red (moratorium) / gray (abandoned) dots
//                                          + the status legend; without it every site is orange, no legend
//     data-site="<Name from CSV>"          fly to that site (lat/long from the CSV),
//       data-zoom="12"                      highlight + label it, and show its wastewater
//                                          treatment plant (wastewater_lat/long), framing both;
//   The scrolly ends on the Pine Island zoom.
// - The AUAR chart is a static figure on the light page after the scrolly.
// - Only Minnesota is shown: everything outside the state is covered by a mask
//   in the map's background color, and labels are filtered to points inside MN.

const MN_BOUNDS = [[-97.24, 43.5], [-89.49, 49.38]];
// Data center sites: Name, Status, Moratorium, Latitude, Longitude,
// wastewater_lat/wastewater_long, "pfas included"...
// Data files sit next to this script (jsDelivr in production, local files under dev_server.py),
// so their URLs are built from this script's own URL; the version only lives in index.html.
const BASE_URL = new URL(".", document.currentScript.src).href;
const SITES_CSV_URL = BASE_URL + "data/mn_dc_draft_2.csv";
const MN_OUTLINE_URL = BASE_URL + "data/mn_outline.geojson"; // Census 2024 cartographic boundary (500k)
// MN DNR hydrography (get_hydro_layers.R). Passed to MapLibre as URLs, not parsed
// objects, so its web worker fetches and parses them off the main thread.
const MN_RIVERS_URL = BASE_URL + "data/mn_rivers.geojson"; // named rivers/streams >= 25 km
const MN_LAKES_URL = BASE_URL + "data/mn_lakes.geojson";   // lakes, reservoirs, wide river polygons >= 50 acres
const MN_LAKE_LABELS_URL = BASE_URL + "data/mn_lake_labels.geojson"; // one label point per named lake

// Map colors. The map is always dark (it sits inside the dark scrolly section);
// the background layer paints the land so it never depends on the page color.
const MAP_COLORS = {
    roadMinor: "#1c2938",
    roadMajor: "#2b3b4e",
    roadMotorway: "#40556d",
    river: "#3f7cae",
    lake: "#1c3a57",
    riverLabel: "#7fb0d6",
    cityDot: "#E6EDF3",
    label: "#E6EDF3",
    labelMinor: "#9aa7b4",
    halo: "#0E1621",
    mask: "#0E1621",
    outline: "#E6EDF3",
    // Site colors validated together vs #0E1621 (CVD + normal-vision separation, 3:1 contrast);
    // status is also spelled out in the labels, so color is never the only cue.
    site: "#d98a2b",
    siteConstruction: "#7ad9a6",
    siteMoratorium: "#c93a37",
    // Gray on purpose (inactive). Passes CVD + normal-vision separation vs the other dots
    // and the plant blue, 3:1 vs #0E1621; always labeled "Abandoned" when colored.
    siteAbandoned: "#74808c",
    plant: "#7fb0d6"
};

// Status labels a data-highlight step can show (and pop).
const SITE_STATUS_LABELS = { construction: "Under construction", moratorium: "Moratorium", abandoned: "Abandoned", proposed: "Proposed" };

// One ordinary (orange) site is labeled "Proposed" so readers know what orange means.
const PROPOSED_EXAMPLE = "Hermantown Data Center";
let currentHighlights = [];   // label keys currently shown (data-highlight)
let statusColorsOn = false;   // green/red dots on? (data-status-colors)

// A site's status color (green / red / gray), or the default orange.
const statusColor = (t) =>
    ["match", ["get", "category"], "construction", t.siteConstruction, "moratorium", t.siteMoratorium,
        "abandoned", t.siteAbandoned, t.site];

// Site dot color: green/red once status colors are switched on, all orange before that.
function siteColor(t) {
    return statusColorsOn ? statusColor(t) : t.site;
}

// Legend shown on the zoomed-in steps (same colors as the dots).
const LEGEND_ITEMS = [
    ["siteConstruction", "Under construction"],
    ["siteMoratorium", "Moratorium"],
    ["siteAbandoned", "Abandoned"],
    ["site", "Proposed"]
];

// Site dot radius by zoom (kept in one place so the pop animation can land exactly on it).
const SITE_RADIUS = [5, 4.5, 12, 8]; // [zoom, px, zoom, px]
function siteRadiusAt(zoom) {
    const [z0, r0, z1, r1] = SITE_RADIUS;
    const f = Math.min(Math.max((zoom - z0) / (z1 - z0), 0), 1);
    return r0 + f * (r1 - r0);
}

// ---------- Data center sites (CSV) ----------

// Minimal RFC 4180 CSV parser: handles quoted fields with commas, "" escapes and newlines.
function parseCSV(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') inQuotes = false;
            else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(field); rows.push(row); row = []; field = "";
        } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    const [header, ...body] = rows.filter((r) => r.some((v) => v.trim() !== ""));
    return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

async function loadSites() {
    const rows = parseCSV(await fetch(SITES_CSV_URL).then((r) => r.text()));
    const num = (v) => (v === "" || v == null ? NaN : Number(v));
    return rows
        .map((r) => {
            const status = r["Status"];
            const moratorium = r["Moratorium"];
            return {
                name: r["Name"],
                short: shortName(r["Name"]),
                status,
                moratorium,
                category: status === "Under Construction" ? "construction"
                    : status === "Abandoned" ? "abandoned"
                    : moratorium ? "moratorium" : "other",
                lat: num(r["Latitude"]),
                lng: num(r["Longitude"]),
                plantLat: num(r["wastewater_lat"]),
                plantLng: num(r["wastewater_long"]),
                pfasMentioned: (r["pfas included"] ?? r["pfas_mentioned"]) === "Yes"
            };
        })
        .filter((s) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

// "Apple Valley-Oppidan Data Center" -> "Apple Valley", "Monticello Data Center 1 (...)" -> "Monticello"
function shortName(name) {
    return name.replace(/ Data Center\b.*$/, "").replace(/-.*$/, "");
}

// Named water near each zoomed-in wastewater plant (shown on the zoomed-in steps only).
// Points sit on the water itself (checked against data/mn_rivers + mn_lakes), placed
// down/left of the plant so they stay clear of its "Wastewater treatment plant" label
// (which extends ~140px to the plant's right).
//   Empire WWTP (Rosemount + Farmington): Vermillion River, ~1.7 km downstream (SW)
//   WLSSD, Duluth (Hermantown): St. Louis River / St. Louis Bay, Lake Superior
//   Pine Island WWTP: Zumbro River (Middle Fork), ~1 km south
const PLANT_WATER_LABELS = [
    { name: "Vermillion River", lng: -93.12914, lat: 44.65366 },
    { name: "St. Louis River", lng: -92.1438, lat: 46.7292 },
    { name: "St. Louis Bay", lng: -92.12, lat: 46.748 },
    { name: "Lake Superior", lng: -92.03, lat: 46.77 },
    { name: "Zumbro River", lng: -92.63798, lat: 44.19357 }
];

const hasPlant = (s) => Number.isFinite(s.plantLat) && Number.isFinite(s.plantLng);

// Which side of the dot a status label goes on ("right" = label to the LEFT of the dot;
// default puts it to the right). Apple Valley sits just west of Rosemount, and Hermantown
// just west of Duluth's city label, so theirs go left to avoid collisions at statewide zoom.
const LABEL_SIDE = { "Apple Valley": "right", "Hermantown": "right" };
// Extra vertical nudge for a status label, in ems (+ = down). Apple Valley's label
// otherwise covers a nearby orange dot.
const LABEL_NUDGE_Y = { "Apple Valley": 0.9 };

function sitesGeoJSON(sites) {
    return {
        type: "FeatureCollection",
        features: sites.map((s) => {
            // labelKey: which data-highlight value shows this site's status label
            const labelKey = s.name === PROPOSED_EXAMPLE ? "proposed" : s.category;
            return {
                type: "Feature",
                properties: {
                    name: s.name,
                    short: s.short,
                    status: s.status,
                    category: s.category,
                    labelKey,
                    statusLabel: SITE_STATUS_LABELS[labelKey] || "",
                    anchor: LABEL_SIDE[s.short] || "left",
                    labelOffset: [LABEL_SIDE[s.short] === "right" ? -1 : 1, LABEL_NUDGE_Y[s.short] || 0]
                },
                geometry: { type: "Point", coordinates: [s.lng, s.lat] }
            };
        })
    };
}

// One point per site that has a wastewater plant (sites sharing a plant get duplicate
// points; only the active site's is ever shown).
function plantsGeoJSON(sites) {
    return {
        type: "FeatureCollection",
        features: sites.filter(hasPlant).map((s) => ({
            type: "Feature",
            properties: { site: s.name },
            geometry: { type: "Point", coordinates: [s.plantLng, s.plantLat] }
        }))
    };
}

const placeName = ["coalesce", ["get", "name_en"], ["get", "name"]];

// Town/village labels that sit on a wastewater plant get nudged off it (ems, [x, y]; - = left/up).
// Pine Island's label is ~35px west of its plant at zoom 12, so it moves up and left.
const PLACE_LABEL_OFFSET = { "Pine Island": [-2, -1.6] };
const placeOffset = ["match", ["get", "name"],
    ...Object.entries(PLACE_LABEL_OFFSET).flatMap(([n, o]) => [n, ["literal", o]]),
    ["literal", [0, 0]]];
const isLine = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];

// Signed area of a ring (positive = counter-clockwise), used to fix winding for mask holes.
function ringArea(ring) {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    }
    return sum / 2;
}

// A world-sized polygon with Minnesota cut out of it.
function buildMask(mnGeometry) {
    const outer = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
    const polys = mnGeometry.type === "Polygon" ? [mnGeometry.coordinates] : mnGeometry.coordinates;
    const outerSign = Math.sign(ringArea(outer));
    const holes = polys.map(([ring]) =>
        Math.sign(ringArea(ring)) === outerSign ? [...ring].reverse() : ring
    );
    return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [outer, ...holes] } };
}

// River line width grows with zoom and with river length (km), so the
// Mississippi, Minnesota, St. Croix, etc. read heavier than short creeks.
function riverWidth(base) {
    return ["*", base, ["interpolate", ["linear"], ["get", "length_km"], 25, 0.6, 150, 1, 500, 1.6, 1000, 2.2]];
}

function buildStyle(t, mn, sites) {
    const mnGeometry = mn.features[0].geometry;
    const insideMN = ["within", { type: "Feature", properties: {}, geometry: mnGeometry }];

    return {
        version: 8,
        glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
        sources: {
            omt: {
                type: "vector",
                url: "https://tiles.openfreemap.org/planet",
                attribution:
                    '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> ' +
                    '© <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> ' +
                    'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'
            },
            mn: { type: "geojson", data: mn, attribution: "Boundary: U.S. Census Bureau" },
            plantWater: {
                type: "geojson",
                data: {
                    type: "FeatureCollection",
                    features: PLANT_WATER_LABELS.map((w) => ({
                        type: "Feature",
                        properties: { name: w.name },
                        geometry: { type: "Point", coordinates: [w.lng, w.lat] }
                    }))
                }
            },
            rivers: { type: "geojson", data: MN_RIVERS_URL, attribution: "Rivers and lakes: MN DNR" },
            lakes: { type: "geojson", data: MN_LAKES_URL },
            lakeLabels: { type: "geojson", data: MN_LAKE_LABELS_URL },
            sites: { type: "geojson", data: sitesGeoJSON(sites) },
            plants: { type: "geojson", data: plantsGeoJSON(sites) },
            mask: { type: "geojson", data: buildMask(mnGeometry) }
        },
        transition: { duration: 800, delay: 0 },
        layers: [
            // ---- Dark land, regardless of the page background ----
            { id: "background", type: "background", paint: { "background-color": t.mask } },

            // ---- Lakes, then rivers and streams (all drawn under the roads) ----
            {
                id: "lakes",
                type: "fill",
                source: "lakes",
                filter: ["!=", ["get", "type"], "Riverine polygon"],
                paint: { "fill-color": t.lake }
            },
            // Wide-river polygons (Mississippi, Minnesota River...) only once zoomed in.
            // They're long, thin and full of island holes; at statewide zooms MapLibre's
            // tile simplification mangles them into big false wedges (one showed up
            // between Redwood Falls and Mankato), and the river lines cover them anyway.
            {
                id: "lakes-riverine",
                type: "fill",
                source: "lakes",
                minzoom: 8,
                filter: ["==", ["get", "type"], "Riverine polygon"],
                paint: { "fill-color": t.lake }
            },
            {
                id: "rivers",
                type: "line",
                source: "rivers",
                layout: { "line-cap": "round", "line-join": "round" },
                paint: {
                    "line-color": t.river,
                    "line-width": ["interpolate", ["exponential", 1.5], ["zoom"],
                        5, riverWidth(0.7), 9, riverWidth(1.6), 13, riverWidth(4)]
                }
            },

            // ---- Roads (appear progressively by zoom) ----
            {
                id: "roads-minor",
                type: "line",
                source: "omt",
                "source-layer": "transportation",
                minzoom: 11,
                filter: ["all", isLine, ["match", ["get", "class"], ["minor", "service"], true, false]],
                layout: { "line-cap": "round", "line-join": "round" },
                paint: {
                    "line-color": t.roadMinor,
                    "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 11, 0.4, 16, 4]
                }
            },
            {
                id: "roads-major",
                type: "line",
                source: "omt",
                "source-layer": "transportation",
                minzoom: 6,
                filter: ["all", isLine, ["match", ["get", "class"], ["trunk", "primary", "secondary", "tertiary"], true, false]],
                layout: { "line-cap": "round", "line-join": "round" },
                paint: {
                    "line-color": t.roadMajor,
                    "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 6, 0.4, 10, 1.2, 16, 8]
                }
            },
            {
                id: "roads-motorway",
                type: "line",
                source: "omt",
                "source-layer": "transportation",
                minzoom: 4,
                filter: ["all", isLine, ["==", ["get", "class"], "motorway"]],
                layout: { "line-cap": "round", "line-join": "round" },
                paint: {
                    "line-color": t.roadMotorway,
                    "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 4, 0.6, 10, 2, 16, 12]
                }
            },

            // ---- Hide everything outside Minnesota, then draw the state outline ----
            {
                id: "outside-mn-mask",
                type: "fill",
                source: "mask",
                paint: { "fill-color": t.mask, "fill-antialias": false }
            },
            {
                id: "mn-outline",
                type: "line",
                source: "mn",
                layout: { "line-join": "round" },
                paint: {
                    "line-color": t.outline,
                    "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.2, 10, 2.5]
                }
            },

            // ---- River names along the line (big rivers first, creeks once zoomed in) ----
            {
                id: "labels-river",
                type: "symbol",
                source: "rivers",
                minzoom: 6,
                filter: ["any", [">=", ["get", "length_km"], 150], [">=", ["zoom"], 8.5]],
                layout: {
                    "symbol-placement": "line",
                    "symbol-sort-key": ["-", 0, ["get", "length_km"]],
                    "text-field": ["get", "name"],
                    "text-font": ["Noto Sans Italic"],
                    "text-size": ["interpolate", ["linear"], ["zoom"], 6, 10, 12, 13],
                    "text-letter-spacing": 0.05,
                    "symbol-spacing": 400
                },
                paint: { "text-color": t.riverLabel, "text-halo-color": t.halo, "text-halo-width": 1.2 }
            },

            // ---- Lake names: big lakes from zoom 8, more as you zoom in ----
            {
                id: "labels-lake",
                type: "symbol",
                source: "lakeLabels",
                minzoom: 8,
                filter: ["any",
                    [">=", ["get", "acres"], 2000],
                    ["all", [">=", ["zoom"], 9], [">=", ["get", "acres"], 250]],
                    [">=", ["zoom"], 10.5]
                ],
                layout: {
                    "symbol-sort-key": ["-", 0, ["get", "acres"]], // biggest lakes win collisions
                    "text-field": ["get", "name"],
                    "text-font": ["Noto Sans Italic"],
                    "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10, 12, 13],
                    "text-max-width": 7
                },
                paint: { "text-color": t.riverLabel, "text-halo-color": t.halo, "text-halo-width": 1.2 }
            },

            // ---- Water near the zoomed-in wastewater plants (PLANT_WATER_LABELS) ----
            // Zoomed-in steps only; always drawn, and the generic river/lake labels give way to them.
            {
                id: "labels-plant-water",
                type: "symbol",
                source: "plantWater",
                minzoom: 10,
                layout: {
                    "text-field": ["get", "name"],
                    "text-font": ["Noto Sans Italic"], // no Bold Italic on OpenFreeMap
                    "text-size": 14,
                    "text-letter-spacing": 0.04,
                    "text-max-width": 8,
                    "text-allow-overlap": true
                },
                paint: { "text-color": t.riverLabel, "text-halo-color": t.halo, "text-halo-width": 1.6 }
            },

            // ---- Places (only those inside MN) ----
            {
                id: "city-dots",
                type: "circle",
                source: "omt",
                "source-layer": "place",
                minzoom: 4,
                maxzoom: 9,
                filter: ["all", ["==", ["get", "class"], "city"], insideMN],
                paint: { "circle-color": t.cityDot, "circle-radius": 2.5 }
            },
            {
                id: "labels-village",
                type: "symbol",
                source: "omt",
                "source-layer": "place",
                minzoom: 10,
                filter: ["all", ["==", ["get", "class"], "village"], insideMN],
                layout: {
                    "text-field": placeName,
                    "text-offset": placeOffset,
                    "text-font": ["Noto Sans Regular"],
                    "text-size": ["interpolate", ["linear"], ["zoom"], 10, 11, 14, 13],
                    "text-max-width": 8
                },
                paint: { "text-color": t.labelMinor, "text-halo-color": t.halo, "text-halo-width": 1.2 }
            },
            {
                id: "labels-town",
                type: "symbol",
                source: "omt",
                "source-layer": "place",
                minzoom: 7,
                filter: ["all", ["==", ["get", "class"], "town"], insideMN],
                layout: {
                    "text-field": placeName,
                    "text-offset": placeOffset,
                    "text-font": ["Noto Sans Regular"],
                    "text-size": ["interpolate", ["linear"], ["zoom"], 7, 11, 12, 15],
                    "text-max-width": 8
                },
                paint: { "text-color": t.label, "text-halo-color": t.halo, "text-halo-width": 1.2 }
            },
            {
                id: "labels-city",
                type: "symbol",
                source: "omt",
                "source-layer": "place",
                minzoom: 4,
                filter: ["all", ["==", ["get", "class"], "city"], insideMN],
                layout: {
                    "text-field": placeName,
                    "text-font": ["Noto Sans Bold"],
                    "text-size": ["interpolate", ["linear"], ["zoom"], 4, 11, 8, 14, 12, 19],
                    "text-max-width": 8,
                    // Label sits above the dot while dots are shown, centered after
                    "text-variable-anchor": ["bottom", "top", "left", "right"],
                    "text-radial-offset": ["step", ["zoom"], 0.5, 9, 0]
                },
                paint: { "text-color": t.label, "text-halo-color": t.halo, "text-halo-width": 1.4 }
            },

            // ---- Wastewater treatment plant for the active site ----
            {
                id: "plant-ring",
                type: "circle",
                source: "plants",
                filter: ["==", ["get", "site"], ""],
                paint: {
                    "circle-color": "rgba(0,0,0,0)",
                    "circle-radius": 14,
                    "circle-stroke-color": t.plant,
                    "circle-stroke-width": 2
                }
            },
            {
                id: "plant-dot",
                type: "circle",
                source: "plants",
                filter: ["==", ["get", "site"], ""],
                paint: {
                    "circle-color": t.plant,
                    "circle-radius": 7,
                    "circle-stroke-color": t.halo,
                    "circle-stroke-width": 1.5
                }
            },
            {
                id: "plant-label",
                type: "symbol",
                source: "plants",
                filter: ["==", ["get", "site"], ""],
                layout: {
                    "text-field": "Wastewater\ntreatment plant",
                    "text-font": ["Noto Sans Bold"],
                    "text-size": 14,
                    "text-anchor": "left",
                    "text-offset": [1.6, 0],
                    "text-justify": "left",
                    "text-allow-overlap": true
                },
                paint: { "text-color": t.plant, "text-halo-color": t.halo, "text-halo-width": 1.6 }
            },

            // ---- Data center sites (on top of everything) ----
            // All sites as dots; the active step's site gets a ring and a name label.
            // Statewide steps can color + label sites by status (data-highlight); newly
            // highlighted sites "pop" via the two site-pop layers (see popSites()).
            {
                id: "site-pop-ring", // expanding, fading ring behind the popping dot
                type: "circle",
                source: "sites",
                filter: ["in", ["get", "labelKey"], ["literal", []]],
                paint: {
                    "circle-color": "rgba(0,0,0,0)",
                    "circle-radius": 0,
                    "circle-stroke-color": statusColor(t),
                    "circle-stroke-width": 2,
                    "circle-stroke-opacity": 0
                }
            },
            {
                id: "site-dots",
                type: "circle",
                source: "sites",
                // Draw order: plain orange dots at the bottom, status-colored dots on top
                // (so gray Becker 1 sits over orange Becker 2 where they overlap).
                layout: { "circle-sort-key": ["match", ["get", "category"], "other", 0, 1] },
                paint: {
                    "circle-color": siteColor(t),
                    "circle-radius": ["interpolate", ["linear"], ["zoom"], ...SITE_RADIUS],
                    "circle-stroke-color": t.halo,
                    "circle-stroke-width": 1.5
                }
            },
            {
                id: "site-pop", // the popping dot itself, drawn over its normal dot
                type: "circle",
                source: "sites",
                filter: ["in", ["get", "labelKey"], ["literal", []]],
                paint: {
                    "circle-color": statusColor(t),
                    "circle-radius": 0,
                    "circle-stroke-color": t.halo,
                    "circle-stroke-width": 1.5
                }
            },
            {
                id: "site-active",
                type: "circle",
                source: "sites",
                filter: ["==", ["get", "name"], ""],
                paint: {
                    "circle-color": "rgba(0,0,0,0)",
                    "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 9, 12, 16],
                    "circle-stroke-color": siteColor(t),
                    "circle-stroke-width": 2
                }
            },
            {
                id: "site-label",
                type: "symbol",
                source: "sites",
                filter: ["==", ["get", "name"], ""],
                layout: {
                    "text-field": ["get", "name"],
                    "text-font": ["Noto Sans Bold"],
                    "text-size": 15,
                    "text-anchor": "left",
                    "text-offset": [1.4, 0],
                    "text-allow-overlap": true
                },
                paint: { "text-color": t.label, "text-halo-color": t.halo, "text-halo-width": 1.6 }
            },
            {
                id: "site-status-label",
                type: "symbol",
                source: "sites",
                filter: ["in", ["get", "labelKey"], ["literal", []]],
                layout: {
                    "text-field": ["format",
                        ["get", "short"], { "font-scale": 1 },
                        "\n", {},
                        ["get", "statusLabel"], { "font-scale": 0.85, "text-font": ["literal", ["Noto Sans Regular"]] }],
                    "text-font": ["Noto Sans Bold"],
                    "text-size": 14,
                    "text-anchor": ["get", "anchor"],
                    "text-justify": "auto",
                    "text-offset": ["array", "number", 2, ["get", "labelOffset"]],
                    "text-allow-overlap": true
                },
                paint: { "text-color": t.label, "text-halo-color": t.halo, "text-halo-width": 1.6 }
            }
        ]
    };
}

// Statewide view: Minnesota centered and as large as the screen allows
// (the text boxes float over its left side).
function statewidePadding() {
    return { top: 24, bottom: 24, left: 24, right: 24 };
}

// Zoomed-in site views: keep the site in the middle-right, clear of the text boxes on the left
// (.step is max 420px wide, 8vw from the left edge). Small screens: boxes sit on top of the map.
function mapPadding() {
    const w = window.innerWidth;
    if (w <= 900) return { top: 40, bottom: 40, left: 20, right: 20 };
    // right: room for the legend (.map-legend, ~220px wide, 24px from the edge)
    return { top: 40, bottom: 40, left: Math.round(Math.min(w * 0.5, w * 0.08 + 420 + 48)), right: 280 };
}

// ---------- Map ----------
// Created once the MN outline and site CSV have loaded (the style needs the outline
// for the mask and label filters). Rivers and lakes load by URL inside MapLibre's worker.
let map = null;
let sitesByName = new Map();

async function init() {
    const [mn, sites] = await Promise.all([
        fetch(MN_OUTLINE_URL).then((r) => r.json()),
        loadSites()
    ]);
    sitesByName = new Map(sites.map((s) => [s.name, s]));
    buildChart(sites);
    buildLegend();

    map = new maplibregl.Map({
        container: "map",
        style: buildStyle(MAP_COLORS, mn, sites),
        bounds: MN_BOUNDS,
        fitBoundsOptions: { padding: statewidePadding() },
        // Keep the camera near Minnesota (loose enough that the whole state fits on wide screens)
        maxBounds: [[-106, 39], [-81, 53]],
        interactive: false, // scrolling drives the map, not the reader
        attributionControl: { compact: true }
    });
    // If the reader scrolled while the map was loading, catch up to the active step.
    map.once("load", () => {
        mapReady = true;
        const active = document.querySelector(".step.is-active");
        if (active) goToStep(active);
    });
}

// Run fn now if the map has loaded, otherwise once it does.
// (Not map.isStyleLoaded(): that reads false whenever tiles/GeoJSON are still loading,
// long after "load" has fired, so waiting on "load" again would never run fn.)
let mapReady = false;
function whenStyleLoaded(fn) {
    if (!map) return; // init() builds the style with the current state
    mapReady ? fn() : map.once("load", fn);
}

// Ring + label the active site and show its wastewater plant (null clears both).
function setActiveSite(name) {
    whenStyleLoaded(() => {
        const f = ["==", ["get", "name"], name || ""];
        map.setFilter("site-active", f);
        map.setFilter("site-label", f);
        const p = ["==", ["get", "site"], name || ""];
        ["plant-ring", "plant-dot", "plant-label"].forEach((id) => map.setFilter(id, p));
    });
}

// Green/red dot colors on or off (stays on from text box 2 through the zoomed-in steps).
function setStatusColors(on) {
    if (on === statusColorsOn) return;
    statusColorsOn = on;
    whenStyleLoaded(() => {
        map.setPaintProperty("site-dots", "circle-color", siteColor(MAP_COLORS));
        map.setPaintProperty("site-active", "circle-stroke-color", siteColor(MAP_COLORS));
    });
}

// Show status labels for these label keys (e.g. ["proposed", "construction", "moratorium"]).
// Keys that weren't shown on the previous step pop when they switch on.
function setHighlights(keys) {
    const added = keys.filter((c) => !currentHighlights.includes(c));
    currentHighlights = keys;
    whenStyleLoaded(() => {
        map.setFilter("site-status-label", ["in", ["get", "labelKey"], ["literal", keys]]);
        if (added.length) popSites(added);
    });
}

function buildLegend() {
    document.getElementById("map-legend").innerHTML =
        `<p class="legend-title">Data center status</p><ul>` +
        LEGEND_ITEMS.map(([key, label]) =>
            `<li><span class="legend-dot" style="background:${MAP_COLORS[key]}"></span>${label}</li>`).join("") +
        `</ul>`;
}

// "Pop": the dot swells to ~2.2x its size, then eases back down to the normal dot size,
// while a thin ring expands and fades out behind it.
const POP_MS = 1100;
let popFrame = 0;
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

function popSites(keys) {
    const on = ["in", ["get", "labelKey"], ["literal", keys]];
    const off = ["in", ["get", "labelKey"], ["literal", []]];
    cancelAnimationFrame(popFrame);
    map.setFilter("site-pop", on);
    map.setFilter("site-pop-ring", on);
    const start = performance.now();

    const frame = (now) => {
        const t = Math.min((now - start) / POP_MS, 1);
        const base = siteRadiusAt(map.getZoom());
        const swell = t < 0.3 ? easeOutCubic(t / 0.3) : 1 - easeInOutCubic((t - 0.3) / 0.7);
        map.setPaintProperty("site-pop", "circle-radius", base * (1 + 1.2 * swell));
        map.setPaintProperty("site-pop-ring", "circle-radius", base * (1 + 3 * easeOutCubic(t)));
        map.setPaintProperty("site-pop-ring", "circle-stroke-opacity", 0.8 * (1 - t));
        if (t < 1) {
            popFrame = requestAnimationFrame(frame);
        } else {
            // Done: the normal (now status-colored) dot underneath takes over
            map.setFilter("site-pop", off);
            map.setFilter("site-pop-ring", off);
        }
    };
    popFrame = requestAnimationFrame(frame);
}

// ---------- AUAR chart ----------
// Static figure after the scrolly (light page). Horizontal bars: how many sites' AUARs
// mention PFAS ("pfas included" = Yes, accent color) vs. not (neutral). An arrow points
// at the Yes bar with the site name(s). Bars draw in the first time the chart scrolls into view.

const chartEl = document.getElementById("chart");
const tooltipEl = chartEl.querySelector(".chart-tooltip");

function buildChart(sites) {
    const groups = [
        { key: "yes", label: "Mentions PFAS", sites: sites.filter((s) => s.pfasMentioned) },
        { key: "no", label: "Does not mention PFAS", sites: sites.filter((s) => !s.pfasMentioned) }
    ];
    const max = Math.max(...groups.map((g) => g.sites.length), 1);

    chartEl.querySelector(".chart-n").textContent = sites.length;
    chartEl.querySelector(".chart-bars").innerHTML = groups.map((g) => `
        <div class="bar-row bar-${g.key}" data-key="${g.key}" tabindex="0">
            <div class="bar-label">${g.label}</div>
            <div class="bar-track">
                <div class="bar" style="--w:${(g.sites.length / max) * 100}%"></div>
                <span class="bar-value" style="--w:${(g.sites.length / max) * 100}%">${g.sites.length}${
                    g.key === "yes" && g.sites.length ? annotation(g.sites.map((s) => shortName(s.name)).join(", ")) : ""
                }</span>
            </div>
        </div>`).join("");

    // Table view for screen readers
    chartEl.querySelector(".chart-table tbody").innerHTML = groups
        .map((g) => `<tr><th scope="row">${g.label}</th><td>${g.sites.length}</td></tr>`).join("");

    // Hover / focus tooltip: which sites are in each bar
    chartEl.querySelectorAll(".bar-row").forEach((row) => {
        const g = groups.find((x) => x.key === row.dataset.key);
        const show = () => {
            tooltipEl.innerHTML = `<strong>${g.label}: ${g.sites.length}</strong>` +
                `<ul>${g.sites.map((s) => `<li>${shortName(s.name)}</li>`).join("")}</ul>`;
            tooltipEl.hidden = false;
            const r = row.getBoundingClientRect(), c = chartEl.getBoundingClientRect();
            tooltipEl.style.left = `${r.left - c.left}px`;
            tooltipEl.style.top = `${r.bottom - c.top + 8}px`;
        };
        const hide = () => { tooltipEl.hidden = true; };
        row.addEventListener("mouseenter", show);
        row.addEventListener("focus", show);
        row.addEventListener("mouseleave", hide);
        row.addEventListener("blur", hide);
    });
}

// Curved arrow pointing left (back at the bar and its value) with a caption after it.
function annotation(text) {
    return `<span class="bar-annotation">
        <svg class="bar-arrow" viewBox="0 0 64 28" width="64" height="28" aria-hidden="true">
            <path d="M60 6 C 40 2, 18 4, 6 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M5 9 L 6 18 L 14 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="bar-annotation-text">${text}</span>
    </span>`;
}

// Draw the bars in the first time the chart is mostly on screen.
new IntersectionObserver((entries, obs) => {
    if (entries.some((e) => e.isIntersecting)) {
        chartEl.classList.add("is-visible");
        obs.disconnect();
    }
}, { threshold: 0.5 }).observe(chartEl);

init();

// ---------- Steps ----------
const graphicEl = document.querySelector(".scrolly-graphic");

function goToStep(step) {
    if (!map) return;

    const site = step.dataset.site ? sitesByName.get(step.dataset.site) : null;
    if (step.dataset.site && !site && sitesByName.size) console.warn(`No site named "${step.dataset.site}" in ${SITES_CSV_URL}`);
    setActiveSite(site ? site.name : null);
    setStatusColors("statusColors" in step.dataset);
    setHighlights(step.dataset.highlight ? step.dataset.highlight.split(",").map((s) => s.trim()) : []);
    graphicEl.classList.toggle("show-legend", "statusColors" in step.dataset); // legend whenever the status colors are on

    const zoom = Number(step.dataset.zoom) || 12;
    if (step.dataset.view === "mn") {
        map.fitBounds(MN_BOUNDS, { padding: statewidePadding(), duration: 2000 });
    } else if (site && hasPlant(site)) {
        // Frame the site and its wastewater plant together (never closer than data-zoom).
        const pad = mapPadding();
        map.fitBounds(
            [[Math.min(site.lng, site.plantLng), Math.min(site.lat, site.plantLat)],
             [Math.max(site.lng, site.plantLng), Math.max(site.lat, site.plantLat)]],
            // extra room on the right for the labels
            { padding: { ...pad, top: pad.top + 60, bottom: pad.bottom + 60, right: pad.right + 200 },
              maxZoom: zoom, duration: 2500, essential: true }
        );
    } else if (site) {
        map.flyTo({ center: [site.lng, site.lat], zoom, padding: mapPadding(), duration: 2500, essential: true });
    }
}

const stepObserver = new IntersectionObserver(
    (entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                document.querySelectorAll(".step.is-active").forEach((s) => s.classList.remove("is-active"));
                entry.target.classList.add("is-active");
                goToStep(entry.target);
            }
        }
    },
    { rootMargin: "-50% 0px -50% 0px" }
);

document.querySelectorAll(".scrolly .step").forEach((step) => stepObserver.observe(step));
