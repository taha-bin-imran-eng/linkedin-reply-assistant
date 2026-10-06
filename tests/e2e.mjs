// End-to-end test: loads the real extension into headless Chrome, serves LinkedIn look-alike pages
// (tests/fixtures) at https://www.linkedin.com, and drives every way of starting a draft.
// Groq calls are intercepted: stubbed by default, or sent for real with --live.
//
//   node tests/e2e.mjs [--live --keyfile=PATH] [--headful] [--out=DIR]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, sleep, waitFor } from "./cdp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// LRA_EXT_DIR tests another copy, e.g. the unzipped release: LRA_EXT_DIR=path/to/linkedin-reply-assistant
const EXT = process.env.LRA_EXT_DIR || path.resolve(HERE, "..");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const LIVE = process.argv.includes("--live");
const OUT = arg("out") || fs.mkdtempSync(path.join(os.tmpdir(), "lra-e2e-"));
fs.mkdirSync(OUT, { recursive: true });
const FIXTURES = {
  "/feed/": "linkedin-feed.html",
  "/messaging/thread/2-abc/": "linkedin-messaging.html",
  "/jobs/search-results/": "linkedin-jobs.html",
};
const SETTINGS = {
  apiKey: "gsk_e2e_placeholder",
  model: "openai/gpt-oss-120b",
  profile: { name: "Alex Morgan", signature: "Best,\nAlex" },
};

