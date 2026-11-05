const width = 800;
const height = 900;
const MAX_ZOOM = 40;

// ==============================================================================
// SVG + layer groups
// ==============================================================================

const svg = d3.select("#map").attr("viewBox", [0, 0, width, height]);
const tooltip = d3.select("#tooltip");
const mapWrap = d3.select("#map-wrap");

// Layer order (bottom to top): boundaries, data layers, state outline
const g = svg.append("g");
const boundaryG = g.append("g").attr("class", "boundaries");
const countiesG = boundaryG.append("g").attr("class", "counties");
const watershedsG = boundaryG.append("g").attr("class", "watersheds").style("display", "none");
const legislativeG = boundaryG.append("g").attr("class", "legislative").style("display", "none");
const congressG = boundaryG.append("g").attr("class", "congress").style("display", "none");

// One group per data layer; only one is visible at a time
const layerGroups = {
    nitrate: g.append("g").attr("class", "layer nitrate"),
    pfas: g.append("g").attr("class", "layer pfas"),
    waterbodies: g.append("g").attr("class", "layer waterbodies")
};

const outlineG = g.append("g");   // state outline sits above the data so the border stays crisp

// Map pin marking the selected nitrate site (topmost layer; clicks pass through it)
const selectionG = g.append("g")
    .attr("class", "selection-marker")
    .style("pointer-events", "none");

// Teardrop pin: tip at (0, 0), round head centered at (0, -16)
const PIN_PATH = "M0,0 C-2,-6 -9,-10 -9,-16 A9,9 0 1 1 9,-16 C9,-10 2,-6 0,0 Z";
const PIN_COLOR = "#1f6f92";
const PIN_SCALE = 2;   // pin size multiplier (1 = original 18px-wide pin)

// UTM Zone 15N-style projection: transverse Mercator centered on 93°W
const projection = d3.geoTransverseMercator().rotate([93, 0]);
const path = d3.geoPath(projection);

// Loaded data lives here so filters can redraw layers later
const data = {};
let currentLayer = null;
let selectedSiteId = null;   // nitrate site shown in Chart 1
let selectedPwsid = null;    // PFAS water system shown in Chart 1

// ==============================================================================
// Settings
// ==============================================================================

const LAYERS = [
    { id: "nitrate", label: "Nitrate" },
    { id: "pfas", label: "PFAS" },
    { id: "waterbodies", label: "Impaired waterbodies" }
];
const DEFAULT_LAYER = "nitrate";

// ---- Nitrate ----
const NITRATE_STANDARD = 10;   // mg/L nitrate as N
const THIN_SAMPLES = 3;        // sites with fewer samples than this are drawn lighter
const THIN_OPACITY = 0.4;
const MIN_SAMPLE_OPTIONS = [1, 3, 5, 10];   // choices for the "Minimum samples" filter
const DEFAULT_SITE = "MNPCA-S016-277";   // site shown in Chart 1 before the user clicks one

const nitrateBins = [1, 3, NITRATE_STANDARD];
const nitrateColors = ["#fde9a9", "#f9b25e", "#e6550d", "#99000d"];
const nitrateLabels = ["Under 1 mg/L", "1–3 mg/L", "3–10 mg/L", "Over 10 mg/L (drinking water standard)"];
const nitrateColor = d3.scaleThreshold().domain(nitrateBins).range(nitrateColors);

const SEASONS = [
    { id: "all", label: "All year", months: d3.range(1, 13) },
    { id: "spring", label: "Spring (Apr–Jun)", months: [4, 5, 6] },
    { id: "summer", label: "Summer (Jul–Sep)", months: [7, 8, 9] },
    { id: "fall", label: "Fall (Oct–Nov)", months: [10, 11] },
    { id: "winter", label: "Winter (Dec–Mar)", months: [12, 1, 2, 3] }
];

const WATER_TYPES = ["Rivers & streams", "Lakes", "Wetlands", "Groundwater", "Stormwater"];
const DEFAULT_WATER_TYPES = ["Rivers & streams", "Lakes", "Wetlands"];

// ---- PFAS ----
// Categories come from pfas_clean.R (pfas_category). "Not detected" is drawn hollow.
const PFAS_NOT_DETECTED = "Not detected";
const pfasCategories = [
    "Detected, below half the limit",
    "Approaching limit",
    "Above limit",
    "Above limit (2x or more)"
];
const pfasColors = ["#dcc6ea", "#b07fcc", "#7d3a9e", "#3f0f5c"];
const pfasColor = d3.scaleOrdinal().domain(pfasCategories).range(pfasColors);
const ALL_PFAS_CATEGORIES = [PFAS_NOT_DETECTED, ...pfasCategories];
const pfasRank = new Map(ALL_PFAS_CATEGORIES.map((c, i) => [c, i]));
const PFAS_ABOVE_LIMIT = new Set(["Above limit", "Above limit (2x or more)"]);

// EPA limits (ng/L) by compound, used when pfas_long has no mcl_ngl for a row.
// Keys are upper-case so "PFHxS" and "PFHXS" both match.
const PFAS_LIMITS = { PFOA: 4, PFOS: 4, PFHXS: 10, PFNA: 10, "HFPO-DA": 10 };
const pfasLimit = analyte => PFAS_LIMITS[String(analyte).toUpperCase()] ?? null;

// ---- Impaired waterbodies ----
// Categories in priority order (same order as group_priority in R). A water with several
// problems is colored by the highest-ranked category that is switched on in the filters.
const WATER_GROUPS = [
    { id: "PFAS",                   color: "#6a1b9a" },
    { id: "Other toxic chemicals",  color: "#c2185b" },
    { id: "Mercury",                color: "#8fa3b5" },   // muted: widespread, mostly airborne
    { id: "Nutrients & low oxygen", color: "#2e9e44" },
    { id: "Bacteria",               color: "#e07b00" },
    { id: "Salts & metals",         color: "#1f6fb4" },
    { id: "Sediment",               color: "#8c5a2b" },
    { id: "Aquatic life & habitat", color: "#c9a227" },
    { id: "Other",                  color: "#999999" }
];
const waterGroupColor = new Map(WATER_GROUPS.map(g => [g.id, g.color]));
const waterGroupRank = new Map(WATER_GROUPS.map((g, i) => [g.id, i]));

const WATER_PLAN = [
    { id: "needs", label: "Still needs a cleanup plan" },
    { id: "planned", label: "Cleanup plans in place" }
];
const WATER_FADED_OPACITY = 0.3;    // waters with plans in place for every impairment
const WATER_HALO_WIDTH = 6;         // px; soft outline so small waters stay visible zoomed out

// ==============================================================================
// Filter state
// ==============================================================================

let nitrateFilters;
let pfasFilters;
let waterFilters;

function defaultWaterFilters() {
    return {
        groups: new Set(data.waterGroups),
        plan: new Set(WATER_PLAN.map(p => p.id)),
        types: new Set(data.waterTypes)
    };
}

function defaultNitrateFilters() {
    const [minYear, maxYear] = data.nitrateYears;
    return {
        yearMin: minYear,
        yearMax: maxYear,
        season: "all",
        exceedOnly: false,
        waterTypes: new Set(DEFAULT_WATER_TYPES),
        minSamples: 3          // hide sites with 1–2 samples by default; readers can lower it to 1
    };
}

function defaultPfasFilters() {
    return {
        categories: new Set(ALL_PFAS_CATEGORIES),
        compound: "any",
        sources: new Set(data.pfasSources)
    };
}

// ==============================================================================
// Zoom
// ==============================================================================

const zoom = d3.zoom()
    .scaleExtent([1, MAX_ZOOM])
    .translateExtent([[0, 0], [width, height]])
    .on("zoom", zoomed);

svg.call(zoom).on("dblclick.zoom", null);

let activeFeature = null;

function zoomed({ transform }) {
    g.attr("transform", transform);
    // Keep point markers the same on-screen size at any zoom (base radius stored in d.r)
    g.selectAll(".layer circle").attr("r", d => (d.r ?? 4) / transform.k);
    updateSelectionMarker(transform.k);
}

// Draws (or moves) the pin over the selected nitrate site or PFAS water system.
// The pin stays the same on-screen size at any zoom and sits just above its dot.
function updateSelectionMarker(k = currentZoomK()) {
    const selected =
        currentLayer === "nitrate" ? (data.nitrateVisible ?? []).find(d => d.properties.site_id === selectedSiteId)
      : currentLayer === "pfas"    ? (data.pfasVisible ?? []).find(d => d.properties.pwsid === selectedPwsid)
      : null;

    selectionG.selectAll("g.pin")
        .data(selected ? [selected] : [])
        .join(enter => {
            const pin = enter.append("g").attr("class", "pin")
                .style("filter", "drop-shadow(0 1px 1.5px rgba(0,0,0,0.45))");
            pin.append("path")
                .attr("d", PIN_PATH)
                .attr("fill", PIN_COLOR)
                .attr("stroke", "#fff")
                .attr("stroke-width", 1.5 / PIN_SCALE * 1.4)   // keeps the white outline crisp, not chunky
                .attr("stroke-linejoin", "round");
            pin.append("circle")
                .attr("cy", -16)
                .attr("r", 3.5)
                .attr("fill", "#fff");
            return pin;
        })
        .attr("transform", d => {
            const [x, y] = projection(d.geometry.coordinates);
            // scale(1/k) undoes the map zoom, so the pin keeps its on-screen size;
            // the dot's radius is shifted first so the tip sits on top of the dot at any pin size
            return `translate(${x},${y}) scale(${1 / k}) translate(0,${-(d.r ?? 4)}) scale(${PIN_SCALE})`;
        });
}

function currentZoomK() {
    return d3.zoomTransform(svg.node()).k;
}

function zoomToFeature(event, d) {
    event.stopPropagation();
    if (activeFeature === d) return reset();
    zoomTo(d);
}

// Zooms the map to a county or watershed (also used by the "Top places" chart)
function zoomTo(d) {
    activeFeature = d;
    boundaryG.selectAll(".boundary").classed("active", f => f === d);

    const [[x0, y0], [x1, y1]] = path.bounds(d);
    const k = Math.min(MAX_ZOOM, 0.85 / Math.max((x1 - x0) / width, (y1 - y0) / height));
    svg.transition().duration(750).call(
        zoom.transform,
        d3.zoomIdentity
            .translate(width / 2, height / 2)
            .scale(k)
            .translate(-(x0 + x1) / 2, -(y0 + y1) / 2)
    );
}

function reset() {
    activeFeature = null;
    boundaryG.selectAll(".boundary").classed("active", false);
    svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
}

d3.select("#zoom-in").on("click", () => svg.transition().duration(300).call(zoom.scaleBy, 1.6));
d3.select("#zoom-out").on("click", () => svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.6));
d3.select("#zoom-reset").on("click", reset);
svg.on("click", reset); // clicking empty space zooms back out

// ---- Easier point picking: snap to the nearest nitrate site / PFAS system ----
// Dots are small, and hollow ones only react on their outline. These listeners run first
// (capture phase): if the pointer is within POINT_HIT_PX of a dot's edge, that dot gets the
// hover/click, and the county underneath doesn't.
const POINT_HIT_PX = 10;
const pointIndexCache = new Map();   // layer -> { list, delaunay }

function pointLayerState() {
    if (currentLayer === "nitrate") return {
        list: data.nitrateVisible ?? [],
        tooltip: nitrateTooltip,
        select: d => selectSite(d.properties.site_id)
    };
    if (currentLayer === "pfas") return {
        list: data.pfasVisible ?? [],
        tooltip: pfasTooltip,
        select: d => selectPfasSystem(d.properties.pwsid)
    };
    return null;
}

function nearestPoint(event) {
    const st = pointLayerState();
    if (!st || !st.list.length) return null;

    // Rebuild the lookup only when the visible points change
    let cache = pointIndexCache.get(currentLayer);
    if (!cache || cache.list !== st.list) {
        const xy = st.list.map(d => projection(d.geometry.coordinates));
        cache = { list: st.list, xy, delaunay: d3.Delaunay.from(xy) };
        pointIndexCache.set(currentLayer, cache);
    }

    const t = d3.zoomTransform(svg.node());
    const [vx, vy] = d3.pointer(event, svg.node());            // viewBox units
    const [mx, my] = t.invert([vx, vy]);                       // map units
    const i = cache.delaunay.find(mx, my);
    if (i < 0) return null;

    const pxPerUnit = svg.node().getBoundingClientRect().width / width;   // viewBox -> screen px
    const [px, py] = cache.xy[i];
    const distVB = Math.hypot(px - mx, py - my) * t.k;
    const d = cache.list[i];
    return distVB <= (d.r ?? 4) + POINT_HIT_PX / pxPerUnit ? { d, st } : null;
}

let pointHovered = false;

svg.node().addEventListener("mousemove", event => {
    if (event.buttons) return;                 // panning: leave it alone
    const hit = nearestPoint(event);
    if (hit) {
        event.stopPropagation();               // no county tooltip underneath
        pointHovered = true;
        svg.style("cursor", "pointer");
        showTooltipHtml(event, hit.st.tooltip(hit.d));
    } else if (pointHovered) {
        pointHovered = false;
        svg.style("cursor", null);
        hideTooltip();
    }
}, true);

svg.node().addEventListener("click", event => {
    const hit = nearestPoint(event);
    if (!hit) return;
    event.stopPropagation();                   // don't zoom to the county / reset
    hit.st.select(hit.d);
}, true);

svg.node().addEventListener("mouseleave", () => {
    if (pointHovered) { pointHovered = false; svg.style("cursor", null); hideTooltip(); }
});

// ==============================================================================
// Boundaries (counties / watersheds / legislative / congressional), picked from
// the dropdown in the HTML. Everything that depends on the boundary type (the
// outlines, the "Top places" ranking, place drill-downs, key-number wording)
// reads it from here.
// ==============================================================================

