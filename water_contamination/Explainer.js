// =============================================================================
// "About this layer": each layer's preview ends with "… Read more +", which opens
// a popup with that layer's full text (the .explainer-full block in index.html).
// =============================================================================

const explainerDialog = document.getElementById("explainer-dialog");
const explainerTitle  = document.getElementById("explainer-dialog-title");
const explainerBody   = document.getElementById("explainer-dialog-body");

const explainerNames = { nitrate: "Nitrate", pfas: "PFAS", waterbodies: "Impaired waterbodies" };

document.querySelectorAll(".explainer-text").forEach(block => {
    const preview = block.querySelector(".explainer-preview");
    const full    = block.querySelector(".explainer-full");

    // Drop a final period so it doesn't read "sentence.…"
    const last = preview.lastChild;
    if (last.nodeType === Node.TEXT_NODE) last.textContent = last.textContent.trimEnd().replace(/\.$/, "");

    preview.insertAdjacentHTML("beforeend",
        '<span class="explainer-ellipsis">…</span> ' +
        '<button type="button" class="explainer-more" aria-haspopup="dialog">' +
        'Read more<span class="explainer-more-plus" aria-hidden="true">+</span></button>');

    preview.querySelector(".explainer-more").addEventListener("click", () => {
        explainerTitle.textContent = explainerNames[block.dataset.layer];
        explainerBody.innerHTML = full.innerHTML;
        explainerDialog.showModal();
        explainerDialog.focus();          // focus the box, not the X (no focus ring on open)
        explainerBody.scrollTop = 0;
    });
});

document.getElementById("explainer-close").addEventListener("click", () => explainerDialog.close());

// Clicking the dimmed area outside the box closes it (Esc also works)
explainerDialog.addEventListener("click", event => {
    if (event.target === explainerDialog) explainerDialog.close();
});