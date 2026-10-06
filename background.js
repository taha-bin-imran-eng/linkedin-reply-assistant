// Service worker: starts drafts (toolbar icon, Alt+R, right-click), calls Groq, and keeps the
// content script present in LinkedIn tabs that were open before the extension was installed or updated.
import { FALLBACK_MODEL } from "./lib/defaults.js";
import { chatCompletionWithRetry } from "./lib/groq.js";
import { buildRequest, parseResponse } from "./lib/prompt.js";
import { loadSettings } from "./lib/settings.js";

const CONTENT_JS = ["content/linkedin-dom.js", "content/panel.js"];
const CONTENT_CSS = ["content/content.css"];
const LINKEDIN_TABS = "https://*.linkedin.com/*";

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "lra-draft",
    title: "Draft a reply with AI",
    contexts: ["selection", "editable", "page"],
    documentUrlPatterns: [LINKEDIN_TABS],
  });
  const tabs = await chrome.tabs.query({ url: LINKEDIN_TABS });
  await Promise.all(tabs.map((tab) => inject(tab.id).catch(() => {})));
  if (reason === "install" && !(await loadSettings()).apiKey) chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener((tab) => startDraft(tab).catch(() => {}));
chrome.commands.onCommand.addListener((command, tab) => command === "draft-reply" && startDraft(tab).catch(() => {}));
chrome.contextMenus.onClicked.addListener((info, tab) => info.menuItemId === "lra-draft" && startDraft(tab).catch(() => {}));

async function startDraft(tab) {
  if (!tab?.id || !isLinkedIn(tab.url)) return chrome.runtime.openOptionsPage();
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "LRA_TRIGGER" });
  } catch {
    // No content script in this tab yet (opened before install, or the extension was reloaded).
    await inject(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "LRA_TRIGGER" });
  }
}

async function inject(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_CSS });
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_JS });
}

function isLinkedIn(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com"));
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "LRA_DRAFT") {
    draft(msg.context, msg.options || {}).then(sendResponse, (err) =>
      sendResponse({ error: err.message || String(err), code: err.code || "ERROR" })
    );
    return true; // responding asynchronously
  }
  if (msg?.type === "LRA_OPEN_OPTIONS") chrome.runtime.openOptionsPage();
  return false;
});

async function draft(context, options) {
  const settings = await loadSettings();
  if (!settings.apiKey) {
    throw Object.assign(new Error("Add your Groq API key in Settings to start drafting."), { code: "NO_KEY" });
  }
  const { body, meta } = buildRequest(settings, context, options);
  const json = await chatCompletionWithRetry(settings.apiKey, body, FALLBACK_MODEL);
  const result = parseResponse(json, meta);
  const p = settings.profile;
  return {
    ...result,
    fallbackFrom: json._fallbackFrom || null,
    categories: meta.categories.map(({ id, label }) => ({ id, label })),
    profileIncomplete: !p.name.trim() || !(p.headline.trim() || p.skills.trim()),
  };
}