const BOUNDARIES = {
    counties: {
        group: countiesG,
        plural: "counties", title: "Counties", back: "← All counties",
        waterId: p => p.county_fips,
        waterLabel: p => p.county,
        featureId: f => f.id,
        name: label => `${label} County`,
        where: label => `in ${label} County`,
        labelWidth: 120
    },
    watersheds: {
        group: watershedsG,
        plural: "watersheds", title: "Watersheds", back: "← All watersheds",
        waterId: p => p.huc8,
        waterLabel: p => p.huc8_name ?? `HUC ${p.huc8}`,
        featureId: f => f.properties.huc8,
        name: label => `${label} watershed`,
        where: label => `in the ${label} watershed`,
        extra: id => `HUC ${id}`,
        labelWidth: 175
    },
    // State House districts, drawn with the (nesting) Senate districts as heavier lines.
    // The ranking is by House district; each one names its Senate district too.
    legislative: {
        group: legislativeG,
        plural: "House districts", title: "House districts", back: "← All districts",
        waterId: p => p.house_dist,
        waterLabel: p => `House ${p.house_dist}`,
        featureId: f => f.properties.house,
        name: label => `${label.replace("House", "House District")} (Senate ${parseInt(label.replace(/\D*/, ""), 10)})`,
        where: label => `in ${label.replace("House", "House District")}`,
        labelWidth: 95
    },
    congressional: {
        group: congressG,
        plural: "congressional districts", title: "Congressional districts", back: "← All districts",
        waterId: p => p.cong_dist,
        waterLabel: p => `District ${p.cong_dist}`,
        featureId: f => f.properties.district,
        name: label => `Congressional ${label}`,
        where: label => `in Congressional ${label}`,
        labelWidth: 95
    }
};

let currentBoundary = "counties";

function setBoundary(layer) {
    if (!BOUNDARIES[layer]) return;
    currentBoundary = layer;
    Object.entries(BOUNDARIES).forEach(([id, b]) => b.group.style("display", id === layer ? null : "none"));
    boundarySelect.property("value", layer);

    if (activeFeature) reset();
    hideTooltip();
    if (currentLayer === "waterbodies") {
        if (activeChartTab === 1) renderChart2();   // ranking follows the toggle
        renderKeyNumbers("waterbodies");            // a drilled-into place no longer applies
    }
}

const boundarySelect = d3.select("#boundary-select")
    .on("click", event => event.stopPropagation())
    .on("change", function () { setBoundary(this.value); });

// ==============================================================================
// Data layer toggle (nitrate / PFAS / waterbodies) in the toolbar
// ==============================================================================

const layerToggle = d3.select(".map-toolbar").append("div")
    .attr("class", "layer-toggle")
    .attr("role", "group")
    .attr("aria-label", "Map data");

layerToggle.selectAll("button")
    .data(LAYERS)
    .join("button")
    .attr("type", "button")
    .text(d => d.label)
    .on("click", (event, d) => {
        event.stopPropagation();
        setDataLayer(d.id);
    });

function setDataLayer(layerId) {
    currentLayer = layerId;

    Object.entries(layerGroups).forEach(([id, group]) =>
        group.style("display", id === layerId ? null : "none"));

    layerToggle.selectAll("button")
        .classed("selected", d => d.id === layerId)
        .attr("aria-pressed", d => d.id === layerId);

    // "About this layer": show only the explainer block written for this layer (in index.html)
    d3.selectAll(".explainer-text")
        .property("hidden", function () { return this.dataset.layer !== layerId; });

    renderLegend(layerId);
    renderFilters(layerId);
    updateLayer(layerId);
    renderKeyNumbers(layerId);
    updateSelectionMarker();       // pin shows on the nitrate and PFAS layers
    updateChartTabLabels(layerId);
    setChartTab(activeChartTab);   // redraws whichever chart tab is open
    hideTooltip();
}

// ==============================================================================
// Sidebar: legend + data filters dropdown
// ==============================================================================

const sidebar = mapWrap.append("div").attr("class", "sidebar");
const legend = sidebar.append("div").attr("class", "legend");

const filtersBox = sidebar.append("div").attr("class", "filters");

// Desktop: filters are always visible under a heading.
// Small screens (layout stacked): the same panel collapses behind this button.
const filtersButton = filtersBox.append("button")
    .attr("type", "button")
    .attr("class", "filters-toggle")
    .attr("aria-expanded", "false")
    .attr("aria-controls", "filters-panel")
    .html('Data filters <span class="filters-caret" aria-hidden="true">▾</span>');

const filtersPanel = filtersBox.append("div")
    .attr("class", "filters-panel")
    .attr("id", "filters-panel");

const filtersIntro = filtersPanel.append("div").attr("class", "filters-intro");
filtersIntro.append("div").attr("class", "filters-title").text("Filter the map");
const filtersHint = filtersIntro.append("p").attr("class", "filters-hint");

const filtersBody = filtersPanel.append("div").attr("class", "filters-body");

const FILTER_HINTS = {
    nitrate: "Narrow by year, season, or water type. The map and count update as you go.",
    pfas: "Narrow by result, compound, or water source. The map and count update as you go.",
    waterbodies: "Narrow by problem, cleanup-plan status, or water type. Turning off a problem recolors waters by their next problem."
};

const mobileQuery = window.matchMedia("(max-width: 900px)");
let filtersOpenOnMobile = false;

function applyFiltersMode() {
    if (mobileQuery.matches) {
        filtersButton.style("display", null).attr("aria-expanded", filtersOpenOnMobile)
            .classed("open", filtersOpenOnMobile);
        filtersPanel.property("hidden", !filtersOpenOnMobile);
    } else {
        filtersButton.style("display", "none");
        filtersPanel.property("hidden", false);
    }
}

mobileQuery.addEventListener("change", applyFiltersMode);
applyFiltersMode();
const filtersFooter = filtersPanel.append("div").attr("class", "filters-footer");
const filtersCount = filtersFooter.append("span").attr("class", "filters-count").attr("aria-live", "polite");
const filtersReset = filtersFooter.append("button")
    .attr("type", "button")
    .attr("class", "filters-reset")
    .text("Reset filters");

filtersButton.on("click", () => {
    filtersOpenOnMobile = !filtersOpenOnMobile;
    applyFiltersMode();
});

filtersReset.on("click", () => {
    if (currentLayer === "nitrate") nitrateFilters = defaultNitrateFilters();
    if (currentLayer === "pfas") pfasFilters = defaultPfasFilters();
    if (currentLayer === "waterbodies") waterFilters = defaultWaterFilters();
    renderLegend(currentLayer);
    renderFilters(currentLayer);
    updateLayer(currentLayer);
});

function setCount(shown, total, noun) {
    filtersCount.text(`Showing ${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`);
}

// ---- Small form builders ----

let controlId = 0;
const nextId = prefix => `${prefix}-${++controlId}`;

function fieldset(container, legendText) {
    const fs = container.append("fieldset").attr("class", "filter-group");
    fs.append("legend").text(legendText);
    return fs;
}

function checkboxList(container, options, selectedSet, onChange) {
    options.forEach(opt => {
        const id = nextId("cb");
        const row = container.append("div").attr("class", "filter-option");
        row.append("input")
            .attr("type", "checkbox")
            .attr("id", id)
            .property("checked", selectedSet.has(opt.value))
            .on("change", function () {
                this.checked ? selectedSet.add(opt.value) : selectedSet.delete(opt.value);
                onChange();
            });
        row.append("label").attr("for", id).text(opt.label);
    });
}

function radioList(container, name, options, selectedValue, onChange) {
    options.forEach(opt => {
        const id = nextId("rb");
        const row = container.append("div").attr("class", "filter-option");
        row.append("input")
            .attr("type", "radio")
            .attr("name", name)
            .attr("id", id)
            .property("checked", opt.value === selectedValue)
            .on("change", () => onChange(opt.value));
        row.append("label").attr("for", id).text(opt.label);
    });
}

function selectControl(container, labelText, options, selectedValue, onChange) {
    const id = nextId("sel");
    const wrap = container.append("div").attr("class", "filter-select");
    wrap.append("label").attr("for", id).text(labelText);
    const sel = wrap.append("select").attr("id", id).on("change", function () { onChange(this.value); });
    sel.selectAll("option")
        .data(options)
        .join("option")
        .attr("value", d => d.value)
        .property("selected", d => String(d.value) === String(selectedValue))
        .text(d => d.label);
    return sel;
}

// ---- Per-layer filter panels ----

function renderFilters(layerId) {
    filtersBody.html("");
    filtersHint.text(FILTER_HINTS[layerId] ?? "").style("display", FILTER_HINTS[layerId] ? null : "none");

    if (layerId === "nitrate") renderNitrateFilters();
    else if (layerId === "pfas") renderPfasFilters();
    else if (layerId === "waterbodies") renderWaterFilters();
}

function renderWaterFilters() {
    const f = waterFilters;

    const groupFs = fieldset(filtersBody, "Problem");
    checkboxList(groupFs, data.waterGroups.map(g => ({ value: g, label: g })), f.groups,
        () => updateLayer("waterbodies"));

    const planFs = fieldset(filtersBody, "Cleanup plan");
    checkboxList(planFs, WATER_PLAN.map(p => ({ value: p.id, label: p.label })), f.plan,
        () => updateLayer("waterbodies"));

    const typeFs = fieldset(filtersBody, "Water type");
    checkboxList(typeFs, data.waterTypes.map(t => ({ value: t, label: t })), f.types,
        () => updateLayer("waterbodies"));
}

function renderNitrateFilters() {
    const f = nitrateFilters;
    const years = d3.range(data.nitrateYears[0], data.nitrateYears[1] + 1).map(y => ({ value: y, label: y }));

    // Years
    const yearsFs = fieldset(filtersBody, "Years");
    const yearRow = yearsFs.append("div").attr("class", "filter-row");
    selectControl(yearRow, "From", years, f.yearMin, v => {
        f.yearMin = +v;
        if (f.yearMin > f.yearMax) f.yearMax = f.yearMin;
        renderFilters("nitrate");
        updateLayer("nitrate");
    });
    selectControl(yearRow, "To", years, f.yearMax, v => {
        f.yearMax = +v;
        if (f.yearMax < f.yearMin) f.yearMin = f.yearMax;
        renderFilters("nitrate");
        updateLayer("nitrate");
    });

    // Season
    const seasonFs = fieldset(filtersBody, "Season");
    radioList(seasonFs, "nitrate-season",
        SEASONS.map(s => ({ value: s.id, label: s.label })),
        f.season,
        v => { f.season = v; updateLayer("nitrate"); });

    // Above the standard
    const exceedFs = fieldset(filtersBody, "Above the standard");
    const exceedId = nextId("cb");
    const exceedRow = exceedFs.append("div").attr("class", "filter-option");
    exceedRow.append("input")
        .attr("type", "checkbox")
        .attr("id", exceedId)
        .property("checked", f.exceedOnly)
        .on("change", function () { f.exceedOnly = this.checked; updateLayer("nitrate"); });
    exceedRow.append("label").attr("for", exceedId)
        .text(`Only sites that exceeded ${NITRATE_STANDARD} mg/L at least once`);

    // Water type
    const typeFs = fieldset(filtersBody, "Water type");
    checkboxList(typeFs, WATER_TYPES.map(t => ({ value: t, label: t })), f.waterTypes,
        () => updateLayer("nitrate"));

    // Minimum samples
    const minFs = fieldset(filtersBody, "Minimum samples");
    selectControl(minFs, "Only show sites with at least",
        MIN_SAMPLE_OPTIONS.map(n => ({ value: n, label: n === 1 ? "1 sample (all sites)" : `${n} samples` })),
        f.minSamples,
        v => { f.minSamples = +v; renderLegend("nitrate"); updateLayer("nitrate"); });
}

function renderPfasFilters() {
    const f = pfasFilters;

    // Result category
    const resultFs = fieldset(filtersBody, "Result");
    checkboxList(resultFs, ALL_PFAS_CATEGORIES.map(c => ({ value: c, label: c })), f.categories,
        () => updateLayer("pfas"));

    // Compound
    const compoundFs = fieldset(filtersBody, "Compound");
    selectControl(compoundFs, "Systems where this was detected",
        [{ value: "any", label: "Any compound" },
         ...data.pfasCompounds.map(c => ({ value: c.analyte, label: `${c.analyte} (${c.n} systems)` }))],
        f.compound,
        v => { f.compound = v; updateLayer("pfas"); });

    // Water source
    const sourceFs = fieldset(filtersBody, "Water source");
    checkboxList(sourceFs, data.pfasSources.map(s => ({ value: s, label: s })), f.sources,
        () => updateLayer("pfas"));
}

// ==============================================================================
// Tooltip helpers
// ==============================================================================

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function positionTooltip(event) {
    const [mx, my] = d3.pointer(event, mapWrap.node());
    tooltip.style("opacity", 1).style("left", `${mx + 12}px`).style("top", `${my + 12}px`);
}

function showTooltip(event, text) {
    positionTooltip(event);
    tooltip.text(text);
}

function showTooltipHtml(event, html) {
    positionTooltip(event);
    tooltip.html(html);
}

function hideTooltip() {
    tooltip.style("opacity", 0);
}

// ==============================================================================
// Legends
// ==============================================================================

function legendRow(container, label, swatchStyle = {}, hollow = false) {
    const row = container.append("div").attr("class", "legend-row");
    const swatch = row.append("span").attr("class", hollow ? "legend-swatch hollow" : "legend-swatch");
    Object.entries(swatchStyle).forEach(([k, v]) => swatch.style(k, v));
    row.append("span").text(label);
}

function renderLegend(layerId) {
    legend.html("");

    if (layerId === "nitrate") {
        legend.style("display", null);
        legend.append("div").attr("class", "legend-title").text("Median nitrate (as N)");
        nitrateLabels.forEach((label, i) => legendRow(legend, label, { background: nitrateColors[i] }));
        legendRow(legend, "Never detected", { "border-color": "#b8860b" }, true);
        // Only describe the lighter dots when the minimum-samples filter lets them show
        if (!nitrateFilters || nitrateFilters.minSamples < THIN_SAMPLES) {
            legendRow(legend, `Fewer than ${THIN_SAMPLES} samples (lighter)`,
                { background: nitrateColors[2], opacity: THIN_OPACITY });
        }
        legend.append("div").attr("class", "legend-note")
            .text("Larger circles = more samples in the selected period.");
        return;
    }

    if (layerId === "pfas") {
        legend.style("display", null);
        legend.append("div").attr("class", "legend-title").text("PFAS in community drinking water");
        legendRow(legend, "Not detected", { "border-color": "#888" }, true);
        pfasCategories.forEach((label, i) => legendRow(legend, label, { background: pfasColors[i] }));
        legend.append("div").attr("class", "legend-note")
            .text("Compared with EPA limits. Larger circles = more people served. Systems that buy water show their supplier's results.");
        return;
    }

    if (layerId === "waterbodies") {
        legend.style("display", null);
        legend.append("div").attr("class", "legend-title").text("Impaired waters by main problem");
        (data.waterGroups ?? []).forEach(g =>
            legendRow(legend, g, { background: waterGroupColor.get(g), "border-radius": "2px" }));

        legend.append("div").attr("class", "legend-title").style("margin-top", "0.5rem").text("Cleanup plan");
        legendRow(legend, "Bold: at least one selected problem still needs a plan",
            { background: "#555", "border-radius": "2px" });
        legendRow(legend, "Faded: plans in place for every selected problem",
            { background: "#555", opacity: WATER_FADED_OPACITY, "border-radius": "2px" });

        legend.append("div").attr("class", "legend-note")
            .text("Waters with several problems are colored by the highest one in this list. Hover a water to see all of them.");
        return;
    }

    legend.style("display", "none");
}

