# Decant Privacy Policy

**Last updated:** 07/31/2026

Decant is a Chrome extension that converts content to Markdown at the moment you send it to an LLM chat, to reduce token costs. It works in two directions: it intercepts file uploads to supported LLM chat interfaces and converts them before upload, and it captures the web page you are reading and delivers it to your chat as Markdown. This policy explains what data Decant touches, how it's processed, and what never leaves your device.

## Summary

Decant does not operate any servers, does not collect analytics, and does not sell or share your data with anyone. All file and page processing happens either locally in your browser or, optionally, on a companion process running on your own machine. The only place your data goes is the LLM chat service you were already about to send it to — in converted Markdown form instead of its original format.

## What Decant accesses

**File content you choose to upload.** When you upload a supported file (PDF, Word document, spreadsheet, etc.) on a site Decant is active on, Decant reads the file's content in order to convert it to Markdown before the upload completes.

**Chat page content on supported sites only.** Decant uses a default-deny activation model: it only runs on a specific whitelist of chat host names (claude.ai, chatgpt.com, gemini.google.com and www.perplexity.ai by default, plus any you add yourself), not on every website you visit. On those sites, Decant needs to read and interact with the page in order to detect file uploads and substitute the converted version.

**A page you explicitly capture.** When you invoke page capture — a toolbar click, the keyboard shortcut, or a context-menu pick — Decant reads that one page's rendered content, including its images, in order to convert it to Markdown. That read happens under Chrome's `activeTab` permission: the gesture *is* the grant. Decant holds no wildcard access to the sites you browse, cannot read a page before or after the gesture, and never reads a tab you did not invoke it on. Captured pages are not stored, and their content is not sent anywhere except the chat you chose.

**Settings.** Decant stores your configuration — which sites are enabled, your routing rules, your hotkey binding, whether page images are included, and similar preferences — using Chrome's sync storage. Chrome syncs this across the browsers where you're signed in to your Google account, the same way it syncs bookmarks and other extension settings. It is never sent to Decant or any server Decant operates. If you prefer to keep settings on a single device, turn off Chrome sync (or disable syncing for extensions).

**Two small device-local values.** Decant keeps a running total of estimated tokens saved (shown on the options page) and the host name of the enabled chat site that last received content — used only to pick the default destination for a capture when no chat tab is open. Both stay in local storage on that device and are never synced or transmitted. No document content, page content, file names, or browsing history is stored.

## How your data is processed

Decant routes each file through one of a few paths depending on file type:

- **In-browser conversion** — Digital-native PDFs and standard Office documents are parsed and converted entirely inside your browser, using open-source libraries (pdf.js, mammoth.js, SheetJS). This content never leaves your device during conversion.  
- **Local companion (optional)** — For scanned documents or files needing OCR or complex table recognition, Decant can hand off processing to an optional companion application running on your own computer, communicated with over localhost only. This is not a network request to any external server; it never leaves your machine.  
- **Passthrough** — For file types Decant doesn't handle, the original file is uploaded unmodified, exactly as it would be without the extension installed.

A captured page is processed the same way — entirely inside your browser. Decant reads the page as it is currently rendered, converts it to Markdown, and delivers the result into the composer of the chat you chose. The page you captured is never modified. If page images are switched on, they are attached alongside the Markdown as separate files (subject to a size cap); images the page won't share with the extension stay as plain URL references instead. In chats that accept no file attachment, the Markdown is placed on your clipboard so you can paste it — this overwrites whatever was on the clipboard, and nothing else reads it.

In no case does Decant send your file or page content to any server operated by Decant's developer, because no such server exists. (If you configure your own conversion endpoint in the options page, content goes to the address you entered and nowhere else.)

## What Decant does not do

- Decant does not run its own backend or collect telemetry.  
- Decant does not use third-party analytics, tracking, or advertising SDKs.  
- Decant does not sell, rent, or share your data with any third party.  
- Decant does not read or act on pages outside its host whitelist, except the single page you invoke a capture on.  
- Decant does not read pages in the background, follow you across sites, or record which pages you have captured.

## Permissions

Decant requests the minimum browser permissions needed for its two functions — detecting file uploads and substituting converted content on whitelisted host names, and reading one page when you ask it to. Beyond storage for your settings, that means `activeTab` (read the page you invoked capture on, once, because of that gesture), `scripting` (run Decant's own packaged code on enabled chat sites and on a captured page), and `contextMenus` plus a keyboard command (the capture controls themselves). Decant does not hold the `tabs` permission, and no permission is used to collect browsing history or activity on sites outside the whitelist. Adding a chat site on the options page requests that one origin only; disabling it revokes that access.

## Data retention

Because Decant does not transmit your file or page content anywhere Decant controls, there is nothing for Decant's developer to retain. Converted documents and captured pages exist only for the moment it takes to hand them to your chat; they are not written to storage. Your settings persist in Chrome's sync storage until you remove the extension or clear its data; if Chrome sync is on, they sync to your Google account like your other Chrome settings. The token counter and last-used chat host name persist in local storage on that device until you remove the extension.

## Changes to this policy

This policy will be updated to reflect any change in what Decant collects, processes, or transmits — including if a future version adds features that change these practices. The "Last updated" date above will be revised accordingly.

## Contact

Questions about this policy or Decant's data practices can be sent to: j.trachtenberg+decant@gmail.com

Source code: https://github.com/jtrachtenberg/decant  
