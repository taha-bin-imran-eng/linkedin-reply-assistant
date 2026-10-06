import {
  BUILT_IN_CATEGORIES,
  DEFAULT_PROFILE,
  MESSAGE_PLACEHOLDERS,
  MODELS,
  PROFILE_PLACEHOLDERS,
  REASONING_LEVELS,
} from "../lib/defaults.js";
import { listModels } from "../lib/groq.js";
import { loadSettings, normalizeSettings, saveSettings, slugify } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);
const PROFILE_FIELDS = Object.keys(DEFAULT_PROFILE); // each one has an input with the same id
let categories = [];
let dirty = false;

init();

async function init() {
  fillSelect($("model"), MODELS);
  fillSelect($("reasoningEffort"), REASONING_LEVELS);
  $("ph-profile").append(...placeholderChips(PROFILE_PLACEHOLDERS));
  $("ph-message").append(...placeholderChips(MESSAGE_PLACEHOLDERS));
  render(await loadSettings());
  showShortcut();

  document.addEventListener("input", markDirty);
  document.addEventListener("change", markDirty);
  window.addEventListener("beforeunload", (e) => dirty && e.preventDefault());
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  });
  $("btn-save").addEventListener("click", save);
  $("btn-test").addEventListener("click", testConnection);
  $("btn-add-category").addEventListener("click", addCategory);
  $("btn-reset").addEventListener("click", resetToDefaults);
  $("btn-shortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
  $("btn-reveal").addEventListener("click", (e) => {
    const show = $("apiKey").type === "password";
    $("apiKey").type = show ? "text" : "password";
    e.target.textContent = show ? "Hide" : "Show";
    e.target.setAttribute("aria-pressed", String(show));
  });
}

function render(settings) {
  $("apiKey").value = settings.apiKey;
  $("model").value = settings.model;
  $("reasoningEffort").value = settings.reasoningEffort;
  for (const field of PROFILE_FIELDS) $(field).value = settings.profile[field];
  categories = settings.categories.map((c) => ({ ...c }));
  renderCategories();
}

function collect() {
  return {
    apiKey: $("apiKey").value.trim(),
    model: $("model").value,
    reasoningEffort: $("reasoningEffort").value,
    profile: Object.fromEntries(PROFILE_FIELDS.map((f) => [f, $(f).value.trim()])),
    categories: categories.map(({ id, label, when, reply, enabled }) => ({ id, label, when, reply, enabled })),
  };
}

async function save() {
  const problem = prepareCategories();
  if (problem) return setStatus(problem, "err");
  const openIds = [...document.querySelectorAll(".category[open]")].map((d) => d.dataset.id);
  const saved = await saveSettings(collect());
  render(saved);
  for (const id of openIds) document.querySelector(`.category[data-id="${CSS.escape(id)}"]`)?.setAttribute("open", "");
  dirty = false;
  setStatus("Saved ✓", "ok");
}

// Gives new categories a unique id and drops untouched empty ones. Returns an error message, if any.
function prepareCategories() {
  categories = categories.filter((c) => c.builtIn || c.label.trim() || c.when.trim() || c.reply.trim());
  const nameless = categories.find((c) => !c.label.trim());
  if (nameless) return "Give each category a name before saving.";
  const taken = new Set(categories.filter((c) => c.id).map((c) => c.id));
  for (const c of categories) {
    if (c.id) continue;
    const base = slugify(c.label) || "custom";
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    c.id = id;
    taken.add(id);
  }
  if (!categories.some((c) => c.enabled)) return "Turn on at least one category.";
  return null;
}

function renderCategories() {
  const list = $("categories");
  const template = $("category-template").content.firstElementChild;
  list.replaceChildren(
    ...categories.map((c) => {
      const node = template.cloneNode(true);
      const q = (sel) => node.querySelector(sel);
      node.dataset.id = c.id;
      node.classList.toggle("off", !c.enabled);
      q(".cat-title").textContent = c.label.trim() || "New category";
      q(".cat-tag").textContent = c.builtIn ? "Built-in" : "Custom";
      q(".cat-enabled").checked = c.enabled;
      q(".cat-label").value = c.label;
      q(".cat-when").value = c.when;
      q(".cat-reply").value = c.reply;
      q(".cat-reset").hidden = !c.builtIn;
      q(".cat-delete").hidden = c.builtIn;

      q(".cat-enabled").addEventListener("change", (e) => {
        c.enabled = e.target.checked;
        node.classList.toggle("off", !c.enabled);
      });
      q(".cat-label").addEventListener("input", (e) => {
        c.label = e.target.value;
        q(".cat-title").textContent = c.label.trim() || "New category";
      });
      q(".cat-when").addEventListener("input", (e) => (c.when = e.target.value));
      q(".cat-reply").addEventListener("input", (e) => (c.reply = e.target.value));
      q(".cat-reset").addEventListener("click", () => {
        const original = BUILT_IN_CATEGORIES.find((b) => b.id === c.id);
        Object.assign(c, { label: original.label, when: original.when, reply: original.reply });
        q(".cat-label").value = c.label;
        q(".cat-when").value = c.when;
        q(".cat-reply").value = c.reply;
        q(".cat-title").textContent = c.label;
        markDirty();
      });
      q(".cat-delete").addEventListener("click", () => {
        if (!confirm(`Delete the "${c.label.trim() || "new"}" category?`)) return;
        categories.splice(categories.indexOf(c), 1);
        node.remove();
        markDirty();
      });
      return node;
    })
  );
}

function addCategory() {
  categories.push({ id: "", label: "", when: "", reply: "", enabled: true, builtIn: false });
  renderCategories();
  const node = $("categories").lastElementChild;
  node.open = true;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.querySelector(".cat-label").focus();
  markDirty();
}

function resetToDefaults() {
  if (!confirm("Restore the default profile, writing style and categories? Your API key is kept.")) return;
  render(normalizeSettings({ apiKey: $("apiKey").value, model: $("model").value, reasoningEffort: $("reasoningEffort").value }));
  markDirty();
  setStatus("Defaults restored. Press Save to keep them.", "dirty");
}

async function testConnection() {
  const key = $("apiKey").value.trim();
  const status = $("test-status");
  if (!key) return show("Enter your API key first.", "err");
  show("Checking…", "");
  try {
    const available = await listModels(key);
    const model = $("model").value;
    const short = model.replace(/^openai\//, "");
    if (available.includes(model)) show(`Connected ✓ ${short} is available.`, "ok");
    else show(`The key works, but ${short} isn't available for it. Pick the other model.`, "err");
  } catch (err) {
    show(err.message, "err");
  }
  function show(text, cls) {
    status.textContent = text;
    status.className = cls;
  }
}

async function showShortcut() {
  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((c) => c.name === "draft-reply")?.shortcut;
  $("shortcut").textContent = shortcut || "not set";
}

function markDirty() {
  dirty = true;
  setStatus("Unsaved changes", "dirty");
}

function setStatus(text, cls) {
  const el = $("save-status");
  el.textContent = text;
  el.className = cls || "";
}

function fillSelect(select, items) {
  select.replaceChildren(...items.map(({ id, label }) => new Option(label, id)));
}

function placeholderChips(map) {
  return Object.entries(map).map(([key, label]) => {
    const code = document.createElement("code");
    code.textContent = `{${key}}`;
    code.title = label;
    return code;
  });
}