// ==============================================================================
// Fix polygon winding order
// ==============================================================================
// D3 expects the opposite ring winding from the GeoJSON spec; inside-out polygons fill the screen.
function rewindFeatures(fc) {
    const fixPolygon = rings => {
        if (d3.geoArea({ type: "Polygon", coordinates: rings }) > 2 * Math.PI) {
            rings.forEach(ring => ring.reverse());
        }
    };
    fc.features.forEach(f => {
        const geom = f.geometry;
        if (!geom) return;
        if (geom.type === "Polygon") fixPolygon(geom.coordinates);
        if (geom.type === "MultiPolygon") geom.coordinates.forEach(fixPolygon);
    });
    return fc;
}

// ==============================================================================
// Layer updates (called on load, on layer switch, and whenever a filter changes)
// ==============================================================================

function updateLayer(layerId) {
    if (layerId === "nitrate") updateNitrate();
    if (layerId === "pfas") updatePfas();
    if (layerId === "waterbodies") updateWaterbodies();
}

// ---- Nitrate ----

function aggregateNitrate(daily, { metric = "median", months, yearMin, yearMax }) {
    const monthSet = new Set(months);
    const rows = daily.filter(d => monthSet.has(d.month) && d.year >= yearMin && d.year <= yearMax);

    return d3.rollup(rows, samples => ({
        n_samples: samples.length,
        all_non_detect: samples.every(d => d.non_detect),
        first_date: d3.min(samples, d => d.date),
        last_date: d3.max(samples, d => d.date),
        n_over_standard: samples.filter(d => d.nitrate_mgL > NITRATE_STANDARD).length,
        value: metric === "median"  ? d3.median(samples, d => d.nitrate_mgL)
             : metric === "max"     ? d3.max(samples, d => d.nitrate_mgL)
             : metric === "pctOver" ? 100 * d3.mean(samples, d => d.nitrate_mgL > NITRATE_STANDARD)
             : d3.greatest(samples, d => d.date).nitrate_mgL   // latest
    }), d => d.site_id);
}

const formatMonthYear = d3.timeFormat("%b %Y");

function nitrateTooltip(d) {
    const s = d.stats;
    const medianText = s.all_non_detect
        ? `below detection (&lt;${s.value.toFixed(2)} mg/L)`
        : `${s.value.toFixed(2)} mg/L`;
    return `<strong>${escapeHtml(d.properties.name)}</strong><br>` +
        (d.properties.water_type ? `${escapeHtml(d.properties.water_type)}<br>` : "") +
        `Median nitrate: ${medianText}<br>` +
        `${s.n_samples} samples, ${formatMonthYear(s.first_date)}–${formatMonthYear(s.last_date)}<br>` +
        `Above ${NITRATE_STANDARD} mg/L: ${s.n_over_standard} of ${s.n_samples}`;
}

function updateNitrate() {
    const f = nitrateFilters;
    const season = SEASONS.find(s => s.id === f.season);
    const stats = aggregateNitrate(data.nitrateDaily, {
        metric: "median",
        months: season.months,
        yearMin: f.yearMin,
        yearMax: f.yearMax
    });

    const visible = data.nitrateSites.features
        .map(feat => ({ ...feat, stats: stats.get(feat.properties.site_id) }))
        .filter(feat =>
            feat.stats &&
            feat.stats.n_samples >= f.minSamples &&
            // Sites without a water_type (older export) are always shown
            (!feat.properties.water_type || f.waterTypes.has(feat.properties.water_type)) &&
            (!f.exceedOnly || feat.stats.n_over_standard > 0))
        // Draw order: thinly sampled sites underneath, then by value so the highest sit on top
        .sort((a, b) =>
            (a.stats.n_samples >= THIN_SAMPLES) - (b.stats.n_samples >= THIN_SAMPLES) ||
            a.stats.value - b.stats.value);

    const rScale = d3.scaleSqrt()
        .domain([1, Math.max(2, d3.max(visible, d => d.stats.n_samples) ?? 0)])
        .range([2, 9])
        .clamp(true);

    const isThin = d => d.stats.n_samples < THIN_SAMPLES && d.properties.site_id !== selectedSiteId;

    visible.forEach(d => d.r = rScale(d.stats.n_samples));
    const k = currentZoomK();

    layerGroups.nitrate.selectAll("circle")
        .data(visible, d => d.properties.site_id)
        .join("circle")
        .attr("cx", d => projection(d.geometry.coordinates)[0])
        .attr("cy", d => projection(d.geometry.coordinates)[1])
        .attr("r", d => d.r / k)
        .attr("fill", d => d.stats.all_non_detect ? "none" : nitrateColor(d.stats.value))
        .attr("stroke", d => d.properties.site_id === selectedSiteId ? "#111"
            : d.stats.all_non_detect ? "#b8860b" : "#444")
        .attr("stroke-width", d => d.properties.site_id === selectedSiteId ? 2.5
            : d.stats.all_non_detect ? 1.2 : 0.5)
        .attr("vector-effect", "non-scaling-stroke")
        .attr("opacity", d => isThin(d) ? THIN_OPACITY : 1)
        .style("cursor", "pointer")
        .on("click", (event, d) => {
            event.stopPropagation();          // don't trigger the reset zoom
            selectSite(d.properties.site_id);
        })
        .on("mousemove", (event, d) => showTooltipHtml(event, nitrateTooltip(d)))
        .on("mouseleave", hideTooltip)
        .order();   // keep DOM order = sort order so high values stay on top

    // The selected site always sits on top of its neighbors
    layerGroups.nitrate.selectAll("circle")
        .filter(d => d.properties.site_id === selectedSiteId)
        .raise();

    data.nitrateVisible = visible;   // used by the key-number tiles and the selection pin
    updateSelectionMarker();
    if (currentLayer === "nitrate") {
        setCount(visible.length, data.nitrateSites.features.length, "sites");
        renderKeyNumbers("nitrate");
    }
}

// ---- PFAS ----

const formatPop = d3.format(",");

function pfasSource(p) {
    if (p.purchased === true || p.purchased === "TRUE" || p.purchased === 1) return "Purchased";
    const s = String(p.primary_source_type ?? "").toLowerCase();
    if (s.includes("surface")) return "Surface water";
    if (s.includes("ground")) return "Groundwater";
    return "Other";
}

function compoundLine(c) {
    const range = c.min_ngl === c.max_ngl || c.min_ngl == null
        ? `${c.max_ngl} ng/L`
        : `up to ${c.max_ngl} ng/L`;
    const vsLimit = c.mcl_ratio != null
        ? ` (${c.mcl_ratio.toFixed(1)}× the limit)`
        : " (no federal limit)";
    const flag = c.exceeds_mcl ? " ⚠" : "";
    return `${escapeHtml(c.analyte)}: ${range}${vsLimit}${flag}`;
}

function pfasTooltip(d) {
    const p = d.properties;
    const compounds = (data.pfasCompoundsByPwsid.get(p.pwsid) ?? [])
        .slice()
        .sort((a, b) => (b.mcl_ratio ?? -1) - (a.mcl_ratio ?? -1));

    let html = `<strong>${escapeHtml(p.name)}</strong><br>`;
    html += `${escapeHtml(p.loc_city ?? p.county ?? "")}` +
        (p.pop_serv ? ` · serves ${formatPop(p.pop_serv)}` : "") + "<br>";
    if (d.source === "Purchased" && p.purchases_from) {
        html += `<em>Buys water from ${escapeHtml(p.purchases_from)}</em><br>`;
    } else {
        html += `${escapeHtml(d.source)}<br>`;
    }
    html += `<strong>${escapeHtml(p.pfas_category)}</strong>`;
    if (compounds.length) html += "<br>" + compounds.map(compoundLine).join("<br>");
    return html;
}

function updatePfas() {
    const f = pfasFilters;

    const visible = data.pfasFeatures.filter(d =>
        f.categories.has(d.properties.pfas_category) &&
        f.sources.has(d.source) &&
        (f.compound === "any" || d.compounds.has(f.compound)));

    const k = currentZoomK();

    layerGroups.pfas.selectAll("circle")
        .data(visible, d => d.properties.pwsid)
        .join("circle")
        .attr("cx", d => projection(d.geometry.coordinates)[0])
        .attr("cy", d => projection(d.geometry.coordinates)[1])
        .attr("r", d => d.r / k)
        .attr("fill", d => d.properties.pfas_category === PFAS_NOT_DETECTED
            ? "none" : pfasColor(d.properties.pfas_category))
        .attr("fill-opacity", 0.9)
        .attr("stroke", d => d.properties.pwsid === selectedPwsid ? "#111"
            : d.properties.pfas_category === PFAS_NOT_DETECTED ? "#888" : "#fff")
        .attr("stroke-width", d => d.properties.pwsid === selectedPwsid ? 2
            : d.properties.pfas_category === PFAS_NOT_DETECTED ? 1 : 0.6)
        .attr("vector-effect", "non-scaling-stroke")
        .style("cursor", "pointer")
        .on("click", (event, d) => {
            event.stopPropagation();          // don't trigger the reset zoom
            selectPfasSystem(d.properties.pwsid);
        })
        .on("mousemove", (event, d) => showTooltipHtml(event, pfasTooltip(d)))
        .on("mouseleave", hideTooltip)
        .order();

    // The selected system always sits on top of its neighbors
    layerGroups.pfas.selectAll("circle")
        .filter(d => d.properties.pwsid === selectedPwsid)
        .raise();

    data.pfasVisible = visible;   // used by the key-number tiles, Chart 2, and the selection pin
    updateSelectionMarker();
    if (currentLayer === "pfas") {
        setCount(visible.length, data.pfasFeatures.length, "water systems");
        renderKeyNumbers("pfas");
        if (activeChartTab === 1) renderChart2();   // Chart 2 follows the filters
    }
}

function selectPfasSystem(pwsid) {
    selectedPwsid = pwsid;
    updatePfas();             // restyle the map so the selected system is highlighted
    if (activeChartTab !== 0) setChartTab(0);   // clicking a system always shows its results
    else renderChart1();
}

// ---- Impaired waterbodies ----

const waterHaloG = layerGroups.waterbodies.append("g").attr("class", "water-halos");
const waterMainG = layerGroups.waterbodies.append("g").attr("class", "water-shapes");
// Invisible wide outline over every water so thin streams and tiny lakes are easy to hover/click
const waterHitG = layerGroups.waterbodies.append("g").attr("class", "water-hit");
const WATER_HIT_WIDTH = 14;   // on-screen px
const waterPath = d3.geoPath(projection).pointRadius(2.5);   // beaches are points

const isTrue = v => v === true || v === "TRUE" || v === "true" || v === 1;

// Runs once after loading: splits the category list and pre-computes each shape's SVG path
// (path strings are the slow part, so filters only restyle, never recompute shapes)
function prepareWaterbodies(waters) {
    rewindFeatures(waters);

    data.waterFeatures = waters.features
        .filter(f => f.geometry)
        .map(f => {
            const p = f.properties;
            const geomType = f.geometry.type;

            // One entry per impairment: its code, category, and whether it still needs a plan.
            // impairments and impairment_groups are parallel lists built in R.
            const splitList = s => String(s ?? "").split(";").map(x => x.trim()).filter(Boolean);
            const codes = splitList(p.impairments);
            const codeGroups = splitList(p.impairment_groups);
            const needsCodes = new Set(String(p.needs_pln ?? "").split(/[;,]/).map(x => x.trim()));
            const imps = codes.map((code, i) => ({
                code,
                group: codeGroups[i] ?? "Other",
                needs: needsCodes.has(code)
            }));

            return {
                ...f,
                imps,
                groups: new Set(String(p.all_groups ?? p.primary_group ?? "")
                    .split(";").map(s => s.trim()).filter(Boolean)),
                anyNeedsPlan: isTrue(p.any_needs_plan),   // any impairment at all, ignoring filters
                needsPlan: isTrue(p.any_needs_plan),      // reset by updateWaterbodies() to the problems switched on
                kind: geomType.includes("Polygon") ? "area" : geomType.includes("Point") ? "point" : "line",
                pathD: waterPath(f)
            };
        });

    // Fish-tissue impairment codes in the data (MPCA codes ending in "-F")
    const FISH_NAMES = { Hg: "mercury", PFOS: "PFAS", PCB: "PCBs" };
    const fish = new Map();
    data.waterFeatures.forEach(d => d.imps.forEach(imp => {
        if (/-F$/.test(imp.code) && !fish.has(imp.code)) {
            const base = imp.code.replace(/-F$/, "");
            fish.set(imp.code, { code: imp.code, group: imp.group, name: FISH_NAMES[base] ?? base });
        }
    }));
    const FISH_ORDER = ["Hg-F", "PFOS-F", "PCB-F"];
    const fishRank = c => (FISH_ORDER.indexOf(c.code) + 1) || 99;
    data.waterFishContaminants = [...fish.values()].sort((a, b) => fishRank(a) - fishRank(b));

    // Categories and water types actually present, in priority / alphabetical order
    const present = new Set(data.waterFeatures.flatMap(d => [...d.groups]));
    data.waterGroups = WATER_GROUPS.map(g => g.id).filter(g => present.has(g));
    data.waterTypes = Array.from(new Set(data.waterFeatures.map(d => d.properties.water_type).filter(Boolean))).sort();
}

// Color = highest-priority category this water has among the categories switched on
function waterDisplayGroup(d, groupsOn) {
    let best = null;
    d.groups.forEach(g => {
        if (groupsOn.has(g) && (best === null || (waterGroupRank.get(g) ?? 99) < (waterGroupRank.get(best) ?? 99))) best = g;
    });
    return best;
}

