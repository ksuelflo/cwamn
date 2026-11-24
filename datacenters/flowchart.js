// ===== Cooling flow chart scrolly =====
// A click-through SVG flow chart: a text panel (left) with Back/Next buttons, and the
// chart (right, centered on Hot chips). Each .flow-step has a data-stage; showing it
// reveals every node/edge whose stage <= that number and zooms to fit them. data-highlight="<name>"
// outlines one of the PATHS below (the best- and worst-case setups for a Minnesota data center).

(() => {
    const root = document.getElementById("flow");
    if (!root) return;
    const svg = root.querySelector(".flow-svg");
    const legend = root.querySelector(".flow-legend");
    const NS = "http://www.w3.org/2000/svg";

    // Layout in chart units. x/y = node center, w/h = size, s = stage it appears at.
    // power/water = 0–3 rating (icons); water: "depends" prints the word instead.
    // pfas = flashing warning sign. kind = special coloring (chips / loop).
    const CENTER_X = 935; // Hot chips; the chart stays centered on this
    const ROW = { chips: 50, r2: 228, r3: 432, loop: 633, r5: 834, r6: 1038 };
    const NODES = {
        chips:       { label: "Hot chips", x: 935, y: ROW.chips, w: 260, h: 80, s: 1, kind: "chips" },
        air:         { label: "Air", sub: "Fans, air handlers", x: 497, y: ROW.r2, w: 240, h: 140, s: 2, power: 3, water: 0 },
        coldplate:   { label: "Cold plate", sub: "Liquid to chip", x: 836, y: ROW.r2, w: 240, h: 140, s: 2 },
        immersion:   { label: "Immersion", sub: "Servers in fluid", x: 1260, y: ROW.r2, w: 240, h: 140, s: 2 },
        cp1:         { label: "1-phase", sub: "Water-glycol", x: 730, y: ROW.r3, w: 186, h: 140, s: 3, power: 1, water: 0 },
        cp2:         { label: "2-phase", sub: "Fluorinated", x: 942, y: ROW.r3, w: 186, h: 140, s: 3, power: 1, water: 0, pfas: true },
        im1:         { label: "1-phase", sub: "Mostly oils", x: 1154, y: ROW.r3, w: 186, h: 140, s: 3, power: 1, water: 0 },
        im2:         { label: "2-phase", sub: "Fluorinated", x: 1366, y: ROW.r3, w: 186, h: 140, s: 3, power: 1, water: 0, pfas: true },
        facility:    { label: "Facility water loop", sub: "Via CDU or coils", x: 935, y: ROW.loop, w: 372, h: 104, s: 3, kind: "loop" },
        chiller:     { label: "Chiller", sub: "Refrigerant cycle", x: 525, y: ROW.r5, w: 298, h: 140, s: 4, pfas: true },
        drycooler:   { label: "Dry cooler", sub: "Fans, no water", x: 935, y: ROW.r5, w: 298, h: 140, s: 4, power: 2, water: 0 },
        tower:       { label: "Cooling tower", sub: "Evaporates water", x: 1344, y: ROW.r5, w: 298, h: 140, s: 4, power: 1, water: 3, pfas: true },
        aircooled:   { label: "Air-cooled", sub: "Own fans", x: 479, y: ROW.r6, w: 205, h: 140, s: 4, power: 3, water: 0 },
        watercooled: { label: "Water-cooled", sub: "Sends heat on", x: 730, y: ROW.r6, w: 224, h: 140, s: 4, power: 2, water: "depends" },
    };
    const BUS_Y = 544; // shared line every cooling method drops into before the water loop

    // [from, to, opts]. Elbow connectors: down from parent, across, down into child.
    const EDGES = [
        ["chips", "air", { midY: 124 }], ["chips", "coldplate", { midY: 124 }], ["chips", "immersion", { midY: 124 }],
        ["coldplate", "cp1"], ["coldplate", "cp2"], ["immersion", "im1"], ["immersion", "im2"],
        ["air", "facility", { midY: BUS_Y }], ["cp1", "facility", { midY: BUS_Y }],
        ["cp2", "facility", { midY: BUS_Y }], ["im1", "facility", { midY: BUS_Y }],
        ["im2", "facility", { midY: BUS_Y }],
        ["facility", "chiller"], ["facility", "drycooler"], ["facility", "tower"],
        ["chiller", "aircooled"], ["chiller", "watercooled"],
        // water-cooled chillers pass their heat on to a dry cooler or cooling tower
        ["watercooled", "drycooler", { dashed: 1008 }],
        ["watercooled", "tower", { dashed: 1050 }],
    ];

    // Highlighted paths, as the edges they follow (data-highlight="best" / "worst" on a step)
    const PATHS = {
        // water-glycol direct-to-chip cooling → facility water loop → dry cooler
        best: [["chips", "coldplate"], ["coldplate", "cp1"], ["cp1", "facility"], ["facility", "drycooler"]],
        // 2-phase immersion → facility water loop → dry cooler, plus air-cooled chillers
        worst: [["chips", "immersion"], ["immersion", "im2"], ["im2", "facility"],
                ["facility", "drycooler"], ["facility", "chiller"], ["chiller", "aircooled"]],
    };

    // Icon shapes, drawn around (0,0)
    const BOLT = "M2,-9 L-6,2 H-0.5 L-2,9 L6,-2 H0.5 Z";
    const DROP = "M0,-9 C0,-9 -6,-1.5 -6,2.5 A6,6 0 0 0 6,2.5 C6,-1.5 0,-9 0,-9 Z";
    const WARN = "M0,-12 L12,10 H-12 Z";

    function edgePath(a, b, opts = {}) {
        const p = NODES[a], c = NODES[b];
        const y2 = c.y + (opts.dashed ? c.h / 2 + 4 : -c.h / 2 - 4); // stop short for the arrowhead
        if (opts.dashed) return `M${p.x + p.w / 2},${opts.dashed} H${c.x} V${y2}`;
        const y1 = p.y + p.h / 2;
        const midY = opts.midY ?? (y1 + c.y - c.h / 2) / 2;
        return `M${p.x},${y1} V${midY} H${c.x} V${y2}`;
    }

    const el = (tag, attrs, parent) => {
        const e = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
        parent.appendChild(e);
        return e;
    };

    // Arrowheads (grey + highlighted path color)
    const defs = el("defs", {}, svg);
    for (const [id, cls] of [["flow-arrow", "flow-arrow"], ["flow-arrow-path", "flow-arrow-path"]]) {
        const m = el("marker", { id, viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 14, markerHeight: 14, orient: "auto-start-reverse", markerUnits: "userSpaceOnUse" }, defs);
        el("path", { d: "M0,1 L10,5 L0,9 Z", class: cls }, m);
    }

    const scene = el("g", { class: "flow-scene" }, svg);
    const edgeLayer = el("g", {}, scene);
    const pathLayer = el("g", {}, scene); // highlighted edges draw above the rest
    const nodeLayer = el("g", {}, scene);

    const items = []; // { el, s }
    const edgeEls = {}; // "from>to" -> path element
    const nodeEls = {}; // key -> node group
    for (const [a, b, opts = {}] of EDGES) {
        const e = el("path", {
            d: edgePath(a, b, opts),
            class: `flow-edge${opts.dashed ? " is-dashed" : ""}`,
            "marker-end": "url(#flow-arrow)",
        }, edgeLayer);
        edgeEls[`${a}>${b}`] = e;
        items.push({ el: e, s: Math.max(NODES[a].s, NODES[b].s) });
    }

    function icons(g, n, y) {
        const hasIcons = n.power != null;
        if (!hasIcons) return;
        // 3 bolts, gap, 3 drops (or the word "depends")
        const startX = -62;
        for (let i = 0; i < 3; i++) {
            el("path", { d: BOLT, class: i < n.power ? "icon-power" : "icon-off", transform: `translate(${startX + i * 21},${y})` }, g);
        }
        if (n.water === "depends") {
            el("text", { class: "sub", x: 62, y, dy: "0.35em", "text-anchor": "end" }, g).textContent = "depends";
        } else {
            for (let i = 0; i < 3; i++) {
                el("path", { d: DROP, class: i < n.water ? "icon-water" : "icon-off", transform: `translate(${20 + i * 21},${y})` }, g);
            }
        }
    }

    for (const [key, n] of Object.entries(NODES)) {
        const cls = ["flow-node", n.kind && `is-${n.kind}`].filter(Boolean).join(" ");
        const g = el("g", { class: cls, transform: `translate(${n.x},${n.y})` }, nodeLayer);
        nodeEls[key] = g;
        el("rect", { class: "box", x: -n.w / 2, y: -n.h / 2, width: n.w, height: n.h, rx: 10 }, g);

        // stack title / subtitle / icons vertically around the center
        const lines = [["title", 32], n.sub && ["sub", 30], n.power != null && ["icons", 32]].filter(Boolean);
        const total = lines.reduce((t, [, h]) => t + h, 0);
        let y = -total / 2;
        for (const [kind, h] of lines) {
            const cy = y + h / 2;
            if (kind === "icons") icons(g, n, cy + 4);
            else el("text", { class: kind, y: cy, dy: "0.35em", "text-anchor": "middle" }, g).textContent = kind === "title" ? n.label : n.sub;
            y += h;
        }

        if (n.pfas) {
            const w = el("g", { class: "flow-warn", transform: `translate(${n.w / 2 - 22},${-n.h / 2 + 22})` }, g);
            el("title", {}, w).textContent = "Possible PFAS";
            el("path", { d: WARN, "stroke-linejoin": "round" }, w);
            el("text", { y: 4, dy: "0.25em", "text-anchor": "middle" }, w).textContent = "!";
        }
        items.push({ el: g, s: n.s });
    }

    // ----- zoom -----
    // Wide screens: fit every visible node, keeping Hot chips at the horizontal center.
    // Phones (≤900px): zoom to the step's data-focus nodes at a readable scale (KMIN or more);
    // anything outside the view can be swiped into view sideways.
    const phone = window.matchMedia("(max-width: 900px)");
    const KMIN = 0.5; // chart units -> px on phones (26-unit titles ≈ 13px); ~700 units fit a 375px phone
    let stage = 1;
    let focus = null; // node keys for the active step
    let view = { k: 1, tx: 0, ty: 0, minTx: 0, maxTx: 0 }; // tx range is for swiping
    let panX = 0; // reader's swipe offset (px), reset each step

    function extent(nodes) {
        return {
            x0: Math.min(...nodes.map((n) => n.x - n.w / 2)), x1: Math.max(...nodes.map((n) => n.x + n.w / 2)),
            y0: Math.min(...nodes.map((n) => n.y - n.h / 2)), y1: Math.max(...nodes.map((n) => n.y + n.h / 2)),
        };
    }

    function fit() {
        const { width: vw, height: vh } = svg.getBoundingClientRect();
        if (!vw || !vh) return;
        const shown = Object.values(NODES).filter((n) => n.s <= stage);
        const focused = phone.matches && focus ? focus.map((k) => NODES[k]).filter(Boolean) : [];

        if (focused.length) {
            const f = extent(focused), all = extent(shown);
            const pad = 10;
            const kW = (vw - pad * 2) / (f.x1 - f.x0);
            const kH = (vh - pad * 2) / (f.y1 - f.y0);
            const k = Math.min(kH, Math.max(kW, KMIN), 1);
            const tx = vw / 2 - ((f.x0 + f.x1) / 2) * k;
            const ty = pad + (vh - pad * 2 - (f.y1 - f.y0) * k) / 2 - f.y0 * k;
            // swipe range: far enough to bring either edge of the visible chart into view
            view = { k, tx, ty, minTx: Math.min(tx, vw - pad - all.x1 * k), maxTx: Math.max(tx, pad - all.x0 * k) };
        } else {
            const half = Math.max(...shown.map((n) => Math.abs(n.x - CENTER_X) + n.w / 2));
            const { y0 } = extent(shown);
            const y1 = extent(shown).y1 + (stage >= 4 ? 20 : 0);
            const pad = 32;
            const bottom = stage >= 2 ? 70 : pad; // room for the legend
            const k = Math.min((vw - pad * 2) / (half * 2), (vh - pad - bottom) / (y1 - y0), 1.8);
            const tx = vw / 2 - CENTER_X * k;
            view = { k, tx, ty: pad + (vh - pad - bottom - (y1 - y0) * k) / 2 - y0 * k, minTx: tx, maxTx: tx };
        }
        root.classList.toggle("can-pan", view.maxTx - view.minTx > 4);
        applyView();
    }

    function applyView() {
        const tx = Math.min(view.maxTx, Math.max(view.minTx, view.tx + panX));
        panX = tx - view.tx; // keep the offset clamped so swiping back responds right away
        scene.style.transform = `translate(${tx}px, ${view.ty}px) scale(${view.k})`;
    }

    // Swipe sideways to pan (phones). Vertical drags still scroll the page (touch-action: pan-y).
    let drag = null;
    svg.addEventListener("pointerdown", (e) => {
        if (!root.classList.contains("can-pan")) return;
        drag = { x: e.clientX, pan: panX, id: e.pointerId };
    });
    svg.addEventListener("pointermove", (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) < 4 && !root.classList.contains("is-panning")) return;
        root.classList.add("is-panning", "has-panned"); // no zoom transition while dragging
        panX = drag.pan + dx;
        applyView();
    });
    const endDrag = () => { drag = null; root.classList.remove("is-panning"); };
    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);
    phone.addEventListener("change", fit);

    // Mark the named path's nodes/edges (highlighted edges move above the rest)
    function setPath(name) {
        const edges = PATHS[name] || [];
        if (name && !PATHS[name]) console.warn(`No flow chart path named "${name}"`);
        const keys = new Set(edges.map(([a, b]) => `${a}>${b}`));
        const nodes = new Set(edges.flat());
        for (const [k, e] of Object.entries(edgeEls)) {
            const hot = keys.has(k);
            e.classList.toggle("on-path", hot);
            if (e.parentNode !== (hot ? pathLayer : edgeLayer)) (hot ? pathLayer : edgeLayer).appendChild(e);
        }
        for (const [k, g] of Object.entries(nodeEls)) g.classList.toggle("on-path", nodes.has(k));
        // Leaving a highlight (e.g. step 5 -> 4) also switches instantly: no fade/delay for a frame
        if (!edges.length && root.classList.contains("is-highlight")) {
            root.classList.add("no-anim");
            requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("no-anim")));
        }
        root.classList.toggle("is-highlight", edges.length > 0);
    }

    function setStage(n, highlight, focusKeys) {
        stage = n;
        focus = focusKeys;
        panX = 0;
        for (const it of items) it.el.classList.toggle("is-shown", it.s <= n);
        legend.classList.toggle("is-shown", n >= 2);
        setPath(highlight);
        fit();
    }

    // Legend icons
    const icon = (d, cls) => `<svg width="16" height="20" viewBox="-8 -10 16 20" aria-hidden="true"><path d="${d}" class="${cls}"/></svg>`;
    legend.innerHTML = `
        <li>${icon(BOLT, "icon-power")}Cooling power</li>
        <li>${icon(DROP, "icon-water")}On-site water</li>
        <li><svg width="22" height="20" viewBox="-12 -13 24 24" aria-hidden="true" class="flow-warn"><path d="${WARN}" stroke-linejoin="round"/><text y="4" dy="0.25em" text-anchor="middle">!</text></svg>Possible PFAS</li>
        <li><svg width="36" height="4" aria-hidden="true"><line x1="0" y1="2" x2="36" y2="2" class="flow-edge is-dashed" style="opacity:1"/></svg>Heat passed on</li>`;

    // First paint without the zoom animation
    scene.style.transition = "none";
    requestAnimationFrame(() => requestAnimationFrame(() => (scene.style.transition = "")));
    window.addEventListener("resize", fit);

    // ----- Back / Next -----
    const steps = [...root.querySelectorAll(".flow-step")];
    const prev = root.querySelector(".flow-prev");
    const next = root.querySelector(".flow-next");
    const count = root.querySelector(".flow-count");
    let current = 0;

    function goTo(i) {
        current = Math.max(0, Math.min(steps.length - 1, i));
        steps.forEach((s, j) => {
            s.hidden = j !== current;
            s.classList.toggle("is-active", j === current);
        });
        const d = steps[current].dataset;
        setStage(Number(d.stage) || 1, d.highlight, d.focus ? d.focus.split(",").map((k) => k.trim()) : null);
        prev.disabled = current === 0;
        next.disabled = current === steps.length - 1;
        count.textContent = `${current + 1} of ${steps.length}`;
    }

    prev.addEventListener("click", () => goTo(current - 1));
    next.addEventListener("click", () => goTo(current + 1));
    root.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") { goTo(current + 1); e.preventDefault(); }
        if (e.key === "ArrowLeft") { goTo(current - 1); e.preventDefault(); }
    });
    goTo(0);
})();
