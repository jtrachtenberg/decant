# Security Policy

Thank you for helping keep Decant secure.

Because Decant processes user documents and operates inside the browser, security and privacy are fundamental to the project. Responsible disclosure of security issues is greatly appreciated.

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, email:

**jtrachtenberg+security@gmail.com**

Please include as much of the following as possible:

- A description of the vulnerability
- Steps to reproduce it
- The affected version or commit
- Browser and operating system
- Any proof-of-concept code or screenshots (if appropriate)

I will acknowledge reports as soon as practical and work with you to understand, reproduce, and resolve the issue before public disclosure.

## Supported Versions

Decant is currently in active early development.

Security fixes are made against the latest version on the `main` branch. Older commits and development snapshots are not guaranteed to receive fixes.

## Security Model

Decant is designed around a **local-first** architecture.

By default:

- Document conversion happens locally on your machine.
- Documents are **not** uploaded to any third-party conversion service.
- Activation is default-deny: the extension runs only on hosts that are enabled
  in its options **and** granted host permission. Four chat hosts — claude.ai,
  chatgpt.com, gemini.google.com and www.perplexity.ai — ship enabled, and their
  permissions are granted at install; every other host must be enabled by the
  user, which asks the browser for that host's permission.
- In-browser conversion refuses oversized input before parsing it (a raw-size
  cap, and caps on the inflated size of Office packages) and passes such files
  through untouched.

Routing a file type to a user-configured endpoint (`http`/`companion` rules) is
always an explicit choice. The options page warns when such a rule points at a
non-local endpoint and asks for that endpoint's host permission; the background
relay only sends to endpoints named by a stored rule whose host permission is
granted. The warning is shown when the rule is added or imported, not again at
send time, and routing rules sync through the browser's storage to your other
devices.

### Trust boundaries

| Component | Trusts | Does not trust |
|---|---|---|
| **Web page** (chat host, captured page) | — | untrusted by every component below |
| **Content script** (isolated world, enabled hosts only) | its own config and the extension's background worker | page events that aren't `isTrusted`; the page's `postMessage` traffic beyond shape-checked picker-bridge messages, which only ever carry files the page already holds |
| **Main-world picker shim** (enabled hosts only) | nothing: it runs beside page script and only relays detached file picks to the content script | — |
| **Background service worker** | the stored, normalized config | a message's copy of a routing rule: it resolves the stored rule by endpoint and uses that |
| **Local companion** (`companion/`, optional) | requests that name it by loopback `Host`, carry no `Origin` or an extension's, and (when `DECANT_TOKEN` is set) the token | web-page origins (403), foreign `Host` headers (DNS rebinding), bodies over 64 MB; it sends no CORS headers |
| **CLI** (`decant`) | the input file and `--config` it is given | shared temp directories: the packaged binary unpacks its pdf.js assets into a fresh, private (0700) directory each run and removes it on exit |

**Page capture** (toolbar button, shortcut or context menu) injects the
serializer into the page you capture using `activeTab` — the click is the
grant — and fetches that page's images with the page's own credentials. The
captured Markdown reflects the page's content, including text the page may
hide from view; treat a capture of an untrusted page as untrusted input to the
chat.

## What to Report

Examples of security issues include:

- Arbitrary code execution
- Cross-site scripting (XSS)
- Privilege escalation
- Permission bypasses
- Data leakage between browser tabs or origins
- Document exfiltration
- Processing documents without the user's intent
- Circumventing the extension's host activation controls
- Supply-chain vulnerabilities introduced by dependencies

If you're unsure whether something qualifies as a security issue, please report it anyway.

## Scope

This policy covers the Decant repository and its officially maintained components.

Issues in third-party libraries (such as `pdf.js`, `mammoth.js`, or `SheetJS`) should also be reported upstream where appropriate.

## Coordinated Disclosure

Please give me a reasonable opportunity to investigate and fix a reported vulnerability before publicly disclosing it.

Once a fix is available, I intend to publicly acknowledge the issue and credit the reporter (if they would like to be credited).

Thank you for helping make Decant safer for everyone.