function waterTooltip(d) {
    const p = d.properties;
    const where = [p.water_type, isTrue(p.tribal) && p.indian_reservation ? p.indian_reservation : null]
        .filter(Boolean).join(" · ");
    const planText = d.anyNeedsPlan
        ? `<strong>Still needs a cleanup plan:</strong> ${escapeHtml(String(p.needs_pln ?? "").replace(/;\s*/g, ", "))}`
        : "Cleanup plans in place for every problem";
    return `<strong>${escapeHtml(p.name ?? "Unnamed water")}</strong><br>` +
        (where ? `${escapeHtml(where)}<br>` : "") +
        `Problems: ${escapeHtml([...d.groups].join(", "))}<br>` +
        `Impairments: ${escapeHtml(String(p.impairments ?? "").replace(/;\s*/g, ", "))}<br>` +
        planText;
}

// Does this water still need a cleanup plan for any of the problems switched on in the filters?
// (With only Mercury on, a lake whose mercury is covered but whose nutrients aren't counts as "planned".)
// Falls back to MPCA's any-impairment flag if the codes in needs_pln don't line up with the impairment list.
function waterNeedsPlan(d, groups) {
    if (!d.imps.length || (d.anyNeedsPlan && !d.imps.some(imp => imp.needs))) return d.anyNeedsPlan;
    return d.imps.some(imp => imp.needs && groups.has(imp.group));
}

function updateWaterbodies() {
    const f = waterFilters;

    const visible = data.waterFeatures
        .map(d => ({ d, group: waterDisplayGroup(d, f.groups), needs: waterNeedsPlan(d, f.groups) }))
        .filter(({ d, group, needs }) =>
            group !== null &&
            f.plan.has(needs ? "needs" : "planned") &&
            f.types.has(d.properties.water_type))
        .map(({ d, group, needs }) => Object.assign(d, { displayGroup: group, needsPlan: needs }))
        // Draw order: faded first, then bold; within each, lower-priority categories underneath
        .sort((a, b) =>
            (a.needsPlan - b.needsPlan) ||
            (waterGroupRank.get(b.displayGroup) - waterGroupRank.get(a.displayGroup)));

    const color = d => waterGroupColor.get(d.displayGroup) ?? "#999";
    const opacity = d => d.needsPlan ? 1 : WATER_FADED_OPACITY;

    // Soft halo underneath (only bold waters, so faded ones stay quiet)
    waterHaloG.selectAll("path")
        .data(visible.filter(d => d.needsPlan && d.kind !== "point"), d => d.properties.auid)
        .join("path")
        .attr("d", d => d.pathD)
        .attr("fill", "none")
        .attr("stroke", color)
        .attr("stroke-opacity", 0.18)
        .attr("stroke-width", WATER_HALO_WIDTH)
        .attr("stroke-linejoin", "round")
        .attr("stroke-linecap", "round")
        .attr("vector-effect", "non-scaling-stroke")
        .style("pointer-events", "none")
        .order();

    // The waters themselves
    waterMainG.selectAll("path")
        .data(visible, d => d.properties.auid)
        .join("path")
        .attr("d", d => d.pathD)
        .attr("fill", d => d.kind === "line" ? "none" : color(d))
        .attr("fill-opacity", d => d.kind === "line" ? null : 0.85)
        .attr("stroke", color)
        .attr("stroke-width", d => d.kind === "line" ? (d.needsPlan ? 1.6 : 1) : 0.6)
        .attr("stroke-linejoin", "round")
        .attr("stroke-linecap", "round")
        .attr("vector-effect", "non-scaling-stroke")
        .attr("opacity", opacity)
        .style("cursor", "pointer")
        .on("click", event => event.stopPropagation())     // don't trigger the reset zoom
        .on("mousemove", (event, d) => showTooltipHtml(event, waterTooltip(d)))
        .on("mouseleave", hideTooltip)
        .order();

    // Hit area: same shapes with a wide transparent stroke (only the stroke catches the mouse;
    // lake interiors are still caught by the filled shapes underneath)
    waterHitG.selectAll("path")
        .data(visible, d => d.properties.auid)
        .join("path")
        .attr("d", d => d.pathD)
        .attr("fill", "none")
        .attr("stroke", "transparent")
        .attr("stroke-width", WATER_HIT_WIDTH)
        .attr("stroke-linejoin", "round")
        .attr("stroke-linecap", "round")
        .attr("vector-effect", "non-scaling-stroke")
        .style("pointer-events", "stroke")
        .style("cursor", "pointer")
        .on("click", event => event.stopPropagation())
        .on("mousemove", (event, d) => showTooltipHtml(event, waterTooltip(d)))
        .on("mouseleave", hideTooltip)
        .order();

    data.waterVisible = visible;   // used by Chart 1
    if (currentLayer === "waterbodies") {
        setCount(visible.length, data.waterFeatures.length, "impaired waters");
        renderKeyNumbers("waterbodies");
        if (activeChartTab === 0) renderChart1();   // both charts follow the filters
        else renderChart2();
    }
}

// ==============================================================================
// Key-number tiles
// ==============================================================================

const KEY_MIN_SAMPLES = 3;            // a site needs this many samples to have a meaningful median
const SPRING_MONTHS = new Set([4, 5, 6]);
const SPRING_MIN_EACH = 2;            // samples needed in spring AND in the rest of the year
const SPRING_MIN_BASELINE = 0.5;      // mg/L; skip sites too low for a meaningful % change

const statTiles = [d3.select("#panel-stat-1"), d3.select("#panel-stat-2")];

function setStatTile(tile, { value, label, note }) {
    tile.html("");
    tile.append("div").attr("class", "stat-value").text(value);
    tile.append("div").attr("class", "stat-label").text(label);
    if (note) tile.append("div").attr("class", "stat-note").text(note);
}

function formatPct(p) {
    if (p == null || !isFinite(p)) return "—";
    return `${p > 0 && p < 1 ? p.toFixed(1) : Math.round(p)}%`;
}

function formatChange(p) {
    if (p == null || !isFinite(p)) return "—";
    const rounded = Math.round(p);
    return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded)}%`;
}

// Tile 1: share of shown sites (3+ samples) that exceeded the standard at least once.
// Follows every filter, so it rises when a reader picks Spring or Groundwater.
function pctSitesOverStandard(visibleSites) {
    const eligible = visibleSites.filter(d => d.stats.n_samples >= KEY_MIN_SAMPLES);
    const over = eligible.filter(d => d.stats.n_over_standard > 0).length;
    return {
        pct: eligible.length ? 100 * over / eligible.length : null,
        nEligible: eligible.length
    };
}

// Tile 2: typical spring increase, comparing each site with itself.
// Follows the year and water-type filters but ignores the season filter
// (it is itself a season comparison).
function springIncrease() {
    const f = nitrateFilters;
    const ratios = [];

    data.nitrateSites.features.forEach(feat => {
        const p = feat.properties;
        if (p.water_type && !f.waterTypes.has(p.water_type)) return;

        const readings = data.nitrateBySite.get(p.site_id);
        if (!readings) return;

        const spring = [];
        const rest = [];
        readings.forEach(r => {
            if (r.year < f.yearMin || r.year > f.yearMax) return;
            (SPRING_MONTHS.has(r.month) ? spring : rest).push(r.nitrate_mgL);
        });
        if (spring.length < SPRING_MIN_EACH || rest.length < SPRING_MIN_EACH) return;

        const restMedian = d3.median(rest);
        if (restMedian < SPRING_MIN_BASELINE) return;
        ratios.push(d3.median(spring) / restMedian);
    });

    return {
        pct: ratios.length ? 100 * (d3.median(ratios) - 1) : null,
        nSites: ratios.length
    };
}

function renderKeyNumbers(layerId) {
    if (layerId === "nitrate" && data.nitrateVisible) {
        const t1 = pctSitesOverStandard(data.nitrateVisible);
        setStatTile(statTiles[0], {
            value: formatPct(t1.pct),
            label: `of monitored sites exceeded ${NITRATE_STANDARD} mg/L at least once`,
            note: t1.nEligible
                ? `${t1.nEligible.toLocaleString()} sites with ${KEY_MIN_SAMPLES}+ samples in this selection`
                : "Not enough data for this selection"
        });

        const t2 = springIncrease();
        setStatTile(statTiles[1], {
            value: formatChange(t2.pct),
            label: "typical spring nitrate (Apr–Jun) vs. the rest of the year, same site",
            note: t2.nSites
                ? `${t2.nSites.toLocaleString()} sites compared · ignores the season filter`
                : "Not enough data for this selection"
        });
        return;
    }

    if (layerId === "pfas" && data.pfasVisible) {
        // Both tiles follow the PFAS filters, like the map and Chart 2
        const detected = data.pfasVisible.filter(d => d.properties.pfas_category !== PFAS_NOT_DETECTED);
        const above = data.pfasVisible.filter(d => PFAS_ABOVE_LIMIT.has(d.properties.pfas_category));
        const popOf = list => d3.sum(list, d => +d.properties.pop_serv || 0);

        setStatTile(statTiles[0], {
            value: formatPeople(popOf(detected)),
            label: "people served by water systems where PFAS was detected",
            note: `${detected.length.toLocaleString()} water systems in this selection`
        });
        setStatTile(statTiles[1], {
            value: formatPeople(popOf(above)),
            label: "people served by water systems above an EPA limit",
            note: `${above.length.toLocaleString()} water systems in this selection`
        });
        return;
    }

    if (layerId === "waterbodies" && data.waterVisible) {
        // Both tiles follow the filters, and narrow to a county/watershed when one is
        // drilled into in the "Top places" chart (the note always says which)
        const place = selectedPlace && selectedPlace.boundary === currentBoundary ? selectedPlace : null;
        const waters = place
            ? data.waterVisible.filter(d => String(placeIdOf(d, place.boundary)) === String(place.id))
            : data.waterVisible;
        const where = place
            ? BOUNDARIES[place.boundary].where(place.label)
            : "shown";

        const needsPlan = waters.filter(d => d.needsPlan).length;
        // With some problem categories switched off, say the count only covers the ones still on
        const allProblemsOn = (data.waterGroups ?? []).every(g => waterFilters.groups.has(g));
        setStatTile(statTiles[0], {
            value: needsPlan.toLocaleString(),
            label: allProblemsOn
                ? "impaired waters still need a cleanup plan"
                : "impaired waters still need a cleanup plan for the selected problems",
            note: `of ${waters.length.toLocaleString()} impaired waters ${where}`
        });

        // Fish-tissue impairments (codes ending in "-F": mercury, PFOS, PCBs), among the problems switched on
        const fishOn = data.waterFishContaminants.filter(c => waterFilters.groups.has(c.group));
        const fishCodes = new Set(fishOn.map(c => c.code));
        const fishWaters = waters.filter(d => d.imps.some(imp => fishCodes.has(imp.code))).length;
        const fishNames = [...new Set(fishOn.map(c => c.name))];
        setStatTile(statTiles[1], {
            value: fishWaters.toLocaleString(),
            label: "lakes and streams where fish contain unsafe levels of contaminants",
            note: fishNames.length
                ? `${capitalize(fishNames.join(", ").replace(/, ([^,]*)$/, " or $1"))} in fish · ${where === "shown" ? "in this selection" : where}`
                : "Turn on Mercury, PFAS or Other toxic chemicals to count these"
        });
        return;
    }

    // Other layers: placeholders until their numbers are chosen
    statTiles.forEach((tile, i) => setStatTile(tile, { value: "—", label: `Key number ${i + 1}` }));
}

const capitalize = t => t.charAt(0).toUpperCase() + t.slice(1);

// 1,234,567 -> "1.2 million"; smaller numbers keep commas
function formatPeople(n) {
    if (!n) return "0";
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} million`;
    return Math.round(n).toLocaleString();
}

// ==============================================================================
// Chart 1: every nitrate reading over time at the selected site
// ==============================================================================

const chart1 = d3.select("#panel-chart-1");
const chart2 = d3.select("#panel-chart-2");
const formatDay = d3.timeFormat("%b %-d, %Y");
const GAP_DAYS = 60;   // don't draw a line across gaps longer than this (e.g. no winter sampling)

// ---- Chart tabs: two charts share one panel ----

// Tab labels per layer (PFAS and waterbodies are placeholders for now)
const CHART_TAB_LABELS = {
    nitrate: ["Selected site", "Long-term trend"],
    pfas: ["Selected system", "Systems by result"],
    waterbodies: ["Impaired waters by problem", "Top 10 problem boundaries"]
};

const chartTabs = Array.from(document.querySelectorAll(".chart-tab"));
let activeChartTab = 0;

function setChartTab(index) {
    activeChartTab = index;
    chartTabs.forEach((tab, i) => {
        const selected = i === index;
        tab.classList.toggle("is-active", selected);
        tab.setAttribute("aria-selected", selected);
        tab.tabIndex = selected ? 0 : -1;
        document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
    });
    hideTooltip();
    if (index === 0) renderChart1();   // redraw at the panel's current size
    else renderChart2();
}

function updateChartTabLabels(layerId) {
    const labels = CHART_TAB_LABELS[layerId] ?? CHART_TAB_LABELS.waterbodies;
    chartTabs.forEach((tab, i) => { tab.textContent = labels[i]; });
}

chartTabs.forEach((tab, i) => {
    tab.addEventListener("click", () => setChartTab(i));
    // Arrow keys move between tabs
    tab.addEventListener("keydown", e => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const next = (i + (e.key === "ArrowRight" ? 1 : chartTabs.length - 1)) % chartTabs.length;
        chartTabs[next].focus();
        setChartTab(next);
    });
});

function selectSite(siteId) {
    selectedSiteId = siteId;
    updateNitrate();          // restyle the map so the selected site is highlighted
    if (activeChartTab !== 0) setChartTab(0);   // clicking a site always shows its readings
    else renderChart1();
}

function chartPlaceholder(container, text) {
    container.html("");
    container.append("p").attr("class", "panel-placeholder").text(text);
}

// Chart 2: PFAS = systems by result. Nitrate long-term trend is intentionally empty until its data is ready.
function renderChart2() {
    if (chart2.property("hidden")) return;   // not visible; drawn when its tab is opened
    if (currentLayer === "waterbodies") {
        renderWaterPlacesChart();   // reuses its bars between redraws so they can animate
        return;
    }
    chart2.html("");
    if (currentLayer === "pfas") renderPfasCategoryChart();
    else if (currentLayer === "nitrate") renderNitrateTrendChart();
}

// Shared sizing for a chart body: measures the space the panel gives it
function chartSize(body, margin) {
    const { width: w, height: h } = body.node().getBoundingClientRect();
    const width = Math.max(w, 200);
    const height = Math.max(h, 120);
    return {
        width, height,
        innerW: width - margin.left - margin.right,
        innerH: height - margin.top - margin.bottom
    };
}