const PANEL = "document.querySelector('#lra-panel-host').shadowRoot";
const groqRequests = [];
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `\n     ${detail}` : ""}`);
}

const { cdp, close } = await launchChrome({ headless: !process.argv.includes("--headful") });
try {
  // A LinkedIn tab that is already open before the extension is installed.
  const feed = await openLinkedInTab("/feed/");
  const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
  let sw = await attachServiceWorker(extId);
  await sw.evaluate(`chrome.storage.local.set(${JSON.stringify(SETTINGS)})`);

  const buttons = await waitFor(() => feed.evaluate(`document.querySelectorAll('.lra-draft-btn').length`), {
    what: "Draft buttons in the tab opened before install",
  });
  check("Draft button added to both chats in a tab opened before install", buttons === 2, `found ${buttons}`);
  check("No Draft button on the post's comment box", await feed.evaluate(`!document.querySelector('.comments-comment-box__form .lra-draft-btn')`));
  check("Draft button sits in the message toolbar", await feed.evaluate(`!!document.querySelector('#bubble-priya .msg-form__left-actions .lra-draft-btn')`));

  // --- Draft from the button in Priya's chat ------------------------------------------------
  let n = groqRequests.length;
  await feed.evaluate(`document.querySelector('#bubble-priya .lra-draft-btn').click()`);
  let panel = await waitForResult(feed, n);
  let req = groqRequests.at(-1);
  let user = req.messages[1].content;
  check("Reads the chat whose button was clicked, not the other one",
    /Conversation with Priya Nair \(Founder at ShipFast AI\)/.test(user) && !/Daniel/.test(user), user.slice(0, 300));
  check("Follow-on messages keep their sender", (user.match(/\] Priya Nair:/g) || []).length === 2, user);
  check("Requests strict JSON-schema output", req.response_format?.json_schema?.strict === true);
  check("Uses the profile name", /for Alex Morgan\./.test(req.messages[0].content));
  check("Panel shows the category", panel.badge === (LIVE ? panel.badge : "Promo / pitch"), panel.badge);
  check("Signature is appended", panel.draft.endsWith("Best,\nAlex"), JSON.stringify(panel.draft));
  check("Insert button names the chat", panel.insertLabel === "Insert into Priya's chat", panel.insertLabel);
  const priyaBox = await rect(feed, "#bubble-priya");
  check("Panel doesn't cover the chat it's drafting for", !overlaps(panel.rect, priyaBox), JSON.stringify({ panel: panel.rect, chat: priyaBox }));
  await screenshot(feed, "1-draft-panel.png");

  await clickPanel(feed, "[data-act=insert]");
  const boxes = await feed.evaluate(`({
    priya: document.querySelector('#bubble-priya .msg-form__contenteditable').innerText,
    daniel: document.querySelector('#bubble-daniel .msg-form__contenteditable').innerText,
    sendEnabled: !document.querySelector('#bubble-priya .msg-form__send-button').disabled,
    sent: window.__sent.length })`);
  check("Insert puts the whole reply in Priya's box", boxes.priya.includes(panel.draft.split("\n")[0]) && boxes.priya.includes("Best,"), JSON.stringify(boxes.priya));
  check("Keeps line breaks when inserting", boxes.priya.split("\n").filter(Boolean).length >= 3, JSON.stringify(boxes.priya));
  check("The other chat's box is untouched", boxes.daniel.trim() === "", JSON.stringify(boxes.daniel));
  check("LinkedIn sees the text (its Send button turns on)", boxes.sendEnabled);
  check("Nothing is sent", boxes.sent === 0);
  await screenshot(feed, "2-inserted.png");

  // --- Changing the category and tweaking --------------------------------------------------
  n = groqRequests.length;
  await feed.evaluate(`(() => { const s = ${PANEL}.querySelector('.cat'); s.value = 'networking'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  panel = await waitForResult(feed, n);
  req = groqRequests.at(-1);
  check("Changing the category forces it",
    JSON.stringify(req.response_format.json_schema.schema.properties.category.enum) === '["networking"]' &&
      /Use the "networking" category/.test(req.messages[1].content));

  n = groqRequests.length;
  await clickPanel(feed, '[data-text="Make it shorter."]');
  panel = await waitForResult(feed, n);
  user = groqRequests.at(-1).messages[1].content;
  check("Tweak chips revise the current draft", /MY CURRENT DRAFT/.test(user) && /CHANGES I WANT\nMake it shorter\./.test(user), user.slice(-400));

  // An override typed in the change box applies to this chat's drafts until it's cleared.
  await feed.evaluate(`${PANEL}.querySelector('.instr').value = 'Call me a Backend Engineer'`);
  n = groqRequests.length;
  await clickPanel(feed, "[data-act=apply]");
  await waitForResult(feed, n);
  user = groqRequests.at(-1).messages[1].content;
  check("Apply sends the override along with the current draft",
    /MY CURRENT DRAFT/.test(user) && /CHANGES I WANT\nCall me a Backend Engineer/.test(user), user.slice(-300));
  n = groqRequests.length;
  await clickPanel(feed, "[data-act=redo]");
  await waitForResult(feed, n);
  user = groqRequests.at(-1).messages[1].content;
  check("New draft keeps the override that's still in the box",
    !/MY CURRENT DRAFT/.test(user) && /CHANGES I WANT\nCall me a Backend Engineer/.test(user), user.slice(-300));
  n = groqRequests.length;
  await clickPanel(feed, '[data-text="Make it shorter."]');
  await waitForResult(feed, n);
  check("A chip carries the override too",
    /CHANGES I WANT\nMake it shorter\.\nCall me a Backend Engineer/.test(groqRequests.at(-1).messages[1].content));

  await feed.evaluate(`${PANEL}.querySelector('.draft').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }))`);
  check("Esc closes the panel", await feed.evaluate(`document.querySelector('#lra-panel-host').hidden`));

  // --- Toolbar icon / Alt+R with a highlight in Daniel's chat ---------------------------------
  await feed.evaluate(`(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('daniel-body'));
    getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
  n = groqRequests.length;
  await triggerFromBackground(sw, "https://www.linkedin.com/feed/*");
  panel = await waitForResult(feed, n);
  user = groqRequests.at(-1).messages[1].content;
  check("Toolbar/shortcut drafts for the chat holding the highlight",
    /Conversation with Daniel Reyes \(Recruiting Manager at Northbridge Talent Group\)/.test(user), user.slice(0, 300));
  check("Reads the InMail subject line", /Subject: JOB OPPORTUNITY FOR YOU!/.test(user));
  check("Keeps line breaks from the page", /TEXT I HIGHLIGHTED[^]*Hi Alex,\n\nI came across/.test(user), user);
  check("Marks their message as theirs via LinkedIn's class", /\] Daniel Reyes:/.test(user));
  check("A different chat starts without the previous chat's override",
    (await feed.evaluate(`${PANEL}.querySelector('.instr').value`)) === "" && !/CHANGES I WANT/.test(user));
  await clickPanel(feed, "[data-act=insert]");
  const afterSecond = await feed.evaluate(`({
    daniel: document.querySelector('#bubble-daniel .msg-form__contenteditable').innerText,
    priya: document.querySelector('#bubble-priya .msg-form__contenteditable').innerText })`);
  check("Second insert goes to Daniel's box", afterSecond.daniel.includes("Best,") && afterSecond.priya === boxes.priya);

  // --- Full messaging page, opened after install ------------------------------------------------
  const inbox = await openLinkedInTab("/messaging/thread/2-abc/");
  await waitFor(() => inbox.evaluate(`!!document.querySelector('.lra-draft-btn')`), { what: "Draft button on the messaging page" });
  check("Draft button on the full messaging page", true);
  n = groqRequests.length;
  await triggerFromBackground(sw, "https://www.linkedin.com/messaging/*");
  panel = await waitForResult(inbox, n);
  user = groqRequests.at(-1).messages[1].content;
  check("Messaging page: reads the title bar and profile card", /Conversation with Sarah Khan \(Talent Partner at Brightpath\)/.test(user), user.slice(0, 200));
  check("Recognises my own messages by name", /\] Me \(Alex Morgan\):/.test(user), user);
  check("Their messages keep their name", (user.match(/\] Sarah Khan:/g) || []).length === 2, user);
  check("No 'last message is mine' note when they wrote last", !/last message is mine/.test(user));
  await screenshot(inbox, "3-messaging-page.png");

  // --- Newer pages: chat pop-ups inside shadow roots and an iframe ---------------------------------
  const jobs = await openLinkedInTab("/jobs/search-results/");
  const OPEN = "document.querySelector('#interop-outlet').shadowRoot";
  const CLOSED = "window.__closedRoot";
  const FRAME = "document.getElementById('chat-frame').contentDocument";
  await waitFor(() => jobs.evaluate(`${OPEN}.querySelectorAll('.lra-draft-btn').length === 1`), { what: "Draft button in a shadow-root chat" });
  check("Draft button in a chat inside an open shadow root", true);
  check("It's styled inside the shadow root too", (await jobs.evaluate(`getComputedStyle(${OPEN}.querySelector('.lra-draft-btn')).color`)) === "rgb(10, 102, 194)");
  await waitFor(() => jobs.evaluate(`${CLOSED}.querySelectorAll('.lra-draft-btn').length === 1`), { what: "Draft button in a late closed-shadow-root chat" });
  check("Draft button in a chat inside a closed shadow root that loaded late", true);
  await waitFor(() => jobs.evaluate(`${FRAME}.querySelectorAll('.lra-draft-btn').length === 1`), { what: "Draft button in an iframe chat" });
  check("Draft button in a chat inside an iframe", true);

  n = groqRequests.length;
  await jobs.evaluate(`${OPEN}.querySelector('.lra-draft-btn').click()`);
  panel = await waitForResult(jobs, n);
  user = groqRequests.at(-1).messages[1].content;
  check("Shadow-root chat: reads the right conversation",
    /Conversation with Richard Hindmarch/.test(user) && /Following up on my previous message/.test(user), user.slice(0, 200));
  await clickPanel(jobs, "[data-act=insert]");
  check("Shadow-root chat: Insert fills its box and LinkedIn's Send turns on", await jobs.evaluate(`(() => {
    const form = ${OPEN}.querySelector('form');
    return form.querySelector('.msg-form__contenteditable').innerText.includes('Best,') && !form.querySelector('.msg-form__send-button').disabled;
  })()`));

  n = groqRequests.length;
  await jobs.evaluate(`${FRAME}.querySelector('.lra-draft-btn').click()`);
  panel = await waitForResult(jobs, n);
  check("Iframe chat: reads the right conversation", /Conversation with Omar Haddad/.test(groqRequests.at(-1).messages[1].content));
  const frameBox = await rect(jobs, "#chat-frame");
  check("Iframe chat: panel sits beside it", !overlaps(panel.rect, frameBox), JSON.stringify({ panel: panel.rect, chat: frameBox }));
  await clickPanel(jobs, "[data-act=insert]");
  check("Iframe chat: Insert fills its box", await jobs.evaluate(`${FRAME}.querySelector('.msg-form__contenteditable').innerText.includes('Best,')`));

  await jobs.evaluate(`${CLOSED}.querySelector('.msg-form__contenteditable').focus()`);
  n = groqRequests.length;
  await triggerFromBackground(sw, "https://www.linkedin.com/jobs/*");
  await waitForResult(jobs, n);
  check("Alt+R drafts for the focused chat inside a closed shadow root", /Conversation with Lena Fischer/.test(groqRequests.at(-1).messages[1].content));

  await jobs.evaluate(`(() => {
    const range = document.createRange();
    range.selectNodeContents(${OPEN}.querySelector('.msg-s-event-listitem__body'));
    const sel = ${OPEN}.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  })()`);
  n = groqRequests.length;
  await triggerFromBackground(sw, "https://www.linkedin.com/jobs/*");
  await waitForResult(jobs, n);
  user = groqRequests.at(-1).messages[1].content;
  check("A highlight inside a shadow-root chat drafts for that chat",
    /Conversation with Richard Hindmarch/.test(user) && /TEXT I HIGHLIGHTED/.test(user), user.slice(0, 300));
  await sleep(1800); // longer than the "Inserted ✓" confirmation from the iframe chat
  const insertButton = await jobs.evaluate(`(() => { const b = ${PANEL}.querySelector('[data-act=insert]'); return { label: b.textContent, green: b.classList.contains('ok') }; })()`);
  check("Insert button keeps naming the current chat after an earlier insert",
    insertButton.label === "Insert into Richard's chat" && !insertButton.green, JSON.stringify(insertButton));
  await screenshot(jobs, "6-jobs-page.png");

  // --- Missing API key -----------------------------------------------------------------------------
  await sw.evaluate(`chrome.storage.local.set({ apiKey: "" })`);
  await feed.evaluate(`document.querySelector('#bubble-daniel .lra-draft-btn').click()`);
  const err = await waitFor(async () => (await panelState(feed))?.error, { what: "missing-key error" });
  const errState = await panelState(feed);
  check("Missing key: clear error with a Settings button", /API key/.test(err) && errState.settingsVisible, err);
  await sw.evaluate(`chrome.storage.local.set({ apiKey: ${JSON.stringify(SETTINGS.apiKey)} })`);

  // --- Options page: profile and a custom category --------------------------------------------------
  const { targetId: optId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
  const options = await cdp.attach(optId);
  await options.send("Page.enable");
  await options.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => options.evaluate(`document.getElementById('name')?.value === 'Alex Morgan'`), { what: "options page with saved name" });
  check("Options page loads the saved profile", true);
  check("Lists the 9 built-in categories", (await options.evaluate(`document.querySelectorAll('.category').length`)) === 9);
  await options.evaluate(`(() => {
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    document.getElementById('btn-add-category').click();
    const card = document.querySelector('#categories .category:last-child');
    set(card.querySelector('.cat-label'), 'Speaking invite');
    set(card.querySelector('.cat-when'), 'Someone invites me to speak at an event or on a podcast.');
    set(card.querySelector('.cat-reply'), 'Thank them, say I would love to hear more, and ask for the date and format.');
    set(document.getElementById('skills'), 'Python and React');
    set(document.getElementById('minPay'), '$150k base');
    document.getElementById('btn-save').click();
  })()`);
  await waitFor(() => options.evaluate(`document.getElementById('save-status').textContent.startsWith('Saved')`), { what: "options saved" });
  const stored = await sw.evaluate(`chrome.storage.local.get(null)`);
  check("Custom category saved with an id", stored.categories?.some((c) => c.id === "speaking_invite" && c.label === "Speaking invite" && !c.builtIn));
  check("Profile edits saved", stored.profile?.skills === "Python and React" && stored.profile?.minPay === "$150k base");
  check("API key kept", stored.apiKey === SETTINGS.apiKey);
  await options.evaluate(`document.querySelector('.category').open = true`);
  await screenshot(options, "4-options.png", true);

  n = groqRequests.length;
  await feed.evaluate(`document.querySelector('#bubble-daniel .lra-draft-btn').click()`);
  panel = await waitForResult(feed, n);
  req = groqRequests.at(-1);
  check("Panel lists the technologies their message named", panel.tech.join(" ").includes("Python") && panel.tech.join(" ").includes("DAML"), panel.tech.join(", "));
  check("Technologies that are in my skills are ticked", panel.tech.includes("✓ Python") && panel.tech.includes("DAML"), panel.tech.join(", "));
  check("Two named technologies tell the model not to ask about the stack",
    /TECHNOLOGIES THEY NAMED: [^\n]*Python[^\n]*do not ask about the stack/.test(req.messages[1].content),
    req.messages[1].content.split("\n").find((l) => l.startsWith("TECHNOLOGIES")));
  await screenshot(feed, "5-tech-chips.png");
  check("New category is offered to the model",
    req.response_format.json_schema.schema.properties.category.enum.includes("speaking_invite") &&
      /\[speaking_invite\] Speaking invite\nUse when: Someone invites me/.test(req.messages[0].content));
  check("Profile placeholders are filled in templates", /my minimum \(\$150k base\)/.test(req.messages[0].content));

  // --- Re-injection (what happens after an update): the newest content script takes over ------------
  // (A real chrome.runtime.reload() can't be tested here: a CDP-loaded extension doesn't restart its worker.)
  await sw.evaluate(`chrome.tabs.query({ url: "https://www.linkedin.com/feed/*" }).then(([t]) =>
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content/linkedin-dom.js", "content/panel.js"] }))`);
  await waitFor(() => feed.evaluate(`document.querySelectorAll('.lra-draft-btn').length === 2`), { what: "buttons after re-injection" });
  n = groqRequests.length;
  await feed.evaluate(`document.querySelector('#bubble-priya .lra-draft-btn').click()`);
  panel = await waitForResult(feed, n);
  await sleep(500);
  check("Still works after the scripts are injected again", panel.result);
  check("Only one Draft button per chat after re-injection", (await feed.evaluate(`document.querySelectorAll('#bubble-priya .lra-draft-btn').length`)) === 1);
  check("Only one copy handles a click (one request, one panel)",
    groqRequests.length === n + 1 && (await feed.evaluate(`document.querySelectorAll('#lra-panel-host').length`)) === 1,
    `requests: ${groqRequests.length - n}`);
} catch (err) {
  check("Test run finished", false, err.stack || err.message);
} finally {
  await close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);

// ---- helpers ------------------------------------------------------------------------------------

async function openLinkedInTab(pathname) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const page = await cdp.attach(targetId);
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "https://www.linkedin.com/*" }] });
  page.on("Fetch.requestPaused", ({ requestId, request, resourceType }) => {
    const file = FIXTURES[new URL(request.url).pathname];
    const found = resourceType === "Document" && file;
    page.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: found ? 200 : 404,
      responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
      body: found ? fs.readFileSync(path.join(HERE, "fixtures", file)).toString("base64") : "",
    });
  });
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }); // headless tabs aren't focused otherwise
  await page.send("Page.navigate", { url: `https://www.linkedin.com${pathname}` });
  await waitFor(() => page.evaluate(`location.hostname === 'www.linkedin.com' && document.readyState === 'complete'`), { what: `${pathname} to load` });
  return page;
}

