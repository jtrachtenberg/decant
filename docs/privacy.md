# Decant Privacy Policy

**Last updated:** 07/01/2026

Decant is a Chrome extension that intercepts file uploads to supported LLM chat interfaces and converts them to Markdown before upload, to reduce token costs. This policy explains what data Decant touches, how it's processed, and what never leaves your device.

## Summary

Decant does not operate any servers, does not collect analytics, and does not sell or share your data with anyone. All file processing happens either locally in your browser or, optionally, on a companion process running on your own machine. The only place your data goes is the LLM chat service you were already about to upload it to — in converted Markdown form instead of its original format.

## What Decant accesses

**File content you choose to upload.** When you upload a supported file (PDF, Word document, spreadsheet, etc.) on a site Decant is active on, Decant reads the file's content in order to convert it to Markdown before the upload completes.

**Page content on supported sites only.** Decant uses a default-deny activation model: it only runs on a specific whitelist of host names (currently including claude.ai), not on every website you visit. On those sites, Decant needs to read and interact with the page in order to detect file uploads and substitute the converted version.

**Local settings.** Decant stores your configuration (which sites are enabled, routing preferences, etc.) using Chrome's local storage. This data stays on your device and is not transmitted anywhere.

## How your data is processed

Decant routes each file through one of a few paths depending on file type:

- **In-browser conversion** — Digital-native PDFs and standard Office documents are parsed and converted entirely inside your browser, using open-source libraries (pdf.js, mammoth.js, SheetJS). This content never leaves your device during conversion.  
- **Local companion (optional)** — For scanned documents or files needing OCR or complex table recognition, Decant can hand off processing to an optional companion application running on your own computer, communicated with over localhost only. This is not a network request to any external server; it never leaves your machine.  
- **Passthrough** — For file types Decant doesn't handle, the original file is uploaded unmodified, exactly as it would be without the extension installed.

In no case does Decant send your file content to any server operated by Decant's developer, because no such server exists.

## What Decant does not do

- Decant does not run its own backend or collect telemetry.  
- Decant does not use third-party analytics, tracking, or advertising SDKs.  
- Decant does not sell, rent, or share your data with any third party.  
- Decant does not read or act on pages outside its host whitelist.

## Permissions

Decant requests the minimum browser permissions needed for its core function — detecting file uploads and substituting converted content on whitelisted host names, plus local storage for your settings. Permissions are not used to collect browsing history or activity on sites outside the whitelist.

## Data retention

Because Decant does not transmit your file content anywhere Decant controls, there is nothing for Decant's developer to retain. Your local settings persist in Chrome's storage until you remove the extension or clear its data.

## Changes to this policy

This policy will be updated to reflect any change in what Decant collects, processes, or transmits — including if a future version adds features that change these practices. The "Last updated" date above will be revised accordingly.

## Contact

Questions about this policy or Decant's data practices can be sent to: j.trachtenberg+decant@gmail.com

Source code: https://github.com/jtrachtenberg/decant  
