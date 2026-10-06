// LinkedIn DOM adapter: finds conversations, reads their messages, and writes into the message box.
// LinkedIn changes its markup from time to time, so every selector lives in SEL. When structured
// reading finds nothing, the conversation's visible text is used instead.
(() => {
  const SEL = {
    composeForm: "form.msg-form",
    editor: ".msg-form__contenteditable[contenteditable='true'], div[contenteditable='true'][role='textbox'], textarea.msg-form__textarea",
    toolbar: [".msg-form__left-actions", ".msg-form__footer"], // first match wins
    conversationRoot: ".msg-overlay-conversation-bubble, .msg-convo-wrapper, .msg-thread",
    messageList: ".msg-s-message-list, .msg-s-message-list-content",
    event: ".msg-s-message-list__event",
    eventItem: ".msg-s-event-listitem",
    senderName: ".msg-s-message-group__name",
    timestamp: ".msg-s-message-group__timestamp",
    dayHeading: ".msg-s-message-list__time-heading",
    body: ".msg-s-event-listitem__body",
    subject: ".msg-s-event-listitem__subject",
    otherPersonItem: ".msg-s-event-listitem--other",
    headerName:
      ".msg-overlay-bubble-header__title, .msg-entity-lockup__entity-title, .msg-thread__link-to-profile, #thread-detail-jump-target",
    profileCard: ".msg-s-profile-card",
    profileCardName: ".msg-s-profile-card .artdeco-entity-lockup__title",
    profileCardHeadline: ".msg-s-profile-card .artdeco-entity-lockup__subtitle",
    myPhoto: "img.global-nav__me-photo",
  };
  const LIMITS = { messages: 15, messageChars: 2500, totalChars: 7000, selection: 3000, notes: 1500, raw: 6000 };
  const UI_LINE = /^(send|write a message(…|\.\.\.)?|press enter to send|attach( a file| an image)?|gif|open emoji keyboard|maximize|minimize|close|more options|seen|typing…?)$/i;

  const clip = (text, max) => (text && text.length > max ? `${text.slice(0, max)}…` : text || "");
  const multiLine = (el) => (el?.innerText || el?.textContent || "").replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const oneLine = (el) =>
    (multiLine(el).split("\n").find((l) => l.trim()) || "")
      .replace(/\s+/g, " ")
      .replace(/\s*[·•]\s*(1st|2nd|3rd\+?)\b.*$/i, "")
      .trim();
  const isVisible = (el) => Boolean(el?.isConnected && el.getClientRects().length > 0);

  // Newer LinkedIn pages (the jobs search, for one) render the chat pop-ups inside a shadow root or a
  // same-origin iframe, where document.querySelectorAll can't see them. Every lookup searches those too.
  const HOST_HINT = /outlet|shadow|interop|overlay|msg|messag|chat/i;
  let scopeCache = { at: 0, list: [document] };

  function scopes(fresh = false) {
    if (!fresh && Date.now() - scopeCache.at < 1000) return scopeCache.list;
    const list = [];
    const visit = (scope) => {
      if (list.includes(scope)) return;
      list.push(scope);
      const walker = (scope.ownerDocument || scope).createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
      for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        if (el.id === "lra-panel-host") continue; // our own panel
        const shadow = el.shadowRoot || closedShadowRoot(el);
        if (shadow) visit(shadow);
        if (el.tagName === "IFRAME") {
          try {
            if (el.contentDocument?.body) visit(el.contentDocument);
          } catch {} // cross-origin frame
        }
      }
    };
    visit(document);
    scopeCache = { at: Date.now(), list };
    return list;
  }

  // Closed shadow roots are only reachable through the extension API, so only likely hosts are asked.
  function closedShadowRoot(el) {
    if (!globalThis.chrome?.dom?.openOrClosedShadowRoot) return null;
    const hint = `${el.id} ${el.getAttribute("data-testid") || ""}`;
    if (el.parentElement !== el.ownerDocument.body && !HOST_HINT.test(hint)) return null;
    try {
      return chrome.dom.openOrClosedShadowRoot(el);
    } catch {
      return null;
    }
  }

  const queryAll = (selector, fresh = false) => scopes(fresh).flatMap((scope) => [...scope.querySelectorAll(selector)]);

  // A selection inside a shadow root or iframe belongs to that scope, so check the innermost first.
  function currentSelection() {
    for (const scope of [...scopes()].reverse()) {
      const sel = scope.getSelection?.();
      if (sel && !sel.isCollapsed && sel.rangeCount && (scope === document || scope.contains(sel.anchorNode))) return sel;
    }
    return null;
  }

  // The focused element, followed into shadow roots (even closed ones) and same-origin iframes.
  // Focus events can't tell us this for closed roots: they only report the host element.
  function deepActiveElement() {
    let el = document.activeElement;
    for (let depth = 0; el && depth < 10; depth++) {
      const root = el.shadowRoot || globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el);
      let inner = root?.activeElement;
      if (!inner && el.tagName === "IFRAME") {
        try {
          inner = el.contentDocument?.activeElement;
        } catch {} // cross-origin frame
      }
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // Position on the top page, adding the offset of any iframe the element sits in.
  function rectOnPage(el) {
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    for (let win = el.ownerDocument.defaultView; win && win !== window && win.frameElement; win = win.parent) {
      const frame = win.frameElement.getBoundingClientRect();
      left += frame.left;
      top += frame.top;
    }
    return { left, top, right: left + r.width, bottom: top + r.height, width: r.width, height: r.height };
  }

  function findConversationRoot(node) {
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!el) return null;
    const known = el.closest(SEL.conversationRoot);
    if (known) return includeEditor(known);
    // Unknown markup: the nearest ancestor that holds a message list and exactly one message box.
    for (let n = el; n && n !== n.ownerDocument.body; n = n.parentElement) {
      const editors = n.querySelectorAll(SEL.editor).length;
      if (editors > 1) return null;
      if (editors === 1 && n.querySelector(SEL.messageList)) return n;
    }
    return null;
  }

  // The message box can sit just outside the element we matched; widen a little to include it.
  function includeEditor(root) {
    for (let n = root, i = 0; n && n !== n.ownerDocument.body && i < 4; n = n.parentElement, i++) {
      const editors = n.querySelectorAll(SEL.editor).length;
      if (editors === 1) return n;
      if (editors > 1) break;
    }
    return root;
  }

  function openConversations() {
    const roots = new Set();
    for (const editor of queryAll(SEL.editor, true)) {
      if (!isVisible(editor)) continue;
      const root = findConversationRoot(editor);
      if (root) roots.add(root);
    }
    return [...roots];
  }

  // Runs on every page change, so it only looks inside known chat containers (no ancestor walks).
  function composeForms() {
    const forms = new Set(queryAll(SEL.composeForm));
    for (const root of queryAll(SEL.conversationRoot)) {
      const form = root.querySelector(SEL.editor)?.closest("form");
      if (form) forms.add(form);
    }
    return [...forms];
  }

  const buttonSlot = (form) => SEL.toolbar.map((s) => form.querySelector(s)).find(Boolean) || form;
  const findEditor = (root) => root?.querySelector(SEL.editor) || null;
  const isEditor = (node) => Boolean((node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest(SEL.editor));

  function getMyName() {
    const alt = document.querySelector(SEL.myPhoto)?.getAttribute("alt") || "";
    return alt.replace(/^photo of\s+/i, "").trim();
  }

  function normalizeName(s) {
    return String(s || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sameName(a, b) {
    const x = normalizeName(a).split(" ");
    const y = normalizeName(b).split(" ");
    if (!x[0] || !y[0]) return false;
    if (x.join(" ") === y.join(" ")) return true;
    return x.length > 1 && y.length > 1 && x[0] === y[0] && x.at(-1) === y.at(-1);
  }

  // true = mine, false = theirs, null = unknown (the model then sees the sender's name).
  function isMine(event, sender, names) {
    if (event.matches(SEL.otherPersonItem) || event.querySelector(SEL.otherPersonItem)) return false;
    if (sender && names.mine.some((n) => sameName(n, sender))) return true;
    if (sender && names.theirs && sameName(names.theirs, sender)) return false;
    return null;
  }

  function readMessages(list, names) {
    let events = list.querySelectorAll(SEL.event);
    if (!events.length) events = list.querySelectorAll(SEL.eventItem);
    const messages = [];
    let sender = "";
    let time = "";
    let day = "";
    for (const event of events) {
      // Consecutive messages from one person share a single name/time header, so carry them forward.
      const dayEl = event.querySelector(SEL.dayHeading);
      if (dayEl) day = oneLine(dayEl);
      const nameEl = event.querySelector(SEL.senderName);
      if (nameEl) sender = oneLine(nameEl);
      const timeEl = event.querySelector(SEL.timestamp);
      if (timeEl) time = oneLine(timeEl);

      const subject = oneLine(event.querySelector(SEL.subject));
      const text = [...event.querySelectorAll(SEL.body)].map(multiLine).filter(Boolean).join("\n");
      if (!text && !subject) continue;
      messages.push({
        from: sender,
        me: isMine(event, sender, names),
        time: [day, time].filter(Boolean).join(" "),
        subject,
        text: clip(text, LIMITS.messageChars),
      });
    }
    return messages;
  }

  // Keep the newest messages within the size limits.
  function trimMessages(messages) {
    const kept = messages.slice(-LIMITS.messages);
    let total = kept.reduce((n, m) => n + m.text.length + m.subject.length, 0);
    while (kept.length > 1 && total > LIMITS.totalChars) {
      const dropped = kept.shift();
      total -= dropped.text.length + dropped.subject.length;
    }
    return kept;
  }

  function readRawText(scope, root) {
    let text = multiLine(scope);
    for (const el of root.querySelectorAll(`${SEL.profileCard}, form, header`)) {
      const part = multiLine(el);
      if (part) text = text.replace(part, "");
    }
    text = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !UI_LINE.test(l))
      .join("\n");
    return text.length > LIMITS.raw ? `…${text.slice(-LIMITS.raw)}` : text;
  }

  function readParticipant(root) {
    const name = oneLine(root.querySelector(SEL.headerName)) || oneLine(root.querySelector(SEL.profileCardName));
    const headline = oneLine(root.querySelector(SEL.profileCardHeadline));
    return name ? { name, headline } : null;
  }

  function extractContext(root, { selection = "", profileName = "" } = {}) {
    const navName = getMyName();
    const participant = root ? readParticipant(root) : null;
    const editor = findEditor(root);
    const list = root?.querySelector(SEL.messageList);
    let messages = [];
    let rawTranscript = "";
    if (root) {
      messages = list ? trimMessages(readMessages(list, { mine: [profileName, navName].filter(Boolean), theirs: participant?.name })) : [];
      if (!messages.length) {
        const raw = readRawText(list || root, root);
        if (raw.length > 40 || !list) rawTranscript = raw;
      }
    }
    return {
      participant,
      messages,
      rawTranscript,
      selection: clip(selection, LIMITS.selection),
      myNotes: clip(editor ? multiLine(editor) : "", LIMITS.notes),
      myName: profileName || navName || "",
    };
  }

  function insertIntoEditor(editor, text) {
    if (!editor?.isConnected) return false;
    // The box may live in an iframe or shadow root, so use its own document and selection.
    const doc = editor.ownerDocument;
    editor.focus();
    if (editor.tagName === "TEXTAREA") {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(editor, text);
      editor.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      return true;
    }
    const range = doc.createRange();
    range.selectNodeContents(editor);
    const selection = editor.getRootNode().getSelection?.() || doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    let ok = false;
    try {
      ok = doc.execCommand("insertText", false, text);
    } catch {
      ok = false;
    }
    const probe = (s) => s.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!ok || !probe(multiLine(editor)).startsWith(probe(text).slice(0, 20))) {
      // execCommand was refused: write paragraphs the way LinkedIn's editor stores them.
      editor.replaceChildren(
        ...text.split("\n").map((line) => {
          const p = doc.createElement("p");
          if (line) p.textContent = line;
          else p.appendChild(doc.createElement("br"));
          return p;
        })
      );
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    }
    return multiLine(editor).length > 0;
  }

  globalThis.LRA_DOM = {
    SEL,
    scopes,
    currentSelection,
    deepActiveElement,
    rectOnPage,
    findConversationRoot,
    openConversations,
    composeForms,
    buttonSlot,
    findEditor,
    isEditor,
    isVisible,
    extractContext,
    insertIntoEditor,
    sameName,
  };
})();
