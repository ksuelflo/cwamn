// Welcome / how-to box
//  - Opens when the page loads, unless the visitor checked "Don't show this again"
//  - Closes with the X, the Esc key, or a click outside the box
//  - The (i) button above the zoom controls re-opens it any time
//  - The checkbox choice is remembered in this browser (localStorage)

const WELCOME_KEY = "cwa-mn-water-hide-welcome";

const welcome = document.getElementById("welcome");
const welcomeHide = document.getElementById("welcome-hide");

// localStorage can be blocked (private windows, strict privacy settings),
// so every read/write is wrapped; the box then simply shows each visit.
function welcomeHidden() {
    try { return localStorage.getItem(WELCOME_KEY) === "1"; }
    catch { return false; }
}

function setWelcomeHidden(hidden) {
    try {
        if (hidden) localStorage.setItem(WELCOME_KEY, "1");
        else localStorage.removeItem(WELCOME_KEY);
    } catch { /* not saved; nothing else to do */ }
}

function openWelcome() {
    welcomeHide.checked = welcomeHidden();   // reflect the saved choice, so it can be unchecked
    if (!welcome.open) welcome.showModal();
    welcome.focus();                         // focus the box, not the X (avoids a stray focus ring)
}

function closeWelcome() {
    welcome.close();
}

welcomeHide.addEventListener("change", () => setWelcomeHidden(welcomeHide.checked));
document.getElementById("welcome-close").addEventListener("click", closeWelcome);
document.getElementById("welcome-open").addEventListener("click", event => {
    event.stopPropagation();                 // the map treats clicks as "reset zoom"
    openWelcome();
});

// A click on the dimmed backdrop (outside the box) closes it
welcome.addEventListener("click", event => {
    if (event.target !== welcome) return;    // clicks on the content (checkbox, text) never close it
    const r = welcome.getBoundingClientRect();
    const inside = event.clientX >= r.left && event.clientX <= r.right &&
                   event.clientY >= r.top && event.clientY <= r.bottom;
    if (!inside) closeWelcome();
});

if (!welcomeHidden()) openWelcome();
// "Data & Methodology" link inside the box: close it and switch to that tab
document.getElementById("welcome-to-docs")?.addEventListener("click", event => {
    event.preventDefault();
    closeWelcome();
    document.getElementById("tab-data")?.click();
    window.scrollTo(0, 0);
});