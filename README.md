# LinkedIn Reply Assistant (Chrome extension)

Drafts replies to your LinkedIn messages with Groq's `openai/gpt-oss-120b`. It reads the conversation, works out what kind of
message it is (remote role, hybrid/onsite role, promo pitch, …), and writes a reply from your profile and your templates.
It only ever fills in the message box. **It never sends anything**: you review the draft and press Send yourself.

## Install

1. **[Download the latest release](https://github.com/taha-bin-imran-eng/linkedin-reply-assistant/releases/latest/download/linkedin-reply-assistant.zip)**
   and unzip it into a folder you'll keep, e.g. `Documents\linkedin-reply-assistant`.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and pick the unzipped
   `linkedin-reply-assistant` folder (the one with `manifest.json` inside).
3. Settings open by themselves. Paste a free Groq API key from [console.groq.com/keys](https://console.groq.com/keys)
   and fill in **About you**.
4. Open any LinkedIn chat and click **✨ Draft**.

It's installed from GitHub rather than the Chrome Web Store, which is why Chrome needs Developer mode.

## Update

Download the new release and unzip it **over the same folder**, then click the reload icon on the extension's card in
`chrome://extensions`. Chrome keeps your settings because the folder stays the same. Unzipping somewhere new means
setting it up again. Open LinkedIn tabs pick up the new version by themselves.

## Drafting a reply

- Click **✨ Draft** in a chat's toolbar (next to the emoji button). It reads that conversation.
- Or press **Alt+R** (change it at `chrome://extensions/shortcuts`), or click the toolbar icon. It drafts for the chat you're
  in, or for the chat holding your highlighted text.
- Or highlight any text (a message, a profile, a post), right-click, and pick **Draft a reply with AI**.

Anything you've typed in the message box is treated as instructions, e.g. "ask if they sponsor visas".

**Tech mentioned**: the panel lists the technologies their message names (Python, TypeScript, Django, AWS, React, Next.js and
about 90 more), ticking the ones that appear in your skills. When a message names two or more, the reply won't ask about the
tech stack. Add anything niche under **Extra technologies to spot** in Settings.

The panel opens beside the chat. From there you can:
- **Category**: change it and the draft is rewritten for that category.
- **Shorter / Warmer / More formal / Ask for a call**, or type your own change and press **Apply**: revises the current
  draft, including your edits.
- **Override your profile for one reply** in that same box, e.g. "Call me a Full Stack Engineer" or "Only mention React,
  Node and AWS". It outranks your saved profile and stays in effect for that chat (new drafts, other categories) until you
  clear the box. A different chat starts empty, and Settings never change.
- **↻ New draft**: starts over.
- **Insert into …'s chat**: puts the text in that conversation's box (Ctrl+Enter). **Copy** copies it.
- **Details**: shows what the assistant read and what it concluded (work arrangement, location, pay, what's still unanswered).

## Settings

- **About you**: name, headline, skills, where you're based, where you can work, work preference, minimum pay, links,
  questions for recruiters and a signature. The assistant only states facts that appear here.
- **Writing style**: rules applied to every reply.
- **Categories and templates**: each category has a "use when" description and a reply template, and both can be edited.
  Turn categories off, reset built-in ones, or add your own. Templates can be instructions or a sample message, and can use:
  - from your profile: `{my_name}` `{my_first_name}` `{headline}` `{based_in}` `{work_regions}` `{work_preference}`
    `{min_pay}` `{links}` `{questions}`
  - from the conversation, filled in by the model: `{first_name}` `{company}` `{role}`

## Privacy

Your API key and settings stay in this browser (`chrome.storage.local`). When you draft, the conversation and your profile are
sent to Groq, and nowhere else. The extension only reads the chat you draft for, and only when you ask.

## Groq limits

The free plan allows about 8,000 tokens a minute per model, which is roughly 3 drafts a minute with gpt-oss-120b. When that
model is busy, the extension waits briefly or switches to gpt-oss-20b (it has its own limit) and says so in the panel.
Reasoning **Low** is the default. **Medium** is a little more careful but uses about three times the tokens.

## Troubleshooting

- **No ✨ Draft button**: LinkedIn may have changed its markup. Alt+R and highlight + right-click still work. Every selector
  is in `SEL` at the top of `content/linkedin-dom.js`.
- **"Refresh this LinkedIn tab"**: the extension was reloaded while the tab was open, so refresh it.
- **"Details" shows the wrong messages**: please report it with the conversation layout. Reading messages is the part that
  depends most on LinkedIn's markup.

## Project layout

```
manifest.json
background.js            service worker: toolbar icon, Alt+R, right-click menu, Groq calls
lib/defaults.js          default profile and built-in categories
lib/settings.js          loading, saving, migrating v1.1 settings
lib/prompt.js            builds the Groq request (strict JSON schema) and parses the reply
lib/tech.js              spots technology names in a message
lib/groq.js              Groq client with rate-limit retry and fallback
content/linkedin-dom.js  finds chats, reads messages, writes into the message box
content/panel.js         ✨ Draft buttons and the reply panel
options/                 settings page
icons/                   icon.svg and the PNGs Chrome uses
tests/                   unit tests, eval against Groq, end-to-end test in headless Chrome
tools/package.mjs        builds the release zip
docs/                    landing page (GitHub Pages)
```

## Releasing a new version

1. Bump `version` in `manifest.json`.
2. Run `node tools/package.mjs`. It builds `dist/linkedin-reply-assistant.zip` with only the extension's files and refuses
   to include anything that looks like an API key.
3. On GitHub, create a release tagged `vX.Y.Z` and attach that zip **without renaming it**, so the download link above and
   on the landing page (`docs/`) always gets the newest version.

## Tests (Node 22+)

```
node tests/unit.mjs                          # settings, prompt and parsing (no network)
node tests/e2e.mjs                           # loads the extension in headless Chrome against LinkedIn look-alike pages
node tests/eval.mjs --keyfile=PATH_TO_KEY    # 19 realistic conversations against Groq; takes a few minutes on the free plan
```

`e2e.mjs` stubs Groq unless you pass `--live --keyfile=PATH`. The key file holds just your `gsk_…` key. Keep it outside
this folder so it's never packaged or shared with the extension.

---

Built by [Taha Bin Imran](https://github.com/taha-bin-imran-eng).
