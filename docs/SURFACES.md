# Decant — Surfaces & expansion

Decant's core (see [ARCHITECTURE.md](./ARCHITECTURE.md)) is surface-agnostic:
`intercept → route → transform → substitute`. Only the intake layer — how a file
is captured and how the converted result is handed back — changes per surface.
This document maps the surfaces.

---

## Two paradigms

Every surface falls into one of two interaction models:

1. **Transparent interception** — the file is swapped invisibly mid-upload
   (browser extension; FUSE/WinFsp virtual filesystems). Feels seamless, but is
   fragile and must be rebuilt per surface.
2. **Sanctioned tool / provider** — the user or app explicitly invokes Decant
   through an OS- or app-blessed extension point (MCP tools, share sheets,
   document providers, File Provider extensions). Not invisible, but robust,
   portable, and sandbox-friendly.

The strategic consequence: outside browsers and Linux, the OS will not let you
transparently intercept file I/O — but it offers blessed hooks that reach the
same outcome (hand the app a converted file). So expansion is not "port a kernel
driver five times"; it's "use each surface's sanctioned intake."

---

## Surfaces

**Browser extension (current).** Manifest V3 interception. The transparent
paradigm. Implementation lives in [`SPEC.md`](../SPEC.md).

**Other browsers.** Firefox and Edge are near-identical WebExtensions — most code
ports directly. Safari requires wrapping as a Safari Web Extension (App Store
review, more friction). Lowest-effort expansion.

**Claude Desktop — MCP server (recommended next surface).** Sanctioned-tool
paradigm. Claude Desktop (Windows/macOS/Linux) installs MCP servers packaged as
MCP Bundles (`.mcpb`, formerly `.dxt`) via one-click UI. Instead of intercepting
an upload, expose a conversion tool (e.g. `decant_convert(path) → markdown`);
Claude calls it and receives clean Markdown. One server covers all three desktop
OSes at once, with no DOM/filesystem fragility. Node.js ships with Claude
Desktop, so a Node MCP server is the low-friction host; `.mcpb` cannot portably
bundle compiled Python deps (e.g. pydantic), so have the thin Node server shell
out to the existing Python companion over localhost rather than packaging Python.
The converter core is unchanged — MCP is just a new front door. Highest leverage
for the least effort; do this before any OS-level interception work.

**Windows native apps.** Three tiers, increasing cost:
(a) **Minifilter driver** (kernel-mode filesystem filter) — the "proper"
interception, as used by AV/backup/encryption tools. Real, but heavy: kernel
driver development, EV code-signing cert + Microsoft attestation signing, large
stability/security surface (bugs = BSOD), and rewriting file contents in-flight
is hard because apps often query size/metadata before reading bytes. Not a
starting point.
(b) **User-mode API hooking** (hook `IFileOpenDialog`/`CreateFile` via
Detours-style injection) — lighter but fragile, per-app, breaks on updates, and
trips antivirus/EDR.
(c) **Virtual filesystem via WinFsp** (FUSE-for-Windows) — files appear
already-converted at a virtual mount; user points the picker there. User-mode, no
kernel driver. Not transparent, but clean. Preferred if native Windows reach is
wanted.

**macOS.** Harder than Windows for interception: kexts are effectively dead; the
Endpoint Security framework (System Extension) is for monitoring, needs Apple
entitlements, and isn't built for content rewriting; SIP/sandboxing block dialog
hooking. Viable paths: macFUSE virtual filesystem or a File Provider extension —
same "virtual location" UX as WinFsp.

**Linux.** Friendliest for transparent interception. FUSE is first-class: present
converted versions of files transparently, no privileges, no signing.
Alternatively LD_PRELOAD to shim `open()`/`read()` for dynamically-linked apps
(fragile, unprivileged). Best place to prototype the "transparent interception"
dream.

**Android.** Sandboxed — no access to other apps' file I/O without root. Use the
Storage Access Framework: implement a DocumentsProvider that surfaces converted
files through the system file picker, or register as a share target (intent
filter) so the user shares a file → Decant converts → returns it. "Be a
provider," not "intercept."

**iOS.** Most locked down — no filesystem interception at all. Use a Share
Extension (share a file to Decant, get the converted one back) or a File Provider
extension (expose converted files in the Files app and every app's document
picker).

---

## Recommended sequence

1. Finish the browser surface (current work).
2. Add the MCP server / `.mcpb` bundle — covers all of Claude Desktop, every OS,
   for minimal effort; reuses the Python companion via a thin Node server.
3. Trivial Firefox/Edge ports of the browser extension.
4. Only if there's demand: native desktop via WinFsp/macFUSE/FUSE, then Android
   (DocumentsProvider/Share) and iOS (Share/File Provider).

Every surface above plugs into the same core; only intake changes. That reuse is
the payoff of the converter-interface boundary defined in
[ARCHITECTURE.md](./ARCHITECTURE.md).