// ---- PFAS Chart 1: detected level of each chemical at the selected system ----

function renderPfasSystemChart() {
    if (!data.pfasById) return;   // data not loaded yet

    const feat = data.pfasById.get(selectedPwsid);
    const p = feat?.properties ?? {};
    const results = data.pfasCompoundsByPwsid.get(selectedPwsid) ?? [];
    const byAnalyte = new Map(results.map(r => [String(r.analyte).toUpperCase(), r]));

    // One bar per chemical in the data; chemicals not detected here get a zero bar
    const rows = data.pfasAnalytes.map(analyte => {
        const r = byAnalyte.get(String(analyte).toUpperCase());
        return {
            analyte,
            detected: !!r,
            value: r ? +r.max_ngl || 0 : 0,
            min: r && r.min_ngl != null ? +r.min_ngl : null,
            limit: (r && r.mcl_ngl != null ? +r.mcl_ngl : null) ?? pfasLimit(analyte),
            exceeds: !!(r && (r.exceeds_mcl === true || r.exceeds_mcl === "TRUE"))
        };
    });

    chart1.html("");

    // ---- Header ----
    chart1.append("h2").attr("class", "panel-title").text(p.name ?? "PFAS results");

    const sourceText = feat?.source === "Purchased" && p.purchases_from
        ? `Buys water from ${p.purchases_from}`
        : feat?.source;
    chart1.append("p").attr("class", "chart-subtitle")
        .text([p.loc_city ?? p.county, p.pop_serv ? `serves ${formatPop(p.pop_serv)}` : null, sourceText, p.pfas_category]
            .filter(Boolean).join(" · "));

    const body = chart1.append("div").attr("class", "chart-body");

    const key = chart1.append("p").attr("class", "chart-hint");
    key.html(
        '<svg width="18" height="8" aria-hidden="true" style="vertical-align:middle">' +
        '<line x1="0" x2="18" y1="4" y2="4" stroke="#99000d" stroke-width="1.5" stroke-dasharray="4 3"/></svg> ' +
        "EPA limit for each chemical · Click any water system on the map to see its results."
    );

    if (!feat) {
        body.append("p").attr("class", "panel-placeholder").text("Click a water system on the map.");
        return;
    }

    // ---- Scales ----
    const margin = { top: 16, right: 10, bottom: 24, left: 52 };
    const { width, height, innerW, innerH } = chartSize(body, margin);

    const x = d3.scaleBand()
        .domain(rows.map(d => d.analyte))
        .range([0, innerW])
        .padding(0.35);

    const yMax = d3.max(rows, d => Math.max(d.value, d.limit ?? 0)) || 1;
    const y = d3.scaleLinear().domain([0, yMax * 1.15]).nice().range([innerH, 0]);

    const svgC = body.append("svg")
        .attr("viewBox", [0, 0, width, height])
        .attr("width", width)
        .attr("height", height);
    const gC = svgC.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Gridlines + axes (unit on the top tick only, like the nitrate chart)
    gC.append("g")
        .attr("class", "chart-grid")
        .call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(""))
        .call(s => s.select(".domain").remove());

    const yTicks = y.ticks(4);
    const topTick = yTicks[yTicks.length - 1];
    gC.append("g")
        .attr("class", "chart-axis")
        .call(d3.axisLeft(y).ticks(4).tickFormat(d => d === topTick ? `${d} ng/L` : d))
        .call(s => s.select(".domain").remove());

    gC.append("g")
        .attr("class", "chart-axis")
        .attr("transform", `translate(0,${innerH})`)
        .call(d3.axisBottom(x).tickSizeOuter(0).tickSize(0))
        .call(s => s.selectAll("text").attr("dy", "1em"));

    // ---- Bars: darker when the chemical is over its limit ----
    const barTooltip = d => {
        if (!d.detected) return `<strong>${escapeHtml(d.analyte)}</strong><br>Not detected`;
        const range = d.min != null && d.min !== d.value ? `${d.min}–${d.value} ng/L` : `${d.value} ng/L`;
        const vsLimit = d.limit ? `<br>EPA limit: ${d.limit} ng/L (${(d.value / d.limit).toFixed(1)}× the limit)` : "<br>No federal limit";
        return `<strong>${escapeHtml(d.analyte)}</strong><br>Detected: ${range}${vsLimit}`;
    };

    gC.append("g")
        .selectAll("rect")
        .data(rows)
        .join("rect")
        .attr("x", d => x(d.analyte))
        .attr("width", x.bandwidth())
        .attr("y", d => y(d.value))
        .attr("height", d => innerH - y(d.value))
        .attr("fill", d => d.exceeds ? pfasColors[2] : pfasColors[1])
        .on("mousemove", (event, d) => showTooltipHtml(event, barTooltip(d)))
        .on("mouseleave", hideTooltip);

    // Value labels (or "Not detected")
    gC.append("g")
        .selectAll("text")
        .data(rows)
        .join("text")
        .attr("class", "chart-axis-label")
        .attr("x", d => x(d.analyte) + x.bandwidth() / 2)
        .attr("y", d => d.detected ? y(d.value) - 4 : innerH - 4)
        .attr("text-anchor", "middle")
        .text(d => d.detected ? d.value : "Not detected");

    // ---- Each chemical's own EPA limit, drawn across its bar ----
    gC.append("g")
        .selectAll("line")
        .data(rows.filter(d => d.limit))
        .join("line")
        .attr("class", "chart-standard")
        .attr("stroke-width", 1.5)
        .attr("x1", d => x(d.analyte) - x.step() * x.paddingInner() / 2)
        .attr("x2", d => x(d.analyte) + x.bandwidth() + x.step() * x.paddingInner() / 2)
        .attr("y1", d => y(d.limit))
        .attr("y2", d => y(d.limit));
}

// ---- PFAS Chart 2: number of systems in each legend category (follows the filters) ----

function renderPfasCategoryChart() {
    const visible = data.pfasVisible ?? [];
    const counts = ALL_PFAS_CATEGORIES.map(category => ({
        category,
        n: visible.filter(d => d.properties.pfas_category === category).length
    }));

    chart2.append("h2").attr("class", "panel-title").text("Water systems by result");
    chart2.append("p").attr("class", "chart-subtitle")
        .text(`${visible.length.toLocaleString()} water systems · follows your filters`);

    const body = chart2.append("div").attr("class", "chart-body");

    const margin = { top: 6, right: 40, bottom: 6, left: 0 };
    const { width, height, innerH } = chartSize(body, margin);
    margin.left = Math.min(185, width * 0.48);           // room for the category labels
    const innerW = width - margin.left - margin.right;

    const y = d3.scaleBand()
        .domain(counts.map(d => d.category))
        .range([0, innerH])
        .padding(0.3);
    const x = d3.scaleLinear()
        .domain([0, d3.max(counts, d => d.n) || 1])
        .range([0, innerW]);

    const svgC = body.append("svg")
        .attr("viewBox", [0, 0, width, height])
        .attr("width", width)
        .attr("height", height);
    const gC = svgC.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Category labels
    gC.append("g")
        .selectAll("text")
        .data(counts)
        .join("text")
        .attr("class", "chart-axis-label")
        .attr("x", -8)
        .attr("y", d => y(d.category) + y.bandwidth() / 2)
        .attr("dy", "0.35em")
        .attr("text-anchor", "end")
        .style("fill", "#444")
        .text(d => d.category);

    // Bars in the legend colors ("Not detected" is hollow, like on the map)
    gC.append("g")
        .selectAll("rect")
        .data(counts)
        .join("rect")
        .attr("x", 0)
        .attr("y", d => y(d.category))
        .attr("height", y.bandwidth())
        .attr("width", d => Math.max(x(d.n), d.n ? 1 : 0))
        .attr("fill", d => d.category === PFAS_NOT_DETECTED ? "#fff" : pfasColor(d.category))
        .attr("stroke", d => d.category === PFAS_NOT_DETECTED ? "#888" : "none");

    // Counts at the end of each bar
    gC.append("g")
        .selectAll("text")
        .data(counts)
        .join("text")
        .attr("class", "chart-axis-label")
        .attr("x", d => x(d.n) + 5)
        .attr("y", d => y(d.category) + y.bandwidth() / 2)
        .attr("dy", "0.35em")
        .style("fill", "#444")
        .text(d => d.n.toLocaleString());
}

// ---- Waterbodies Chart 1: waters per problem category, click a bar to see its impairments ----

// Plain-English names for MPCA impairment codes (unknown codes show as-is)
const IMPAIRMENT_LABELS = {
    "Hg-F": "Mercury in fish tissue",
    "Hg-W": "Mercury in water",
    "PFOS-F": "PFOS in fish tissue",
    "PFOS-W": "PFOS in water",
    "PCB-F": "PCBs in fish tissue",
    "PCB-W": "PCBs in water",
    "Dioxin": "Dioxin",
    "DDT": "DDT",
    "Dieldrin": "Dieldrin",
    "Toxaphene": "Toxaphene",
    "Ace": "Acetochlor (herbicide)",
    "Acetochlor": "Acetochlor (herbicide)",
    "Clpyr": "Chlorpyrifos (insecticide)",
    "Chlorpyrif": "Chlorpyrifos (insecticide)",
    "E.coli": "E. coli",
    "FC": "Fecal coliform",
    "Nutrients": "Nutrients (phosphorus)",
    "DO": "Low dissolved oxygen",
    "Nitrates": "Nitrate",
    "Nitrate": "Nitrate",
    "Amm-U": "Ammonia",
    "TSS": "Suspended sediment",
    "T": "Turbidity",
    "Cl-": "Chloride (salt)",
    "SO4": "Sulfate",
    "Al": "Aluminum",
    "As": "Arsenic",
    "Cu": "Copper",
    "FishesBio": "Unhealthy fish community",
    "InvertBio": "Unhealthy aquatic insect community",
    "ColdWater": "Coldwater habitat",
    "Temp": "Temperature",
    "pH": "pH"
};
const impairmentLabel = code => IMPAIRMENT_LABELS[code] ?? code;

let waterChartGroup = null;   // null = all problems; otherwise the category being drilled into

// Animation timing. People who turn on "reduce motion" in their OS get instant switches.
const REDUCE_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const WATER_T = REDUCE_MOTION ? 0 : 320;   // ms per animation step

// Bar data for the chart: one row per category (overview) or per impairment code (drill-down).
// Counts are waters, not impairments. A row's "needs" = waters where at least one matching
// impairment still needs a plan.
function waterChartRows(waters, drilled) {
    const f = waterFilters;
    const tally = new Map();
    waters.forEach(d => {
        const status = new Map();   // id -> needs a plan?
        d.imps.forEach(imp => {
            if (!f.groups.has(imp.group)) return;
            if (drilled && imp.group !== drilled) return;
            const id = drilled ? imp.code : imp.group;
            status.set(id, (status.get(id) ?? false) || imp.needs);
        });
        status.forEach((needs, id) => {
            const t = tally.get(id) ?? { id, needs: 0, planned: 0 };
            if (needs) t.needs++; else t.planned++;
            tally.set(id, t);
        });
    });

    const finish = t => {
        // Respect the cleanup-plan filter at the bar level too
        const needs = f.plan.has("needs") ? t.needs : 0;
        const planned = f.plan.has("planned") ? t.planned : 0;
        return {
            id: t.id,
            key: (drilled ? "code:" : "group:") + t.id,   // keys never collide between the two views
            label: drilled ? impairmentLabel(t.id) : t.id,
            color: waterGroupColor.get(drilled ?? t.id) ?? "#999",
            needs, planned, total: needs + planned
        };
    };

    return drilled
        ? [...tally.values()].map(finish).filter(r => r.total > 0).sort((a, b) => b.total - a.total)
        : data.waterGroups.filter(g => f.groups.has(g)).map(g => finish(tally.get(g) ?? { id: g, needs: 0, planned: 0 }));
}

// Builds the chart's fixed parts once; later renders reuse them so bars can animate
function waterChartSkeleton(container) {
    container.html("");
    container.append("h2").attr("class", "panel-title water-title");
    container.append("p").attr("class", "chart-subtitle water-subtitle");
    const body = container.append("div").attr("class", "chart-body");
    body.append("p").attr("class", "panel-placeholder water-empty").text("No waters match your filters.");
    const svgC = body.append("svg").attr("class", "water-svg");
    svgC.append("g").attr("class", "water-rows");
    container.append("p").attr("class", "chart-hint water-hint");
}