async function attachServiceWorker(extId) {
  const target = await waitFor(
    async () => (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`)),
    { what: "the extension's service worker" }
  );
  const sw = await cdp.attach(target.targetId);
  // The worker target can appear before its extension context is set up.
  await waitFor(
    async () => {
      try {
        return await sw.evaluate("typeof chrome !== 'undefined' && !!chrome.storage");
      } catch {
        return false;
      }
    },
    { what: "the service worker's extension context" }
  );
  await sw.send("Fetch.enable", { patterns: [{ urlPattern: "https://api.groq.com/*" }] });
  sw.on("Fetch.requestPaused", ({ requestId, request }) => {
    const raw = request.postData ?? Buffer.from((request.postDataEntries || []).map((e) => e.bytes || "").join(""), "base64").toString();
    const body = raw ? JSON.parse(raw) : null;
    if (body) groqRequests.push(body);
    if (LIVE) {
      const headers = Object.entries(request.headers)
        .filter(([k]) => k.toLowerCase() !== "authorization")
        .map(([name, value]) => ({ name, value }));
      headers.push({ name: "Authorization", value: `Bearer ${readKey()}` });
      sw.send("Fetch.continueRequest", { requestId, headers });
      return;
    }
    sw.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(stubbedGroqResponse(body))).toString("base64"),
    });
  });
  return sw;
}

function stubbedGroqResponse(body) {
  const user = body.messages.at(-1).content;
  const ids = body.response_format.json_schema.schema.properties.category.enum;
  const guess = /ShipFast/.test(user) ? "promo" : /NYC area/.test(user) ? "location_unclear" : "remote_role";
  const category = ids.includes(guess) ? guess : ids[0];
  const name = user.match(/Conversation with (\S+)/)?.[1] || "there";
  const revised = /MY CURRENT DRAFT/.test(user) ? ", revised" : "";
  const content = {
    facts: {
      their_first_name: name, company: null, role: null, work_arrangement: "unknown", job_location: null,
      can_i_work_from_there: "unclear", pay: null, pay_vs_my_minimum: "unknown", they_asked: [], my_questions: [{ topic: "compensation range", answered_by: null }], language: "English",
    },
    category,
    reason: "Stubbed response for the end-to-end test.",
    reply: `Hi ${name}, thanks for your message (stubbed ${category}${revised}).\nThis is the second line.`,
  };
  return {
    id: "e2e",
    object: "chat.completion",
    model: body.model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function panelState(page) {
  return page.evaluate(`(() => {
    const host = document.querySelector('#lra-panel-host');
    if (!host || host.hidden) return null;
    const s = host.shadowRoot;
    const shown = (sel) => !s.querySelector(sel).hidden;
    const r = s.querySelector('.card').getBoundingClientRect();
    return {
      result: shown('.result'),
      error: shown('.error') ? s.querySelector('.error-text').textContent : null,
      settingsVisible: !s.querySelector('.error [data-act=settings]').hidden,
      badge: s.querySelector('.badge').textContent,
      draft: s.querySelector('.draft').value,
      tech: [...s.querySelectorAll('.tech-chip')].map((c) => c.textContent),
      insertLabel: s.querySelector('[data-act=insert]').textContent,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    };
  })()`);
}

async function waitForResult(page, requestsBefore) {
  return waitFor(
    async () => {
      const state = await panelState(page);
      if (state?.error) throw new Error(`panel error: ${state.error}`);
      return groqRequests.length > requestsBefore && state?.result ? state : null;
    },
    { what: "a draft in the panel", timeout: LIVE ? 30000 : 10000 }
  );
}

function clickPanel(page, selector) {
  return page.evaluate(`${PANEL}.querySelector(${JSON.stringify(selector)}).click()`);
}

async function triggerFromBackground(sw, urlPattern) {
  // Same message the toolbar icon, Alt+R and the right-click menu send.
  await sw.evaluate(`chrome.tabs.query({ url: ${JSON.stringify(urlPattern)} }).then(([t]) => chrome.tabs.sendMessage(t.id, { type: "LRA_TRIGGER" }))`);
}

async function rect(page, selector) {
  return page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
}

function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

async function screenshot(page, name, fullPage = false) {
  const { data } = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
}

function readKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY.trim();
  const raw = fs.readFileSync(arg("keyfile") || path.join(os.homedir(), ".groq_api_key"), "utf8");
  return (raw.match(/gsk_[A-Za-z0-9]+/) || [raw.trim()])[0];
}
