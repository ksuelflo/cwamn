// =============================================================================
// Three-bar menu on narrow screens: opens/closes the page tabs under the header.
// (On wide screens the button is hidden and the tabs show as usual.)
// =============================================================================

const siteHeader = document.querySelector(".site-header");
const navToggle = document.getElementById("nav-toggle");

function setNav(open) {
    siteHeader.classList.toggle("nav-open", open);
    navToggle.setAttribute("aria-expanded", open);
    navToggle.setAttribute("aria-label", open ? "Close menu" : "Menu");
}

navToggle.addEventListener("click", () => setNav(!siteHeader.classList.contains("nav-open")));

// Picking a page closes the menu
document.querySelectorAll(".site-tab").forEach(tab => tab.addEventListener("click", () => setNav(false)));

// Tapping anywhere else, or pressing Esc, closes it too
document.addEventListener("click", event => {
    if (!siteHeader.contains(event.target)) setNav(false);
});
document.addEventListener("keydown", event => {
    if (event.key === "Escape" && siteHeader.classList.contains("nav-open")) {
        setNav(false);
        navToggle.focus();
    }
});

// =============================================================================
// Remember the current page in the URL (?tab=map | explore | data), so a reload
// or a shared link opens the same page. replaceState: no extra Back-button steps.
// =============================================================================

const TAB_PARAMS = { "tab-map": "map", "tab-near-you": "explore", "tab-data": "data" };

document.querySelectorAll(".site-tab").forEach(tab => tab.addEventListener("click", () => {
    // The tabs are now switched for real, so the first-frame stand-in (see <head>) can go
    document.documentElement.removeAttribute("data-start-tab");

    const url = new URL(window.location.href);
    url.searchParams.set("tab", TAB_PARAMS[tab.id]);
    if (tab.id !== "tab-data") url.hash = "";          // #sec-... anchors only belong to Data & Methodology
    history.replaceState(null, "", url);
}));

// On load: open the page named in the URL
(function openTabFromUrl() {
    const param = new URLSearchParams(window.location.search).get("tab");
    const id = Object.keys(TAB_PARAMS).find(key => TAB_PARAMS[key] === param);
    if (!id) return;
    const hash = window.location.hash;                 // clicking the tab may clear it, so keep a copy
    document.getElementById(id).click();
    if (id === "tab-data" && hash) {
        history.replaceState(null, "", window.location.href.split("#")[0] + hash);
        document.querySelector(hash)?.scrollIntoView();   // the browser's own jump happened while the tab was hidden
    }
})();