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
- Hosts must be explicitly enabled before the extension runs on them (default-deny activation).

Some future or optional features may allow routing documents to user-configured endpoints. Those features are always intended to require explicit user configuration, and Decant will warn before documents are sent to non-local endpoints.

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
