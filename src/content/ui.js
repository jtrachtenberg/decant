// Decant — in-page prompt for ambiguous documents.
//
// promptConvertChoice(results) shows a small panel near the composer asking
// whether to convert a text-plus-charts document to Markdown or send the
// original, and resolves to "convert" or "original". The panel lives in a
// shadow root so the site's CSS can't reach it (and vice-versa). Dismissing it
// (Escape / click outside / the X) resolves to "original" — the safe default
// that never drops chart content.

const HOST_ID = "decant-prompt-host";

export function promptConvertChoice(results) {
  return new Promise((resolve) => {
    // Only one prompt at a time — replace any existing one.
    document.getElementById(HOST_ID)?.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: "open" });

    const names = results.map((r) => r.file.name);
    const charts = results.reduce((n, r) => n + (r.meta?.chartPages || 0), 0);
    const title =
      names.length === 1
        ? `“${names[0]}” looks like text with charts`
        : `${names.length} documents look like text with charts`;
    const detail = charts
      ? `Converting to Markdown saves tokens but drops ${charts} chart page${
          charts === 1 ? "" : "s"
        }. Send the original to keep the charts.`
      : `Converting to Markdown saves tokens but drops the charts. Send the original to keep them.`;

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
        <div class="row">
          <button class="primary" data-choice="convert">Convert to Markdown</button>
          <button class="secondary" data-choice="original">Send original</button>
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
