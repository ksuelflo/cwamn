// Simple tab switching for the site header
const tabs = Array.from(document.querySelectorAll(".site-tab"));

function activateTab(tab) {
    tabs.forEach(t => {
        const selected = t === tab;
        t.classList.toggle("is-active", selected);
        t.setAttribute("aria-selected", selected);
        t.tabIndex = selected ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !selected;
    });
}

tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => activateTab(tab));

    // Arrow keys move between tabs (standard tab keyboard behavior)
    tab.addEventListener("keydown", e => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        activateTab(next);
    });
});