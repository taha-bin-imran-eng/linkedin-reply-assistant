// Content script: adds a "Draft" button to LinkedIn message boxes and shows the reply panel.
// Drafting starts from that button, the toolbar icon, the Alt+R shortcut, or the right-click menu.
(() => {
  const DOM = globalThis.LRA_DOM;
  if (!DOM) return;

  // The newest copy of this script wins. After an extension update the old copy is orphaned,
  // so it steps aside and its buttons and panel are replaced.
  const INSTANCE = String(Math.random()).slice(2);
  const html = document.documentElement;
  html.dataset.lraInstance = INSTANCE;
  const isCurrent = () => html.dataset.lraInstance === INSTANCE;
  document.querySelector("#lra-panel-host")?.remove();
  for (const scope of DOM.scopes(true)) scope.querySelectorAll(".lra-draft-btn").forEach((el) => el.remove());

  const SPARKLE =
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M11 2.5l1.7 4.8 4.8 1.7-4.8 1.7L11 15.5 9.3 10.7 4.5 9l4.8-1.7zM18 13l.9 2.6 2.6.9-2.6.9L18 20l-.9-2.6-2.6-.9 2.6-.9z"/></svg>';

  // Same rules as content.css, for chats inside shadow roots and iframes that content.css can't reach.
  const BUTTON_CSS = `
    button.lra-draft-btn.lra-draft-btn { display: inline-flex; align-items: center; gap: 4px; height: 32px; margin: 0 2px;
      padding: 0 10px; border: 0; border-radius: 16px; background: transparent; color: #0a66c2;
      font: 600 14px/1 -apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; white-space: nowrap; cursor: pointer; }
    button.lra-draft-btn.lra-draft-btn:hover { background: rgba(10, 102, 194, 0.1); }
    button.lra-draft-btn.lra-draft-btn:focus-visible { outline: 2px solid #0a66c2; outline-offset: 1px; }
    button.lra-draft-btn.lra-draft-btn svg { width: 16px; height: 16px; flex: none; }`;

  let session = null; // the conversation being drafted for
  let lastOptions = {}; // what the last draft was asked for, so "Try again" repeats it
  let requestSeq = 0;
  let lastEditor = null;

  // Remembers the last message box used. The event's own target can be a shadow host, so ask where focus really is.
  function onFocusIn() {
    const target = DOM.deepActiveElement();
    if (isCurrent() && DOM.isEditor(target) && DOM.findConversationRoot(target)) lastEditor = target;
  }
  document.addEventListener("focusin", onFocusIn, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isCurrent() || msg?.type !== "LRA_TRIGGER") return false;
    startDraft({});
    sendResponse({ ok: true });
    return false;
  });

  // ---- Draft buttons ------------------------------------------------------------------------

  let scanTimer = null;
  const observer = new MutationObserver(() => {
    if (!isCurrent()) return observer.disconnect();
    if (!scanTimer) scanTimer = setTimeout(() => ((scanTimer = null), addButtons()), 400);
  });
  const watched = new WeakSet();
  addButtons();

  function addButtons() {
    watchScopes();
    for (const form of DOM.composeForms()) {
      if (form.querySelector(".lra-draft-btn")) continue;
      styleScope(form.getRootNode());
      const button = form.ownerDocument.createElement("button");
      button.type = "button";
      button.className = "lra-draft-btn";
      button.title = "Draft a reply with AI (Alt+R)";
      button.setAttribute("aria-label", "Draft a reply with AI");
      button.innerHTML = `${SPARKLE}<span>Draft</span>`;
      button.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isCurrent()) startDraft({ from: form });
      });
      DOM.buttonSlot(form).appendChild(button);
    }
  }

  // Page changes inside shadow roots and iframes don't reach an observer on the page, so watch each one.
  function watchScopes() {
    for (const scope of DOM.scopes()) {
      if (watched.has(scope)) continue;
      watched.add(scope);
      observer.observe(scope === document ? document.body : scope, { childList: true, subtree: true });
      if (scope !== document && scope.nodeType === Node.DOCUMENT_NODE) scope.addEventListener("focusin", onFocusIn, true);
    }
  }

  // content.css only styles the main page; shadow roots and iframes need their own copy.
  function styleScope(scope) {
    if (scope === document || scope.querySelector?.("style[data-lra]")) return;
    const style = (scope.ownerDocument || scope).createElement("style");
    style.dataset.lra = "";
    style.textContent = BUTTON_CSS;
    (scope.nodeType === Node.DOCUMENT_NODE ? scope.head || scope.documentElement : scope).appendChild(style);
  }

  // ---- Drafting -----------------------------------------------------------------------------

  async function startDraft({ from }) {
    const selection = readSelection();
    const open = DOM.openConversations();
    const root = pickConversation(from, selection, open);
    const ctx = DOM.extractContext(root, { selection: selection.text, profileName: await storedName() });
    session = { root, editor: DOM.findEditor(root), ctx, result: null };
    panel.open(root);
    if (!root && !ctx.selection) {
      panel.showError(
        open.length > 1
          ? "Several chats are open. Click ✨ Draft in the chat you want to answer."
          : "Open a LinkedIn conversation, or highlight the message you want to answer, then try again.",
        "NO_CONTEXT"
      );
      return;
    }
    requestDraft({});
  }

  function pickConversation(from, selection, open) {
    if (from) return DOM.findConversationRoot(from);
    const fromSelection = selection.node && DOM.findConversationRoot(selection.node);
    if (fromSelection) return fromSelection;
    const focused = DOM.deepActiveElement();
    const fromFocus = DOM.isEditor(focused) && DOM.findConversationRoot(focused);
    if (fromFocus) return fromFocus;
    if (DOM.isVisible(lastEditor)) return DOM.findConversationRoot(lastEditor);
    return open.length === 1 ? open[0] : null;
  }

  // Ignores selections inside a message box (that text is read as notes) or inside this panel.
  function readSelection() {
    const sel = DOM.currentSelection() || window.getSelection();
    const el = sel?.anchorNode?.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel?.anchorNode?.parentElement;
    if (!sel || sel.isCollapsed || DOM.isEditor(el) || el?.closest("#lra-panel-host")) return { text: "", node: null };
    return { text: sel.toString().trim(), node: sel.anchorNode };
  }

  async function storedName() {
    try {
      return (await chrome.storage.local.get("profile")).profile?.name || "";
    } catch {
      return "";
    }
  }

  async function requestDraft(options) {
    const id = ++requestSeq;
    lastOptions = options;
    panel.showLoading(options.previousDraft ? "Revising…" : "Drafting…");
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "LRA_DRAFT", context: session.ctx, options });
    } catch (err) {
      res = {
        error: /invalidated|receiving end|undefined/i.test(String(err?.message))
          ? "The extension was updated or reloaded. Refresh this LinkedIn tab to keep using it."
          : String(err?.message || err),
        code: "EXTENSION",
      };
    }
    if (id !== requestSeq || !session) return;
    if (!res || res.error) return panel.showError(res?.error || "No response from the extension.", res?.code);
    session.result = res;
    panel.showResult(session);
  }

  function insertDraft(text) {
    let editor = session.editor;
    if (!editor?.isConnected && session.root?.isConnected) editor = DOM.findEditor(session.root);
    return Boolean(editor) && DOM.insertIntoEditor(editor, text);
  }

  // ---- Panel --------------------------------------------------------------------------------

  const panel = (() => {
    let host = null;
    let shadow = null;
    let card = null;
    let movedTo = null; // set once the user drags the panel
    const $ = (sel) => shadow.querySelector(sel);

    function build() {
      host = document.createElement("div");
      host.id = "lra-panel-host";
      shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `<style>${CSS}</style>${TEMPLATE}`;
      card = $(".card");
      document.body.appendChild(host);
      // Keep LinkedIn's keyboard shortcuts from reacting to typing in the panel.
      for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (e) => e.stopPropagation());
      shadow.addEventListener("click", onClick);
      shadow.addEventListener("keydown", onKey);
      $(".draft").addEventListener("input", updateWordCount);
      $(".cat").addEventListener("change", (e) => requestDraft({ forcedCategory: e.target.value, instructions: note() }));
      $(".instr").addEventListener("keydown", (e) => {
        if (e.key === "Enter") applyChange($(".instr").value.trim());
      });
      enableDrag($(".hdr"));
      window.addEventListener("resize", () => host.isConnected && place());
    }

    // Whatever is typed in the change box applies to this chat's drafts until it's cleared:
    // a new draft or another category keeps it, a different chat starts empty.
    const note = () => $(".instr").value.trim() || undefined;

    function open(anchor) {
      if (!host?.isConnected) build();
      $(".instr").value = "";
      card.classList.toggle("dark", pageIsDark());
      host.hidden = false;
      place(anchor);
    }

    function close() {
      if (host) host.hidden = true;
      session = null;
      requestSeq++;
    }

    function show(section) {
      for (const s of ["status", "error", "result"]) $(`.${s}`).hidden = s !== section;
    }

    function showLoading(text) {
      $(".status-text").textContent = text;
      $(".badge").hidden = true;
      setContextLine();
      show("status");
      place();
    }

    function showError(message, code) {
      $(".error-text").textContent = message;
      $("[data-act=retry]").hidden = ["NO_CONTEXT", "NO_KEY", "EXTENSION"].includes(code);
      $(".error [data-act=settings]").hidden = !["NO_KEY", "BAD_KEY", "BAD_MODEL", "DAILY_LIMIT"].includes(code);
      show("error");
      place();
    }

    function showResult(s) {
      const r = s.result;
      const badge = $(".badge");
      badge.textContent = r.categoryLabel;
      badge.dataset.cat = r.category;
      badge.hidden = false;

      const select = $(".cat");
      select.replaceChildren(
        ...r.categories.map((c) => {
          const o = document.createElement("option");
          o.value = c.id;
          o.textContent = c.label;
          o.selected = c.id === r.category;
          return o;
        })
      );
      renderTech(r.tech);
      $(".reason").textContent = r.reason || "";
      const draft = $(".draft");
      draft.value = r.reply;
      updateWordCount();
      $(".model").textContent = r.fallbackFrom ? `${shortModel(r.model)} (${shortModel(r.fallbackFrom)} was busy)` : shortModel(r.model);
      $(".tip").hidden = !r.profileIncomplete;

      const who = s.ctx.participant?.name?.split(" ")[0];
      const insert = $("[data-act=insert]");
      endFlash(insert);
      endFlash($("[data-act=copy]"));
      insert.textContent = who ? `Insert into ${who}'s chat` : "Insert into chat";
      insert.disabled = !s.editor;
      insert.title = s.editor ? "Put this text in the message box (you still press Send)" : "No message box found. Use Copy instead.";
      setContextLine();
      renderDetails(s);
      show("result");
      place();
      draft.focus();
      draft.setSelectionRange(0, 0);
    }

    function setContextLine() {
      if (!session) return;
      const { participant, messages, rawTranscript, selection } = session.ctx;
      const parts = [];
      if (participant?.name) parts.push(`Replying to ${participant.name}`);
      if (messages.length) parts.push(`${messages.length} message${messages.length > 1 ? "s" : ""} read`);
      else if (rawTranscript) parts.push("read the chat's text");
      else if (participant?.name) parts.push("new conversation");
      if (selection) parts.push("using your highlight");
      $(".ctx-text").textContent = parts.join(" · ") || "Using your highlighted text";
    }

    // Technologies their message named, ticked when they're in your skills.
    function renderTech({ mentioned = [], mine = [] } = {}) {
      $(".tech").hidden = !mentioned.length;
      $(".tech-list").replaceChildren(
        ...mentioned.map((name) => {
          const chip = document.createElement("span");
          const known = mine.includes(name);
          chip.className = known ? "tech-chip mine" : "tech-chip";
          chip.textContent = known ? `✓ ${name}` : name;
          if (known) chip.title = "In your skills";
          return chip;
        })
      );
    }

    function renderDetails(s) {
      const f = s.result.facts || {};
      const label = {
        remote: "Remote", hybrid: "Hybrid", onsite: "Onsite", unknown: "Not stated", not_a_job: "Not a job",
        yes: "Yes", no: "No", unclear: "Unclear", not_applicable: "—", meets: "Meets your minimum",
        below: "Below your minimum",
      };
      const rows = [
        ["Work arrangement", label[f.work_arrangement] || "—"],
        ["Location", f.job_location || "—"],
        ["Can you work from there", label[f.can_i_work_from_there] || "—"],
        ["Pay", [f.pay, label[f.pay_vs_my_minimum]].filter((x) => x && x !== "—" && x !== "unknown").join(" · ") || "Not stated"],
        ["Still to ask", (f.my_questions || []).filter((q) => !q.answered_by).map((q) => q.topic).join("; ") || "Nothing"],
      ];
      $(".facts").replaceChildren(
        ...rows.flatMap(([k, v]) => {
          const dt = document.createElement("dt");
          dt.textContent = k;
          const dd = document.createElement("dd");
          dd.textContent = v;
          return [dt, dd];
        })
      );
      const { messages, rawTranscript, selection } = s.ctx;
      const read = messages.length
        ? messages.map((m) => `${m.me ? "Me" : m.from || "Them"}${m.time ? ` · ${m.time}` : ""}\n${m.subject ? `${m.subject}\n` : ""}${m.text}`).join("\n\n")
        : rawTranscript || "";
      $(".transcript").textContent = [read, selection && `Highlighted:\n${selection}`].filter(Boolean).join("\n\n") || "(nothing)";
    }

    function updateWordCount() {
      const n = $(".draft").value.split(/\s+/).filter(Boolean).length;
      $(".words").textContent = `${n} word${n === 1 ? "" : "s"}`;
    }

    function applyChange(instructions) {
      if (!session?.result || !instructions) return;
      const kept = note();
      if (kept && kept !== instructions) instructions = `${instructions}\n${kept}`;
      requestDraft({ forcedCategory: session.result.category, instructions, previousDraft: $(".draft").value });
    }

    async function onClick(e) {
      const btn = e.target.closest("[data-act]");
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      if (act === "close") close();
      else if (act === "settings") chrome.runtime.sendMessage({ type: "LRA_OPEN_OPTIONS" }).catch(() => {});
      else if (act === "retry") requestDraft(lastOptions);
      else if (act === "redo") requestDraft({ forcedCategory: session?.result?.category, instructions: note() });
      else if (act === "tweak") applyChange(btn.dataset.text);
      else if (act === "apply") applyChange($(".instr").value.trim());
      else if (act === "details") {
        const d = $(".details");
        d.hidden = !d.hidden;
        btn.textContent = d.hidden ? "Details" : "Hide details";
        place();
      } else if (act === "copy") {
        await copyText($(".draft").value);
        flash(btn, "Copied ✓");
      } else if (act === "insert") {
        if (insertDraft($(".draft").value)) flash(btn, "Inserted ✓");
        else {
          await copyText($(".draft").value);
          flash(btn, "Box not found, copied");
        }
      }
    }

    function onKey(e) {
      if (e.key === "Escape") close();
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !$(".result").hidden) $("[data-act=insert]").click();
    }

    // Shows a confirmation for a moment. A new draft cancels it (see endFlash), so an old chat's name never comes back.
    const flashes = new Map();
    function flash(btn, text) {
      endFlash(btn);
      const original = btn.textContent;
      btn.textContent = text;
      btn.classList.add("ok");
      flashes.set(btn, { original, timer: setTimeout(() => endFlash(btn), 1600) });
    }
    function endFlash(btn) {
      const f = flashes.get(btn);
      if (!f) return;
      clearTimeout(f.timer);
      flashes.delete(btn);
      btn.textContent = f.original;
      btn.classList.remove("ok");
    }

    // Beside the conversation (left, else right) so the chat and its Send button stay visible.
    let anchorEl = null;
    function place(anchor) {
      if (anchor !== undefined) anchorEl = anchor;
      const w = card.offsetWidth || 380;
      const h = card.offsetHeight || 420;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left;
      let top;
      if (movedTo) ({ left, top } = movedTo);
      else {
        const r = anchorEl?.isConnected ? DOM.rectOnPage(anchorEl) : null;
        if (r && r.width) {
          if (r.left - w - 12 >= 8) left = r.left - w - 12;
          else if (r.right + 12 + w <= vw - 8) left = r.right + 12;
          else left = r.left;
          top = r.bottom - h;
        } else {
          left = vw - w - 24;
          top = 72;
        }
      }
      host.style.left = `${Math.round(Math.min(Math.max(8, left), vw - w - 8))}px`;
      host.style.top = `${Math.round(Math.min(Math.max(8, top), vh - h - 8))}px`;
    }

    function enableDrag(handle) {
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button, select")) return;
        const start = { x: e.clientX, y: e.clientY, left: host.offsetLeft, top: host.offsetTop };
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          movedTo = { left: start.left + ev.clientX - start.x, top: start.top + ev.clientY - start.y };
          place();
        };
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
      });
    }

    return { open, showLoading, showError, showResult };
  })();

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }

  function pageIsDark() {
    const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    if (!rgb || rgb.length < 3 || rgb[3] === "0") return false;
    const [r, g, b] = rgb.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 90;
  }

  const shortModel = (id) => String(id || "").replace(/^openai\//, "");

  const TEMPLATE = `
    <div class="card" role="dialog" aria-label="LinkedIn reply assistant">
      <header class="hdr">
        <span class="title">Reply assistant</span>
        <span class="badge" hidden></span>
        <span class="spacer"></span>
        <button class="icon" data-act="settings" title="Settings" aria-label="Settings">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>
        </button>
        <button class="icon" data-act="close" title="Close (Esc)" aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z" transform="translate(1.4 0)"/></svg>
        </button>
      </header>
      <div class="body">
        <div class="ctx"><span class="ctx-text"></span><button class="link" data-act="details">Details</button></div>
        <div class="details" hidden>
          <dl class="facts"></dl>
          <div class="label">What the assistant read</div>
          <pre class="transcript"></pre>
        </div>
        <div class="status" hidden><span class="spinner" aria-hidden="true"></span><span class="status-text"></span></div>
        <div class="error" hidden>
          <p class="error-text"></p>
          <div class="row">
            <button class="btn" data-act="retry">Try again</button>
            <button class="btn" data-act="settings">Open settings</button>
          </div>
        </div>
        <div class="result" hidden>
          <div class="tech" hidden><span class="tech-label">Tech mentioned</span><span class="tech-list"></span></div>
          <div class="row cat-row">
            <label class="cat-label">Category <select class="cat"></select></label>
            <button class="btn ghost" data-act="redo" title="Write a new draft">↻ New draft</button>
          </div>
          <p class="reason"></p>
          <textarea class="draft" rows="7" spellcheck="true" aria-label="Draft reply"></textarea>
          <div class="meta"><span class="words"></span><span class="model"></span></div>
          <div class="chips">
            <button class="chip" data-act="tweak" data-text="Make it shorter.">Shorter</button>
            <button class="chip" data-act="tweak" data-text="Make it warmer and friendlier.">Warmer</button>
            <button class="chip" data-act="tweak" data-text="Make it more formal.">More formal</button>
            <button class="chip" data-act="tweak" data-text="Suggest a short call to discuss.">Ask for a call</button>
          </div>
          <div class="row">
            <input class="instr" type="text" placeholder="Any change, e.g. call me a Backend Engineer" aria-label="Describe a change or override your profile for this reply">
            <button class="btn ghost" data-act="apply">Apply</button>
          </div>
          <div class="row actions">
            <button class="btn primary" data-act="insert">Insert into chat</button>
            <button class="btn" data-act="copy">Copy</button>
          </div>
          <p class="tip" hidden>Tip: add your details in <button class="link" data-act="settings">Settings</button> for more personal replies.</p>
          <p class="foot">Nothing is sent until you press Send on LinkedIn. Ctrl+Enter inserts.</p>
        </div>
      </div>
    </div>`;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .card {
      --bg: #ffffff; --fg: #1d2226; --muted: #5e6a73; --line: #dfe3e6; --soft: #f3f6f8;
      --accent: #0a66c2; --accent-hover: #004182; --accent-soft: #e8f1fb; --ok: #057642; --err: #b42318;
      width: 380px; max-height: calc(100vh - 16px); display: flex; flex-direction: column;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.08);
      font: 14px/1.45 -apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .card.dark {
      --bg: #1d2226; --fg: #e9ecef; --muted: #a9b4bd; --line: #38434f; --soft: #283039;
      --accent: #71b7fb; --accent-hover: #a5d0fc; --accent-soft: #1f3a52; --ok: #5fd39b; --err: #ff8a80;
    }
    .hdr { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 14px; border-bottom: 1px solid var(--line); cursor: move; user-select: none; }
    .title { font-weight: 600; font-size: 14px; }
    .spacer { flex: 1; }
    .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--soft); color: var(--muted); white-space: nowrap; }
    .badge[data-cat="remote_role"] { background: #e6f4ea; color: #0b6b3a; }
    .badge[data-cat="location_unclear"], .badge[data-cat="remote_restricted"] { background: #fff4e0; color: #8a5300; }
    .badge[data-cat="non_remote_role"] { background: #fdeee6; color: #9a3412; }
    .badge[data-cat="promo"] { background: #fdecec; color: #a4161a; }
    .dark .badge { background: var(--soft); color: var(--fg); }
    .icon { display: inline-grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 50%; background: transparent; color: var(--muted); cursor: pointer; }
    .icon:hover { background: var(--soft); color: var(--fg); }
    .icon svg { width: 18px; height: 18px; }
    .body { padding: 10px 14px 12px; overflow: auto; }
    .ctx { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--muted); margin-bottom: 8px; }
    .link { border: 0; background: none; padding: 0; color: var(--accent); font: inherit; font-weight: 600; cursor: pointer; }
    .link:hover { text-decoration: underline; }
    .details { background: var(--soft); border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; font-size: 12px; }
    .facts { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0 0 8px; }
    .facts dt { color: var(--muted); }
    .facts dd { margin: 0; }
    .label { color: var(--muted); font-weight: 600; margin-bottom: 4px; }
    .transcript { margin: 0; max-height: 150px; overflow: auto; white-space: pre-wrap; font: 12px/1.4 inherit; font-family: inherit; }
    .status { display: flex; align-items: center; gap: 10px; padding: 18px 2px; color: var(--muted); }
    .spinner { width: 16px; height: 16px; border: 2px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error-text { margin: 4px 0 10px; color: var(--err); }
    .tech { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-bottom: 8px; font-size: 12px; }
    .tech-label { color: var(--muted); }
    .tech-chip { padding: 1px 8px; border-radius: 999px; background: var(--soft); border: 1px solid var(--line); }
    .tech-chip.mine { background: #e6f4ea; color: #0b6b3a; border-color: #b7dfc4; }
    .dark .tech-chip.mine { background: #14361f; color: #7fe0a6; border-color: #2c6b41; }
    .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
    .cat-row { margin-top: 0; justify-content: space-between; }
    .cat-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
    select, input, textarea { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; }
    select { padding: 3px 6px; font-size: 13px; max-width: 190px; }
    .reason { margin: 6px 0 8px; font-size: 12px; color: var(--muted); }
    .draft { display: block; width: 100%; padding: 8px 10px; line-height: 1.5; resize: vertical; min-height: 120px; }
    select:focus, input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
    .meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: 4px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .chip { border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 12px; cursor: pointer; }
    .chip:hover { border-color: var(--accent); color: var(--accent); }
    .instr { flex: 1; min-width: 0; padding: 6px 8px; font-size: 13px; }
    .btn { border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 999px; padding: 6px 14px; font: inherit; font-weight: 600; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .btn:hover { background: var(--soft); }
    .btn.ghost { border-color: transparent; color: var(--accent); padding: 6px 10px; }
    .btn.ghost:hover { background: var(--accent-soft); }
    .btn.primary { flex: 1; background: var(--accent); border-color: var(--accent); color: #fff; }
    .dark .btn.primary { color: #0b1a2a; }
    .btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn.ok { background: var(--ok); border-color: var(--ok); color: #fff; }
    .actions { margin-top: 12px; }
    .tip, .foot { margin: 8px 0 0; font-size: 11px; color: var(--muted); }
  `;
})();