// Problem-category bar chart with a drill-down into impairments. Used by Chart 1 (all waters)
// and by Chart 2 (the waters in one county or watershed).
//   opts.waters     waters to count
//   opts.drilled    category being drilled into, or null
//   opts.title / opts.subtitle / opts.backLinks [{label, onClick}]
//   opts.onDrill(category)   called when a category bar is clicked
//   opts.growIn     animate the bars in when the chart is first built
function renderProblemChart(container, opts) {
    const drilled = opts.drilled;

    // Which kind of change is this? Decides the animation.
    const fresh = container.select(".water-svg").empty();
    if (fresh) waterChartSkeleton(container);
    const prev = container.node().__waterDrilled;
    container.node().__waterDrilled = drilled;
    const mode = WATER_T === 0 ? "instant"
        : fresh ? (opts.growIn ? "grow" : "instant")
        : prev === drilled ? "update"
        : drilled ? "in" : "out";

    const rows = waterChartRows(opts.waters, drilled);

    // ---- Header + hint (these just switch, no animation) ----
    container.select(".water-title").text(opts.title);

    const sub = container.select(".water-subtitle").html("");
    (opts.backLinks ?? []).forEach(link => {
        sub.append("a")
            .attr("href", "#")
            .attr("class", "chart-back")
            .style("color", PIN_COLOR)
            .style("font-weight", 600)
            .style("text-decoration", "none")
            .text(link.label)
            .on("click", event => {
                event.preventDefault();
                hideTooltip();
                link.onClick();
            });
        sub.append("span").text(" · ");
    });
    sub.append("span").text(opts.subtitle);

    const swatchColor = drilled ? waterGroupColor.get(drilled) : "#555";
    const swatch = op => `<svg width="11" height="11" aria-hidden="true" style="vertical-align:-1px">` +
        `<rect width="11" height="11" rx="2" fill="${swatchColor}" fill-opacity="${op}"/></svg>`;
    container.select(".water-hint").html(
        `${swatch(1)} Still needs a cleanup plan &nbsp; ${swatch(WATER_FADED_OPACITY)} Plan in place` +
        (drilled ? "" : "<br>Click a bar to see the specific impairments.")
    );

    const isEmpty = !rows.length || !d3.sum(rows, d => d.total);
    container.select(".water-empty").style("display", isEmpty ? null : "none");

    // ---- Scales (measured after the hint text is set, since it changes the space left) ----
    const body = container.select(".chart-body");
    const svgC = container.select(".water-svg");
    const margin = { top: 6, right: 44, bottom: 6, left: 0 };
    const { width, height, innerH } = chartSize(body, margin);
    margin.left = Math.min(drilled ? 200 : 165, width * 0.5);   // room for the labels
    const innerW = width - margin.left - margin.right;

    // Cap the row height so a drill-down with only 2 bars doesn't draw giant blocks
    const step = Math.min(innerH / Math.max(rows.length, 1), 38);
    const y = d3.scaleBand()
        .domain(rows.map(d => d.key))
        .range([0, step * rows.length])
        .paddingInner(0.3)
        .paddingOuter(0.15);
    const x = d3.scaleLinear()
        .domain([0, d3.max(rows, d => d.total) || 1])
        .range([0, innerW]);
    const bw = y.bandwidth();
    const topY = rows.length ? y(rows[0].key) : 0;

    svgC.attr("viewBox", [0, 0, width, height]).attr("width", width).attr("height", height);
    const gRows = svgC.select(".water-rows");
    const moveG = gRows.transition("move").duration(mode === "instant" ? 0 : WATER_T);
    moveG.attr("transform", `translate(${margin.left},${margin.top})`);

    // Puts a row (selection or transition) in its final place. Children get the row's data via .select().
    const placeRow = s => {
        s.attr("transform", d => `translate(0,${y(d.key)})`).style("opacity", 1);
        s.select(".water-hit")
            .attr("x", -margin.left)
            .attr("y", -y.step() * y.paddingInner() / 2)
            .attr("width", margin.left + innerW + margin.right)
            .attr("height", y.step());
        s.select(".water-label").attr("y", bw / 2).text(d => d.label);
        s.select(".water-needs").attr("x", 0).attr("height", bw).attr("width", d => x(d.needs)).attr("fill", d => d.color);
        s.select(".water-planned").attr("x", d => x(d.needs)).attr("height", bw).attr("width", d => x(d.planned)).attr("fill", d => d.color);
        s.select(".water-count").attr("x", d => x(d.total) + 5).attr("y", bw / 2).style("opacity", 1)
            .text(d => d.total.toLocaleString());
    };

    const tip = d => {
        const name = drilled && d.label !== d.id ? `${d.label} (${d.id})` : d.label;
        return `<strong>${escapeHtml(name)}</strong><br>` +
            `${d.total.toLocaleString()} waters<br>` +
            `Still needs a cleanup plan: ${d.needs.toLocaleString()}<br>` +
            `Plan in place: ${d.planned.toLocaleString()}` +
            (drilled ? "" : "<br><em>Click to see the specific impairments</em>");
    };

    // ---- Keyed join: rows that stay move, new rows come in, old rows go out ----
    const joined = gRows.selectAll("g.water-row").data(rows, d => d.key);

    const enter = joined.enter().append("g").attr("class", "water-row");
    enter.append("rect").attr("class", "water-hit").attr("fill", "transparent");
    enter.append("text").attr("class", "chart-axis-label water-label")
        .attr("x", -8).attr("dy", "0.35em").attr("text-anchor", "end").style("fill", "#444");
    enter.append("rect").attr("class", "water-needs");
    enter.append("rect").attr("class", "water-planned").attr("fill-opacity", WATER_FADED_OPACITY);
    enter.append("text").attr("class", "chart-axis-label water-count")
        .attr("dy", "0.35em").style("fill", "#444");
    enter.call(placeRow);

    const exit = joined.exit().style("pointer-events", "none");
    const T = WATER_T;

    // Rows still on screen from an animation that got cut short (fast clicking) are reused here;
    // a new transition cancels their pending removal and sends them to their final place
    if (mode === "in" || mode === "out") joined.transition("row").duration(T).call(placeRow);

    if (mode === "grow") {
        // First draw after switching views: bars grow out from the axis, top to bottom
        exit.remove();
        enter.style("opacity", 0);
        enter.selectAll(".water-needs, .water-planned").attr("x", 0).attr("width", 0);
        enter.select(".water-count").attr("x", 5).style("opacity", 0);
        enter.transition("row").delay((d, i) => i * 40).duration(T).call(placeRow);
    } else if (mode === "instant") {
        exit.remove();
        joined.interrupt("row").call(placeRow);
        gRows.selectAll("g.water-row").order();
    } else if (mode === "update") {
        // Filter change: bars slide to their new lengths
        exit.transition("row").duration(T).style("opacity", 0).remove();
        joined.transition("row").duration(T).call(placeRow);
        enter.style("opacity", 0).transition("row").duration(T).style("opacity", 1);
    } else if (mode === "in") {
        // Drilling in: other categories fade, the clicked bar rises to the top row,
        // then the impairment bars grow out from the axis while it fades away
        exit.filter(d => d.id !== drilled)
            .transition("row").duration(T * 0.8).style("opacity", 0).remove();
        exit.filter(d => d.id === drilled)
            .raise()
            .transition("row").duration(T).attr("transform", `translate(0,${topY})`)
            .transition().duration(T).style("opacity", 0).remove();

        enter.style("opacity", 0);   // labels fade in as the bars grow
        enter.selectAll(".water-needs, .water-planned").attr("x", 0).attr("width", 0);
        enter.select(".water-count").attr("x", 5).style("opacity", 0);
        enter.transition("row").delay((d, i) => T + i * 40).duration(T).call(placeRow);
    } else {
        // Going back: impairment bars shrink to the axis, the category bar slides back
        // down to its spot, and the other categories fade back in
        const outT = exit.transition("row").duration(T * 0.8);
        outT.selectAll(".water-needs, .water-planned").attr("x", 0).attr("width", 0);
        outT.select(".water-count").style("opacity", 0);
        outT.transition().duration(1).remove();

        enter.filter(d => d.id === prev)
            .attr("transform", `translate(0,${topY})`)
            .raise()
            .transition("row").delay(T * 0.6).duration(T).call(placeRow);
        enter.filter(d => d.id !== prev)
            .style("opacity", 0)
            .transition("row").delay(T * 0.8).duration(T).style("opacity", 1);
    }

    // Hover + click on the whole row (label included) so short bars are easy to hit
    enter.merge(joined)
        .style("pointer-events", null)
        .style("cursor", drilled ? null : "pointer")
        .on("mousemove", (event, d) => showTooltipHtml(event, tip(d)))
        .on("mouseleave", hideTooltip)
        .on("click", (event, d) => {
            if (drilled || !d.total) return;
            hideTooltip();
            opts.onDrill(d.id);
        });
}

function renderWaterProblemChart() {
    if (!data.waterVisible) return;   // data not loaded yet

    // Leave the drill-down if its category was filtered out
    if (waterChartGroup && !waterFilters.groups.has(waterChartGroup)) waterChartGroup = null;
    const drilled = waterChartGroup;

    renderProblemChart(chart1, {
        waters: data.waterVisible,
        drilled,
        title: drilled ?? "Impaired waters by problem",
        subtitle: drilled
            ? "Waters with each impairment"
            : `${data.waterVisible.length.toLocaleString()} waters · a water with several problems counts in each · follows your filters`,
        backLinks: drilled ? [{ label: "← All problems", onClick: () => { waterChartGroup = null; renderChart1(); } }] : [],
        onDrill: id => { waterChartGroup = id; renderChart1(); }
    });
}

// ---- Waterbodies Chart 2: counties or watersheds with the most impaired waters ----

const PLACES_TOP_N = 10;

let selectedPlace = null;     // county/watershed drilled into: { boundary, id, label, feature }
let placeChartGroup = null;   // problem category drilled into within that place
let placesGrowNext = false;   // animate the ranking in on its next draw (coming back from a place)
let hoveredPlaceFeature = null;

// Outline drawn over the waters for the hovered / selected place (hidden with the waterbodies layer)
const placeHighlightG = layerGroups.waterbodies.append("g")
    .attr("class", "place-highlight")
    .style("pointer-events", "none");

const placeIdOf = (water, boundary) =>
    BOUNDARIES[boundary].waterId(water.properties);

function findPlaceFeature(boundary, id) {
    const b = BOUNDARIES[boundary];
    return b.group.selectAll("path.boundary").data()
        .find(f => String(b.featureId(f)) === String(id)) ?? null;
}

function drawPlaceHighlight() {
    const items = [];
    if (selectedPlace?.feature) items.push({ kind: "selected", f: selectedPlace.feature });
    if (hoveredPlaceFeature && hoveredPlaceFeature !== selectedPlace?.feature) items.push({ kind: "hover", f: hoveredPlaceFeature });

    placeHighlightG.selectAll("path")
        .data(items, d => d.kind)
        .join("path")
        .attr("d", d => path(d.f))
        .attr("fill", PIN_COLOR)
        .attr("fill-opacity", d => d.kind === "hover" ? 0.12 : 0.05)
        .attr("stroke", PIN_COLOR)
        .attr("stroke-width", 2.5)
        .attr("stroke-linejoin", "round")
        .attr("vector-effect", "non-scaling-stroke");
}

function hoverPlace(feature) {
    hoveredPlaceFeature = feature;
    drawPlaceHighlight();
}

// Click on a place bar: zoom the map to it and show its problems in this chart
function selectPlace(d) {
    const feature = findPlaceFeature(currentBoundary, d.id);
    selectedPlace = { boundary: currentBoundary, id: d.id, label: d.label, feature };
    placeChartGroup = null;
    hoveredPlaceFeature = null;
    hideTooltip();
    drawPlaceHighlight();
    if (feature) zoomTo(feature);
    renderKeyNumbers("waterbodies");   // tiles narrow to this place
    renderChart2();
}

function clearSelectedPlace({ rerender = true, zoomOut = true } = {}) {
    if (zoomOut && selectedPlace?.feature && activeFeature === selectedPlace.feature) reset();
    selectedPlace = null;
    placeChartGroup = null;
    placesGrowNext = true;
    drawPlaceHighlight();
    if (currentLayer === "waterbodies") renderKeyNumbers("waterbodies");
    if (rerender) renderChart2();
}

// Chart 2, levels 2 and 3: Chart 1's problem chart for just this place's waters
function renderPlaceProblems() {
    const sp = selectedPlace;
    if (placeChartGroup && !waterFilters.groups.has(placeChartGroup)) placeChartGroup = null;
    const drilled = placeChartGroup;
    const waters = data.waterVisible.filter(d => String(placeIdOf(d, sp.boundary)) === String(sp.id));

    const placeName = BOUNDARIES[sp.boundary].name(sp.label);
    const allLink = {
        label: BOUNDARIES[sp.boundary].back,
        onClick: () => clearSelectedPlace()
    };

    renderProblemChart(chart2, {
        waters,
        drilled,
        growIn: true,
        title: drilled ? `${placeName}: ${drilled}` : placeName,
        subtitle: drilled
            ? "Waters with each impairment"
            : `${waters.length.toLocaleString()} impaired waters · a water with several problems counts in each`,
        backLinks: drilled
            ? [allLink, { label: `← ${sp.label}`, onClick: () => { placeChartGroup = null; renderChart2(); } }]
            : [allLink],
        onDrill: id => { placeChartGroup = id; renderChart2(); }
    });
}

// Shortens a label to fit a pixel width, adding "…" (full name stays in the tooltip)
function fitLabel(textSel, maxWidth) {
    textSel.each(function (d) {
        const el = d3.select(this).text(d.label);
        let s = d.label;
        while (s.length > 4 && this.getComputedTextLength() > maxWidth) {
            s = s.slice(0, -1);
            el.text(s.trimEnd() + "…");
        }
    });
}

