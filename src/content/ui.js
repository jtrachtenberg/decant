// Decant — in-page prompt for ambiguous documents.
//
// promptConvertChoice(results, { companion, figures }) shows a small panel
// near the composer asking what to do with a text-plus-charts document, and
// resolves to "convert" (in-browser Markdown, text only), "original", or the
// optional richer choices: "companion" (send to the local service, which can
// keep the visuals — when an endpoint is configured for the type) and
// "figures" (attach the converted text plus the document's own images as
// sibling files — when the type supports extraction, SPEC M3
// extract-and-reference). The panel lives in a shadow root so the site's CSS
// can't reach it (and vice-versa). Dismissing it (Escape / click outside /
// the X) resolves to "original" — the safe default that never drops chart
// content.

const HOST_ID = "decant-prompt-host";
const BADGE_ID = "decant-passthrough-badge";
const FAILURE_ID = "decant-attach-failure";
const CONVERTING_ID = "decant-converting-badge";
const SAVINGS_ID = "decant-savings-badge";

export function promptConvertChoice(results, options = {}) {
  const companion = !!options.companion;
  const figures = !!options.figures;
  return new Promise((resolve) => {
    // Only one prompt at a time — replace any existing one.
    document.getElementById(HOST_ID)?.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: "open" });

    const names = results.map((r) => r.file.name);
    // PDFs report chart pages, DOCX reports embedded images — one count.
    const visuals = results.reduce(
      (n, r) => n + (r.meta?.chartPages ?? r.meta?.images ?? 0),
      0
    );
    const count = visuals
      ? `${visuals} visual element${visuals === 1 ? "" : "s"}`
      : "the visuals";
    const title =
      names.length === 1
        ? `“${names[0]}” looks like text with charts or images`
        : `${names.length} documents look like text with charts or images`;
    const detail = companion
      ? `Converting to text saves tokens but drops ${count}. The local companion can convert it and keep them, or send the original untouched.`
      : figures
        ? `Converting to Markdown drops ${count} from the text — but they can ride along: attach the document's images as separate files next to the Markdown.`
        : `Converting to Markdown saves tokens but drops ${count}. Send the original to keep them.`;

    // Optional richer choices go first; whichever is available leads as the
    // recommended (primary) action. Three or more buttons stack for room;
    // without extras the original 2-button row is unchanged.
    const extras = [
      companion && ["companion", "Convert with companion"],
      figures && ["figures", "Convert + attach figures"],
    ].filter(Boolean);
    const convertLabel = extras.length
      ? "Convert to Markdown (text only)"
      : "Convert to Markdown";
    const choices = [
      ...extras,
      ["convert", convertLabel],
      ["original", "Send original"],
    ];
    const buttons = choices
      .map(
        ([choice, label], i) =>
          `<button class="${i === 0 ? "primary" : "secondary"}" data-choice="${choice}">${label}</button>`
      )
      .join("\n");
    const stack = choices.length > 2;

    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
          z-index: 2147483647; width: min(440px, calc(100vw - 32px));
          font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
          background: #1f1f23; color: #f3f3f3; border: 1px solid #3a3a42;
          border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.45);
          padding: 16px 16px 14px;
        }
        .brand { font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
          color: #9aa0aa; margin: 0 0 6px; }
        .title { font-size: 14px; font-weight: 600; margin: 0 0 4px; }
        .detail { font-size: 12.5px; line-height: 1.45; color: #c8ccd4; margin: 0 0 14px; }
        .row { display: flex; gap: 8px; }
        .row.stack { flex-direction: column; }
        button { flex: 1; font: inherit; font-size: 13px; font-weight: 600;
          padding: 9px 12px; border-radius: 8px; border: 1px solid transparent;
          cursor: pointer; }
        .primary { background: #6b5cff; color: #fff; }
        .primary:hover { background: #7d70ff; }
        .secondary { background: transparent; color: #e6e8ee; border-color: #4a4a54; }
        .secondary:hover { background: #2b2b31; }
        .x { position: absolute; top: 8px; right: 10px; background: none; border: none;
          color: #9aa0aa; font-size: 16px; cursor: pointer; flex: none; padding: 2px 6px; }
        .x:hover { color: #fff; }
      </style>
      <div class="wrap" role="dialog" aria-label="Decant conversion choice">
        <button class="x" data-choice="original" aria-label="Dismiss">✕</button>
        <p class="brand">Decant</p>
        <p class="title"></p>
        <p class="detail"></p>
        <div class="row ${stack ? "stack" : ""}">
          ${buttons}
        </div>
      </div>
    `;
    root.querySelector(".title").textContent = title;
    root.querySelector(".detail").textContent = detail;

    let done = false;
    const finish = (choice) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      host.remove();
      resolve(choice);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish("original");
      }
    };

    root.querySelectorAll("[data-choice]").forEach((btn) =>
      btn.addEventListener("click", () => finish(btn.dataset.choice))
    );
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(host);
  });
}

// Small persistent badge shown while the passthrough hotkey is armed. The
// "Esc to cancel" text is a clickable link that also cancels (calls onCancel).
// Returns a handle with remove(); styles live in a shadow root.
export function showPassthroughBadge(onCancel) {
  document.getElementById(BADGE_ID)?.remove();

  const host = document.createElement("div");
  host.id = BADGE_ID;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .badge {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647;
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
        font-size: 12.5px; font-weight: 600;
        background: #1f1f23; color: #f3f3f3; border: 1px solid #6b5cff;
        border-radius: 999px; padding: 7px 14px;
        box-shadow: 0 6px 24px rgba(0,0,0,.4);
        display: flex; align-items: center; gap: 8px;
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b5cff; }
      .sep { color: #9aa0aa; }
      .cancel {
        background: none; border: none; padding: 0; font: inherit; font-weight: 500;
        color: #9aa0aa; cursor: pointer;
        text-decoration: underline; text-underline-offset: 2px;
      }
      .cancel:hover { color: #fff; }
    </style>
    <div class="badge" role="status">
      <span class="dot"></span>
      <span>Decant: next upload sent as-is</span>
      <span class="sep">·</span>
      <button class="cancel" type="button">Esc to cancel</button>
    </div>
  `;
  root.querySelector(".cancel").addEventListener("click", () => onCancel?.());
  document.body.appendChild(host);
  return { remove: () => host.remove() };
}

// Progress badge shown while a file is being converted, so a slow (large-PDF)
// conversion doesn't look like a swallowed drop — the attached chip only
// appears once conversion resolves. Same shadow-root pattern as the
// passthrough badge; returns a handle with remove().
export function showConvertingBadge(fileName) {
  document.getElementById(CONVERTING_ID)?.remove();

  const host = document.createElement("div");
  host.id = CONVERTING_ID;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .badge {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647;
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
        font-size: 12.5px; font-weight: 600;
        background: #1f1f23; color: #f3f3f3; border: 1px solid #6b5cff;
        border-radius: 999px; padding: 7px 14px;
        box-shadow: 0 6px 24px rgba(0,0,0,.4);
        display: flex; align-items: center; gap: 8px;
      }
      .spinner {
        width: 10px; height: 10px; flex: none;
        border: 2px solid #3a3a42; border-top-color: #6b5cff;
        border-radius: 50%; animation: spin .8s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .msg { max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    </style>
    <div class="badge" role="status">
      <span class="spinner"></span>
      <span class="msg"></span>
    </div>
  `;
  root.querySelector(".msg").textContent = `Decant: converting “${fileName}”…`;
  document.body.appendChild(host);
  return { remove: () => host.remove() };
}

// Brief post-conversion badge showing the estimated token savings (the
// eliminated PDF page-image layer). Explicitly an estimate ("~"). Auto-
// dismisses; same shadow-root pattern. `savings` is aggregateSavings()'s
// result: { savedTokens, percent, files }.
const SAVINGS_TIMEOUT_MS = 6000;

function formatTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function showSavingsBadge(savings) {
  document.getElementById(SAVINGS_ID)?.remove();

  const host = document.createElement("div");
  host.id = SAVINGS_ID;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .badge {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647;
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
        font-size: 12.5px; font-weight: 600;
        background: #12241a; color: #eafff2; border: 1px solid #37b872;
        border-radius: 999px; padding: 7px 14px;
        box-shadow: 0 6px 24px rgba(0,0,0,.4);
        display: flex; align-items: center; gap: 8px;
      }
      .check { color: #37b872; flex: none; }
      .est { color: #7fbf9c; font-weight: 500; }
      .x {
        background: none; border: none; padding: 0 0 0 4px; font: inherit;
        color: #7fbf9c; cursor: pointer; flex: none;
      }
      .x:hover { color: #eafff2; }
    </style>
    <div class="badge" role="status">
      <span class="check">✓</span>
      <span class="msg"></span>
      <span class="est">est.</span>
      <button class="x" type="button" aria-label="Dismiss">✕</button>
    </div>
  `;
  const label =
    savings.percent >= 5
      ? `Decant saved ~${formatTokens(savings.savedTokens)} tokens (~${savings.percent}%)`
      : `Decant saved ~${formatTokens(savings.savedTokens)} tokens`;
  root.querySelector(".msg").textContent = label;
  const timer = setTimeout(() => host.remove(), SAVINGS_TIMEOUT_MS);
  root.querySelector(".x").addEventListener("click", () => {
    clearTimeout(timer);
    host.remove();
  });
  document.body.appendChild(host);
  return { remove: () => host.remove() };
}

// Visible failure notice for when injection finds no usable file input (e.g.
// the site re-rendered during conversion and the input is gone). Shown instead
// of silently dropping the attach; the user is asked to re-attach. Dismisses
// on the X or after a timeout — but a long one, since it reports data loss.
const FAILURE_TIMEOUT_MS = 15000;

export function showAttachFailureNotice(fileNames) {
  document.getElementById(FAILURE_ID)?.remove();

  const host = document.createElement("div");
  host.id = FAILURE_ID;
  const root = host.attachShadow({ mode: "open" });
  const label =
    fileNames.length === 1
      ? `Decant couldn't attach “${fileNames[0]}”`
      : `Decant couldn't attach ${fileNames.length} files`;
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .badge {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647;
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
        font-size: 12.5px; font-weight: 600;
        background: #2a1f1f; color: #f3f3f3; border: 1px solid #e05d5d;
        border-radius: 999px; padding: 7px 14px;
        box-shadow: 0 6px 24px rgba(0,0,0,.4);
        display: flex; align-items: center; gap: 8px;
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #e05d5d; flex: none; }
      .msg { max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .x {
        background: none; border: none; padding: 0 0 0 4px; font: inherit;
        color: #9aa0aa; cursor: pointer;
      }
      .x:hover { color: #fff; }
    </style>
    <div class="badge" role="alert">
      <span class="dot"></span>
      <span class="msg"></span>
      <button class="x" type="button" aria-label="Dismiss">✕</button>
    </div>
  `;
  root.querySelector(".msg").textContent = `${label} — please re-attach using the site's file picker (+/attach button).`;
  const timer = setTimeout(() => host.remove(), FAILURE_TIMEOUT_MS);
  root.querySelector(".x").addEventListener("click", () => {
    clearTimeout(timer);
    host.remove();
  });
  document.body.appendChild(host);
}
