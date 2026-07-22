// Context-menu model for page capture (SPEC §3.11).
//
// The toolbar click is the automatic path (capture → last-used chat); this menu
// is the override picker, built from the same enabled-hosts list the activation
// layer uses, so a site the user disabled can never be a capture target. Pure —
// the background turns these descriptors into contextMenus.create() calls.

export const MENU_PARENT_ID = "decant-capture";
export const MENU_PREFIX = "decant-capture:";

// Chat hosts render under the name users know them by; anything else falls
// back to its domain label, so a self-added host still reads sensibly.
const DISPLAY_NAMES = {
  "claude.ai": "Claude",
  "chatgpt.com": "ChatGPT",
  "gemini.google.com": "Gemini",
  "www.perplexity.ai": "Perplexity",
  "chat.mistral.ai": "Mistral",
  "chat.deepseek.com": "DeepSeek",
  "copilot.microsoft.com": "Copilot",
  "kimi.com": "Kimi",
  "grok.com": "Grok",
};

export function displayName(host) {
  const known = DISPLAY_NAMES[host];
  if (known) return known;
  const label = host.replace(/^www\./, "").split(".")[0] || host;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Menu descriptors for the enabled hosts. One host needs no submenu — a
// picker with a single choice is just a longer click.
export function menuItems(hosts) {
  if (!hosts.length) return [];
  const contexts = ["page", "selection", "link", "image"];
  if (hosts.length === 1) {
    return [
      {
        id: MENU_PREFIX + hosts[0],
        title: `Decant page to ${displayName(hosts[0])}`,
        contexts,
      },
    ];
  }
  return [
    { id: MENU_PARENT_ID, title: "Decant page to…", contexts },
    ...hosts.map((host) => ({
      id: MENU_PREFIX + host,
      parentId: MENU_PARENT_ID,
      title: displayName(host),
      contexts,
    })),
  ];
}

// The host a clicked menu id names, or null when the click wasn't ours.
export function hostFromMenuId(menuItemId) {
  const id = String(menuItemId ?? "");
  return id.startsWith(MENU_PREFIX) ? id.slice(MENU_PREFIX.length) : null;
}