function renderWaterPlacesChart() {
    if (!data.waterVisible) return;   // data not loaded yet

    // A drilled-into place belongs to one boundary type; the toggle sends you back to the ranking
    if (selectedPlace && selectedPlace.boundary !== currentBoundary) clearSelectedPlace({ rerender: false, zoomOut: false });
    if (selectedPlace) {
        renderPlaceProblems();
        return;
    }

    const B = BOUNDARIES[currentBoundary];

    // Count visible waters per place. Solid/faded uses the same rule as the map:
    // solid if any of the water's impairments still needs a plan.
    const tally = new Map();
    data.waterVisible.forEach(d => {
        const p = d.properties;
        const id = B.waterId(p);
        if (id == null || id === "") return;
        const t = tally.get(id) ?? {
            id,
            key: `${currentBoundary}:${id}`,
            label: B.waterLabel(p),
            needs: 0, planned: 0
        };
        if (d.needsPlan) t.needs++; else t.planned++;
        tally.set(id, t);
    });
    const ranked = [...tally.values()]
        .map(t => ({ ...t, total: t.needs + t.planned }))
        .sort((a, b) => b.total - a.total || b.needs - a.needs);
    const rows = ranked.slice(0, PLACES_TOP_N);
    const placeWord = B.plural;

    // ---- Build the fixed parts once ----
    const fresh = chart2.select(".places-svg").empty();
    if (fresh) {
        chart2.html("");
        chart2.append("h2").attr("class", "panel-title places-title");
        chart2.append("p").attr("class", "chart-subtitle places-subtitle");
        const b = chart2.append("div").attr("class", "chart-body");
        b.append("p").attr("class", "panel-placeholder places-empty").text("No waters match your filters.");
        b.append("svg").attr("class", "places-svg").append("g").attr("class", "places-rows");
        chart2.append("p").attr("class", "chart-hint places-hint");
    }
    const prevBoundary = chart2.node().__placesBoundary;
    chart2.node().__placesBoundary = currentBoundary;
    const grow = fresh && placesGrowNext;   // coming back from a place: bars grow back in
    placesGrowNext = false;
    const T = fresh && !grow ? 0 : WATER_T;
    const switching = grow || (!fresh && prevBoundary !== currentBoundary);

    chart2.select(".places-title").text(`${B.title} with the most impaired waters`);
    chart2.select(".places-subtitle").text(
        `Top ${Math.min(PLACES_TOP_N, ranked.length)} of ${ranked.length.toLocaleString()} ${placeWord} · Choose a different boundary to see it's top 10 · follows your filters`);

    const swatch = op => `<svg width="11" height="11" aria-hidden="true" style="vertical-align:-1px">` +
        `<rect width="11" height="11" rx="2" fill="${PIN_COLOR}" fill-opacity="${op}"/></svg>`;
    chart2.select(".places-hint").html(
        `${swatch(1)} Still needs a cleanup plan &nbsp; ${swatch(WATER_FADED_OPACITY)} Plans in place` +
        `<br>Hover a bar to find it on the map · click to zoom in and see its problems.`);

    chart2.select(".places-empty").style("display", rows.length ? "none" : null);

    // ---- Scales ----
    const body = chart2.select(".chart-body");
    const svgC = chart2.select(".places-svg");
    const margin = { top: 6, right: 44, bottom: 6, left: 0 };
    const { width, height, innerH } = chartSize(body, margin);
    margin.left = Math.min(B.labelWidth, width * 0.45);
    const innerW = width - margin.left - margin.right;

    const step = Math.min(innerH / Math.max(rows.length, 1), 34);
    const y = d3.scaleBand()
        .domain(rows.map(d => d.key))
        .range([0, step * rows.length])
        .paddingInner(0.3)
        .paddingOuter(0.15);
    const x = d3.scaleLinear()
        .domain([0, d3.max(rows, d => d.total) || 1])
        .range([0, innerW]);
    const bw = y.bandwidth();

    svgC.attr("viewBox", [0, 0, width, height]).attr("width", width).attr("height", height);
    const gRows = svgC.select(".places-rows");
    gRows.transition("move").duration(T).attr("transform", `translate(${margin.left},${margin.top})`);

    // Bars use the site teal so the ranking doesn't suggest one problem category
    const BAR = PIN_COLOR;

    const placeRow = s => {
        s.attr("transform", d => `translate(0,${y(d.key)})`).style("opacity", 1);
        s.select(".places-hit")
            .attr("x", -margin.left)
            .attr("y", -y.step() * y.paddingInner() / 2)
            .attr("width", margin.left + innerW + margin.right)
            .attr("height", y.step());
        s.select(".places-label").attr("y", bw / 2);
        s.select(".places-needs").attr("height", bw).attr("width", d => x(d.needs));
        s.select(".places-planned").attr("x", d => x(d.needs)).attr("height", bw).attr("width", d => x(d.planned));
        s.select(".places-count").attr("x", d => x(d.total) + 5).attr("y", bw / 2)
            .text(d => d.total.toLocaleString());
    };

    const joined = gRows.selectAll("g.places-row").data(rows, d => d.key);
    const enter = joined.enter().append("g").attr("class", "places-row");
    enter.append("rect").attr("class", "places-hit").attr("fill", "transparent");
    enter.append("text").attr("class", "chart-axis-label places-label")
        .attr("x", -8).attr("dy", "0.35em").attr("text-anchor", "end").style("fill", "#444");
    enter.append("rect").attr("class", "places-needs").attr("x", 0).attr("fill", BAR);
    enter.append("rect").attr("class", "places-planned").attr("fill", BAR).attr("fill-opacity", WATER_FADED_OPACITY);
    enter.append("text").attr("class", "chart-axis-label places-count").attr("dy", "0.35em").style("fill", "#444");
    enter.call(placeRow);

    const merged = enter.merge(joined);
    merged.select(".places-label").call(fitLabel, margin.left - 12);

    if (T === 0) {
        joined.exit().remove();
        joined.interrupt("row").call(placeRow);
    } else {
        // Places leaving the top 10 fade out, places staying slide to their new rank,
        // new places fade in. Switching counties <-> watersheds staggers the new list in.
        joined.exit().style("pointer-events", "none")
            .transition("row").duration(T * 0.8).style("opacity", 0).remove();
        joined.transition("row").duration(T).call(placeRow);
        enter.style("opacity", 0);
        enter.selectAll(".places-needs, .places-planned").attr("width", 0);
        enter.select(".places-planned").attr("x", 0);
        enter.transition("row")
            .delay((d, i) => switching ? T * 0.6 + i * 35 : 0)
            .duration(T)
            .call(placeRow);
    }
    gRows.selectAll("g.places-row").filter(d => rows.includes(d))
        .sort((a, b) => rows.indexOf(a) - rows.indexOf(b));   // DOM order = rank (for screen readers)

    const tip = d => {
        const rank = ranked.indexOf(d) + 1;
        const name = B.name(d.label);
        return `<strong>${escapeHtml(name)}</strong>` +
            (B.extra ? ` <span style="color:#888">${escapeHtml(B.extra(d.id))}</span>` : "") + `<br>` +
            `#${rank} of ${ranked.length.toLocaleString()} ${placeWord}<br>` +
            `${d.total.toLocaleString()} impaired waters<br>` +
            `Still needs a cleanup plan: ${d.needs.toLocaleString()}<br>` +
            `Plans in place: ${d.planned.toLocaleString()}<br>` +
            `<em>Click to zoom in and see its problems</em>`;
    };
    merged
        .style("pointer-events", null)
        .style("cursor", "pointer")
        .on("mouseenter", (event, d) => hoverPlace(findPlaceFeature(currentBoundary, d.id)))
        .on("mousemove", (event, d) => showTooltipHtml(event, tip(d)))
        .on("mouseleave", () => { hideTooltip(); hoverPlace(null); })
        .on("click", (event, d) => selectPlace(d));
}

// ---- Nitrate Chart 2: long-term regional trend (from data/region_year.csv) ----
// Each point = median across sites of each site's typical March–October level that year
// (median of monthly medians). Built in R; ignores the map filters on purpose.

// Weather years worth flagging: nitrate in streams follows the rain
const NITRATE_TREND_NOTES = [
    { year: 2012, label: "2012 drought", side: "left",
      text: "Drought year: with little runoff, less nitrate washed from fields into streams." },
    { year: 2016, label: "2016 wet year", side: "right",
      text: "Very wet year: heavy rain flushed nitrate from fields into streams." }
];
const TREND_DEFAULT_REGION = "Statewide";
let nitrateTrendRegion = null;   // set from the data on first draw

function renderNitrateTrendChart() {
    const all = data.nitrateTrend ?? [];
    const regions = [...new Set(all.map(d => d.region))]
        .sort((a, b) => (a === TREND_DEFAULT_REGION ? -1 : b === TREND_DEFAULT_REGION ? 1 : a.localeCompare(b)));
    if (!nitrateTrendRegion || !regions.includes(nitrateTrendRegion)) {
        nitrateTrendRegion = regions.includes(TREND_DEFAULT_REGION) ? TREND_DEFAULT_REGION : regions[0];
    }
    const rows = all.filter(d => d.region === nitrateTrendRegion).sort((a, b) => a.year - b.year);

    // ---- Header with a region picker ----
    const head = chart2.append("div").attr("class", "trend-head")
        .style("display", "flex").style("align-items", "baseline")
        .style("justify-content", "space-between").style("gap", "0.5rem").style("flex-wrap", "wrap");
    head.append("h2").attr("class", "panel-title").text("Nitrate over time by region");
    const select = head.append("select")
        .attr("aria-label", "Region")
        .style("font", "inherit").style("font-size", "0.78rem")
        .style("padding", "0.1rem 0.3rem").style("max-width", "60%")
        .on("change", function () {
            nitrateTrendRegion = this.value;
            hideTooltip();
            renderChart2();
        });
    select.selectAll("option").data(regions).join("option")
        .attr("value", d => d).property("selected", d => d === nitrateTrendRegion).text(d => d);

    const siteRange = d3.extent(rows, d => d.n_sites);
    chart2.append("p").attr("class", "chart-subtitle").text(
        "Typical March–October nitrate across long-term monitoring sites" +
        (rows.length ? ` · ${siteRange[0] === siteRange[1] ? siteRange[0] : `${siteRange[0]}–${siteRange[1]}`} sites per year` : ""));

    const body = chart2.append("div").attr("class", "chart-body");

    chart2.append("p").attr("class", "chart-hint").html(
        '<svg width="18" height="8" aria-hidden="true" style="vertical-align:middle">' +
        '<line x1="9" x2="9" y1="0" y2="8" stroke="#999" stroke-dasharray="2 2"/></svg> ' +
        "Weather years: rain washes nitrate into streams, drought keeps it in the soil · not affected by the map filters.");

    if (!rows.length) {
        body.append("p").attr("class", "panel-placeholder").text("No trend data for this region.");
        return;
    }

    // ---- Scales ----
    const margin = { top: 22, right: 14, bottom: 22, left: 60 };   // top: note labels; left: "0.5 mg/L" tick
    const { width, height, innerW, innerH } = chartSize(body, margin);

    const x = d3.scaleLinear()
        .domain(d3.extent(rows, d => d.year))
        .range([0, innerW]);

    // Show the 10 mg/L standard only when the data comes anywhere near it
    const maxVal = d3.max(rows, d => d.median_mgL);
    const showStandard = maxVal > NITRATE_STANDARD * 0.5;
    const y = d3.scaleLinear()
        .domain([0, Math.max(maxVal * 1.15, showStandard ? NITRATE_STANDARD * 1.08 : 0)])
        .nice()
        .range([innerH, 0]);

    const svgC = body.append("svg")
        .attr("viewBox", [0, 0, width, height])
        .attr("width", width)
        .attr("height", height);
    const gC = svgC.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Gridlines + axes (unit on the top tick only, like Chart 1)
    gC.append("g")
        .attr("class", "chart-grid")
        .call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(""))
        .call(s => s.select(".domain").remove());

    gC.append("g")
        .attr("class", "chart-axis")
        .attr("transform", `translate(0,${innerH})`)
        .call(d3.axisBottom(x)
            .ticks(Math.max(2, Math.min(rows.length, Math.floor(innerW / 60))))
            .tickFormat(d3.format("d"))
            .tickSizeOuter(0));

    const yTicks = y.ticks(4);
    const topTick = yTicks[yTicks.length - 1];
    gC.append("g")
        .attr("class", "chart-axis")
        .call(d3.axisLeft(y).ticks(4).tickFormat(d => d === topTick ? `${d} mg/L` : d))
        .call(s => s.select(".domain").remove());

    if (showStandard) {
        gC.append("line")
            .attr("class", "chart-standard")
            .attr("x1", 0).attr("x2", innerW)
            .attr("y1", y(NITRATE_STANDARD)).attr("y2", y(NITRATE_STANDARD));
        gC.append("text")
            .attr("class", "chart-standard-label")
            .attr("x", innerW)
            .attr("y", y(NITRATE_STANDARD) - 4)
            .attr("text-anchor", "end")
            .text(`${NITRATE_STANDARD} mg/L drinking water standard`);
    }

    // ---- Weather annotations: dashed line + label above the plot, explanation on hover ----
    const [x0, x1] = x.domain();
    const notes = NITRATE_TREND_NOTES.filter(n => n.year >= x0 && n.year <= x1);
    const noteG = gC.append("g")
        .selectAll("g")
        .data(notes)
        .join("g")
        .attr("transform", n => `translate(${x(n.year)},0)`)
        .style("cursor", "help")
        .on("mousemove", (event, n) => showTooltipHtml(event, `<strong>${n.label}</strong><br>${n.text}`))
        .on("mouseleave", hideTooltip);
    noteG.append("line")
        .attr("y1", -6).attr("y2", innerH)
        .attr("stroke", "#999").attr("stroke-dasharray", "2 3");
    noteG.append("text")
        .attr("class", "chart-axis-label")
        .attr("y", -10)
        // Labels sit beside their line (2012 to the left, 2016 to the right) so they can't collide
        .attr("x", n => n.side === "left" ? -3 : 3)
        .attr("text-anchor", n => n.side === "left" ? "end" : "start")
        .style("fill", "#666")
        .text(n => n.label);
    noteG.append("rect")   // wider hover target than the thin line
        .attr("x", -6).attr("y", -20).attr("width", 12).attr("height", innerH + 20)
        .attr("fill", "transparent");

    // ---- Line (broken where a year is missing) + points ----
    const withGaps = [];
    rows.forEach((d, i) => {
        if (i > 0 && d.year - rows[i - 1].year > 1) withGaps.push({ gap: true });
        withGaps.push(d);
    });

    gC.append("path")
        .datum(withGaps)
        .attr("fill", "none")
        .attr("stroke", PIN_COLOR)
        .attr("stroke-width", 2)
        .attr("stroke-linejoin", "round")
        .style("pointer-events", "none")
        .attr("d", d3.line()
            .defined(d => !d.gap)
            .x(d => x(d.year))
            .y(d => y(d.median_mgL)));

    gC.append("g")
        .selectAll("circle")
        .data(rows)
        .join("circle")
        .attr("cx", d => x(d.year))
        .attr("cy", d => y(d.median_mgL))
        .attr("r", 2.8)
        .attr("fill", PIN_COLOR)
        .style("pointer-events", "none")
        .attr("stroke", "#fff")
        .attr("stroke-width", 0.8);

    // ---- Hover: snap to the nearest year ----
    const focus = gC.append("circle")
        .attr("class", "chart-focus")
        .attr("r", 5)
        .style("display", "none");
    const bisect = d3.bisector(d => d.year).center;

    gC.insert("rect", "g")   // under the notes so their own hover still works
        .attr("width", innerW)
        .attr("height", innerH)
        .attr("fill", "transparent")
        .on("mousemove", event => {
            const [mx] = d3.pointer(event);
            const d = rows[bisect(rows, x.invert(mx))];
            focus.style("display", null).attr("cx", x(d.year)).attr("cy", y(d.median_mgL));
            const note = NITRATE_TREND_NOTES.find(n => n.year === d.year);
            showTooltipHtml(event,
                `<strong>${d.year}</strong> · ${escapeHtml(nitrateTrendRegion)}<br>` +
                `Typical nitrate: ${d.median_mgL.toFixed(2)} mg/L<br>` +
                `${d.n_sites.toLocaleString()} sites` +
                (note ? `<br><em>${note.label}</em>` : ""));
        })
        .on("mouseleave", () => {
            focus.style("display", "none");
            hideTooltip();
        });
}

