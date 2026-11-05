// Data & Methodology tab: "On this page" links
//  - Clicking a link jumps (smoothly) to that section
//  - The link for the section you're reading is highlighted as you scroll

const docsLinks = Array.from(document.querySelectorAll(".docs-toc a"));
const docsSections = docsLinks.map(a => document.querySelector(a.getAttribute("href")));

function updateDocsToc() {
    const panel = document.getElementById("panel-data");
    if (!panel || panel.hidden) return;

    // Current section = the last one whose heading has scrolled past the top area
    const OFFSET = 120;
    let current = 0;
    docsSections.forEach((sec, i) => {
        if (sec && sec.getBoundingClientRect().top <= OFFSET) current = i;
    });

    // At the very bottom, the last section counts even if it's too short to reach the top
    const atBottom = window.scrollY > 0 &&
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    if (atBottom) current = docsSections.length - 1;

    docsLinks.forEach((a, i) => {
        a.classList.toggle("is-active", i === current);
        if (i === current) a.setAttribute("aria-current", "true");
        else a.removeAttribute("aria-current");
    });
}

let docsFrame = null;
window.addEventListener("scroll", () => {
    cancelAnimationFrame(docsFrame);
    docsFrame = requestAnimationFrame(updateDocsToc);
}, { passive: true });

// Clicking a link highlights it right away (the scroll then keeps it in sync)
docsLinks.forEach(a => a.addEventListener("click", () => {
    docsLinks.forEach(l => l.classList.toggle("is-active", l === a));
}));

// Refresh when the tab is opened (tabs.js just un-hides the panel)
document.getElementById("tab-data")?.addEventListener("click", () => requestAnimationFrame(updateDocsToc));

// "Data last updated" date, written by update_data.R
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

fetch(DATA_URL + "meta.json", { cache: "no-store" })
  .then(r => r.json())
  .then(meta => {
    const d = new Date(meta.last_updated + "T12:00:00");
    const month = d.toLocaleString("en-US", { month: "long" });
    const text = `${month} ${ordinal(d.getDate())}, ${d.getFullYear()}`;
    document.querySelectorAll(".data-updated").forEach(el => el.textContent = text);
  });

updateDocsToc();