function renderChart1() {
    if (chart1.property("hidden")) return;   // not visible; drawn when its tab is opened
    if (currentLayer === "pfas") {
        renderPfasSystemChart();
        return;
    }
    if (currentLayer === "waterbodies") {
        renderWaterProblemChart();
        return;
    }
    if (currentLayer !== "nitrate") {
        chartPlaceholder(chart1, "Chart for this layer coming soon.");
        return;
    }
    if (!data.nitrateBySite) return;   // data not loaded yet

    const site = data.nitrateSiteById.get(selectedSiteId);
    const readings = data.nitrateBySite.get(selectedSiteId) ?? [];

    chart1.html("");

    // ---- Header ----
    chart1.append("h2").attr("class", "panel-title")
        .text(site ? site.name : "Nitrate readings");

    const dateRange = readings.length
        ? `${formatMonthYear(readings[0].date)}–${formatMonthYear(readings[readings.length - 1].date)}`
        : "";
    chart1.append("p").attr("class", "chart-subtitle")
        .text([site?.water_type, `${readings.length} readings`, dateRange].filter(Boolean).join(" · "));

    const body = chart1.append("div").attr("class", "chart-body");

    chart1.append("p").attr("class", "chart-hint").text("Click any site on the map to see its readings.");

    if (!readings.length) {
        body.append("p").attr("class", "panel-placeholder").text("No readings for this site.");
        return;
    }

    // ---- Size from the panel ----
    const { width: w, height: h } = body.node().getBoundingClientRect();
    const width = Math.max(w, 200);
    const height = Math.max(h, 120);
    const margin = { top: 10, right: 14, bottom: 22, left: 52 };   // room for the "25 mg/L" top tick
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const x = d3.scaleTime()
        .domain(d3.extent(readings, d => d.date))
        .range([0, innerW]);
    if (readings.length === 1) x.domain([d3.timeMonth.offset(readings[0].date, -1), d3.timeMonth.offset(readings[0].date, 1)]);

    const y = d3.scaleLinear()
        .domain([0, Math.max(NITRATE_STANDARD * 1.15, d3.max(readings, d => d.nitrate_mgL) * 1.05)])
        .nice()
        .range([innerH, 0]);

    const svgC = body.append("svg")
        .attr("viewBox", [0, 0, width, height])
        .attr("width", width)
        .attr("height", height);

    const gC = svgC.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Gridlines + axes
    gC.append("g")
        .attr("class", "chart-grid")
        .call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(""))
        .call(s => s.select(".domain").remove());

    gC.append("g")
        .attr("class", "chart-axis")
        .attr("transform", `translate(0,${innerH})`)
        .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(innerW / 80))).tickSizeOuter(0));

    // Unit goes on the top tick only ("25 mg/L"), the rest are plain numbers
    const yTicks = y.ticks(4);
    const topTick = yTicks[yTicks.length - 1];

    gC.append("g")
        .attr("class", "chart-axis")
        .call(d3.axisLeft(y).ticks(4).tickFormat(d => d === topTick ? `${d} mg/L` : d))
        .call(s => s.select(".domain").remove());

    // 10 mg/L standard
    gC.append("line")
        .attr("class", "chart-standard")
        .attr("x1", 0).attr("x2", innerW)
        .attr("y1", y(NITRATE_STANDARD)).attr("y2", y(NITRATE_STANDARD));
    gC.append("text")
        .attr("class", "chart-standard-label")
        .attr("x", innerW)
        .attr("y", y(NITRATE_STANDARD) - 4)
        .attr("text-anchor", "end")
        .text(`${NITRATE_STANDARD} mg/L drinking water standard`);

    // Line, broken across long gaps so it doesn't imply readings that weren't taken
    const withGaps = [];
    readings.forEach((d, i) => {
        if (i > 0 && (d.date - readings[i - 1].date) / 864e5 > GAP_DAYS) withGaps.push({ gap: true });
        withGaps.push(d);
    });

    gC.append("path")
        .datum(withGaps)
        .attr("class", "chart-line")
        .attr("d", d3.line()
            .defined(d => !d.gap)
            .x(d => x(d.date))
            .y(d => y(d.nitrate_mgL)));

    // Points: filled = measured, hollow = below detection (plotted at the detection limit)
    gC.append("g")
        .selectAll("circle")
        .data(readings)
        .join("circle")
        .attr("cx", d => x(d.date))
        .attr("cy", d => y(d.nitrate_mgL))
        .attr("r", readings.length > 150 ? 2 : 3)
        .attr("fill", d => d.non_detect ? "#fff" : nitrateColor(d.nitrate_mgL))
        .attr("stroke", d => d.non_detect ? "#b8860b" : "#444")
        .attr("stroke-width", 0.6);

    // Hover: snap to the nearest reading
    const focus = gC.append("circle")
        .attr("class", "chart-focus")
        .attr("r", 5)
        .style("display", "none");

    const bisect = d3.bisector(d => d.date).center;

    gC.append("rect")
        .attr("width", innerW)
        .attr("height", innerH)
        .attr("fill", "transparent")
        .on("mousemove", event => {
            const [mx] = d3.pointer(event);
            const d = readings[bisect(readings, x.invert(mx))];
            focus.style("display", null).attr("cx", x(d.date)).attr("cy", y(d.nitrate_mgL));
            const value = d.non_detect
                ? `below detection (&lt;${d.nitrate_mgL.toFixed(2)} mg/L)`
                : `${d.nitrate_mgL.toFixed(2)} mg/L`;
            showTooltipHtml(event, `<strong>${formatDay(d.date)}</strong><br>${value}`);
        })
        .on("mouseleave", () => {
            focus.style("display", "none");
            hideTooltip();
        });
}

// Redraw the open chart when the panel changes size (window resize, layout breakpoints)
let chartFrame = null;
let lastChartSize = "";
new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    const size = `${Math.round(width)}x${Math.round(height)}`;
    if (size === lastChartSize) return;      // ignore redraws that don't change the size
    lastChartSize = size;
    cancelAnimationFrame(chartFrame);
    chartFrame = requestAnimationFrame(() => {
        if (activeChartTab === 0) renderChart1();
        else renderChart2();
    });
}).observe(document.getElementById("panel-charts"));

// ==============================================================================
// Load all data, fit the projection, then draw
// ==============================================================================

Promise.all([
    d3.json("https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json"),
    d3.json(DATA_URL + "huc8_mn.geojson"),
    d3.json(DATA_URL + "impaired_waters.geojson"),
    d3.json(DATA_URL + "pfas_all.geojson"),
    d3.json(DATA_URL + "pfas_long.json"),
    d3.json(DATA_URL + "nitrate_sites.geojson"),
    d3.csv(DATA_URL + "nitrate_daily.csv", d => {
        const date = d3.timeParse("%Y-%m-%d")(d.date);
        return {
            site_id: d.site_id,
            date,
            year: date.getFullYear(),
            month: date.getMonth() + 1,
            nitrate_mgL: +d.nitrate_mgL,
            non_detect: d.non_detect === "1"
        };
    }),
    // Long-term regional trend from R. Accepts year_med (or median_mgL) for the value.
    d3.csv(DATA_URL + "region_year.csv", d => ({
        region: d.region,
        year: +d.year,
        median_mgL: +(d.year_med ?? d.median_mgL),
        n_sites: +d.n_sites
    })),
    // District outlines (optional: if a file is missing, its dropdown option is disabled)
    d3.json(DATA_URL + "mn_house.geojson").catch(() => null),
    d3.json(DATA_URL + "mn_senate.geojson").catch(() => null),
    d3.json(DATA_URL + "mn_congress.geojson").catch(() => null)
]).then(([us, huc8, waters, pfasAll, pfasLong, nitrateSites, nitrateDaily, nitrateTrend,
          houseDists, senateDists, congressDists]) => {
    data.nitrateTrend = nitrateTrend.filter(d => d.region && isFinite(d.year) && isFinite(d.median_mgL));

    // ---- Base map: counties + projection fit (must happen before anything is drawn) ----
    const mnGeoms = us.objects.counties.geometries.filter(d => d.id.startsWith("27"));
    const counties = topojson.feature(us, { type: "GeometryCollection", geometries: mnGeoms });
    const outline = topojson.merge(us, mnGeoms);

    projection.fitExtent([[20, 20], [width - 20, height - 20]], counties);

    countiesG.selectAll("path")
        .data(counties.features)
        .join("path")
        .attr("class", "boundary county")
        .attr("d", path)
        .on("click", zoomToFeature)
        .on("mousemove", (event, d) => showTooltip(event, `${d.properties.name} County`))
        .on("mouseleave", hideTooltip);

    // ---- HUC 8 watersheds (hidden until toggled on) ----
    rewindFeatures(huc8);

    watershedsG.selectAll("path")
        .data(huc8.features)
        .join("path")
        .attr("class", "boundary watershed")
        .attr("d", path)
        .on("click", zoomToFeature)
        .on("mousemove", (event, d) =>
            showTooltip(event, `${d.properties.name} watershed (HUC ${d.properties.huc8})`))
        .on("mouseleave", hideTooltip);

    // ---- Legislative districts: House districts, Senate districts as heavier lines ----
    if (houseDists) {
        rewindFeatures(houseDists);
        legislativeG.selectAll("path.boundary")
            .data(houseDists.features)
            .join("path")
            .attr("class", "boundary district")
            .attr("d", path)
            .on("click", zoomToFeature)
            .on("mousemove", (event, d) => showTooltip(event,
                `House District ${d.properties.house} · Senate District ${d.properties.senate}`))
            .on("mouseleave", hideTooltip);
    }
    if (senateDists) {
        rewindFeatures(senateDists);
        legislativeG.append("g")
            .attr("class", "senate-lines")
            .style("pointer-events", "none")
            .selectAll("path")
            .data(senateDists.features)
            .join("path")
            .attr("class", "district-major")
            .attr("d", path);
    }

    // ---- Congressional districts ----
    if (congressDists) {
        rewindFeatures(congressDists);
        congressG.selectAll("path.boundary")
            .data(congressDists.features)
            .join("path")
            .attr("class", "boundary district")
            .attr("d", path)
            .on("click", zoomToFeature)
            .on("mousemove", (event, d) => showTooltip(event, `Congressional District ${d.properties.district}`))
            .on("mouseleave", hideTooltip);
    }

    // Disable dropdown options whose outlines didn't load
    boundarySelect.select('option[value="legislative"]').property("disabled", !houseDists);
    boundarySelect.select('option[value="congressional"]').property("disabled", !congressDists);

    // ---- State outline ----
    outlineG.append("path")
        .datum(outline)
        .attr("class", "state-outline")
        .attr("d", path);

    // ---- Nitrate data ----
    data.nitrateSites = nitrateSites;
    data.nitrateDaily = nitrateDaily;
    data.nitrateYears = d3.extent(nitrateDaily, d => d.year);

    // For Chart 1: each site's readings in date order, and site info by ID
    data.nitrateBySite = d3.group(
        nitrateDaily.slice().sort((a, b) => a.date - b.date),
        d => d.site_id
    );
    data.nitrateSiteById = new Map(nitrateSites.features.map(f => [f.properties.site_id, f.properties]));

    // Default site; if it's missing from the data, fall back to the site with the most readings
    selectedSiteId = data.nitrateBySite.has(DEFAULT_SITE)
        ? DEFAULT_SITE
        : d3.greatest(data.nitrateBySite, ([, v]) => v.length)?.[0] ?? null;
    if (selectedSiteId !== DEFAULT_SITE) {
        console.warn(`Default site ${DEFAULT_SITE} not found; showing ${selectedSiteId} instead.`);
    }

    if (nitrateSites.features.some(f => !f.properties.water_type)) {
        console.warn("Some nitrate sites have no water_type; they will always be shown. Re-export with the water_type column.");
    }

    // ---- PFAS data ----
    data.pfasCompoundsByPwsid = d3.group(pfasLong, d => d.pwsid);

    const pfasR = d3.scaleSqrt()
        .domain([0, d3.max(pfasAll.features, d => d.properties.pop_serv ?? 0)])
        .range([2.5, 14]);

    data.pfasFeatures = pfasAll.features
        .filter(d => d.geometry)
        .map(d => ({
            ...d,
            r: pfasR(d.properties.pop_serv ?? 0),
            source: pfasSource(d.properties),
            compounds: new Set((data.pfasCompoundsByPwsid.get(d.properties.pwsid) ?? []).map(c => c.analyte))
        }))
        // Worse categories on top; within a category, big circles first so small ones stay visible
        .sort((a, b) =>
            (pfasRank.get(a.properties.pfas_category) ?? 0) - (pfasRank.get(b.properties.pfas_category) ?? 0) ||
            b.r - a.r);

    // Compound dropdown: how many systems detected each compound, most common first
    data.pfasCompounds = d3.rollups(pfasLong, v => new Set(v.map(d => d.pwsid)).size, d => d.analyte)
        .map(([analyte, n]) => ({ analyte, n }))
        .sort((a, b) => b.n - a.n);

    const sourceOrder = ["Groundwater", "Surface water", "Purchased", "Other"];
    data.pfasSources = sourceOrder.filter(s => data.pfasFeatures.some(d => d.source === s));

    // For PFAS Chart 1: systems by ID, and the chemicals to show as bars
    // (every chemical in the data; ones with an EPA limit first, in PFAS_LIMITS order)
    data.pfasById = new Map(data.pfasFeatures.map(d => [d.properties.pwsid, d]));
    const limitOrder = Object.keys(PFAS_LIMITS);
    data.pfasAnalytes = Array.from(new Set(pfasLong.map(d => d.analyte)))
        .sort((a, b) => {
            const ia = limitOrder.indexOf(String(a).toUpperCase());
            const ib = limitOrder.indexOf(String(b).toUpperCase());
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a).localeCompare(String(b));
        });

    // Default PFAS system: the largest system where PFAS was detected
    selectedPwsid = d3.greatest(
        data.pfasFeatures.filter(d => d.properties.pfas_category !== PFAS_NOT_DETECTED),
        d => +d.properties.pop_serv || 0
    )?.properties.pwsid ?? null;

    // ---- Filters + layers ----
    // ---- Impaired waterbodies ----
    prepareWaterbodies(waters);

    nitrateFilters = defaultNitrateFilters();
    pfasFilters = defaultPfasFilters();
    waterFilters = defaultWaterFilters();

    updateNitrate();
    updatePfas();
    updateWaterbodies();

    setDataLayer(DEFAULT_LAYER);

    // ---- Share loaded data with the "Explore Contamination Near You" page (explore.js) ----
    data.areaFeatures = {
        county: counties.features,
        watershed: huc8.features,
        house: houseDists?.features ?? [],
        senate: senateDists?.features ?? [],
        congress: congressDists?.features ?? []
    };
    data.mnOutline = outline;
    data.ready = true;
    window.dispatchEvent(new Event("mapdata:ready"));

}).catch(err => console.error("Failed to load map data:", err));