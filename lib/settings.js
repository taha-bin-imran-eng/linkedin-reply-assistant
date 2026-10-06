// Loads settings from chrome.storage.local, fills in defaults, and migrates v1.1 settings.
import { BUILT_IN_CATEGORIES, DEFAULT_PROFILE, MODELS, REASONING_LEVELS } from "./defaults.js";

// v1.1 pre-filled its form with these placeholder values, so a saved copy of them isn't real user data.
const V1_PLACEHOLDERS = new Set([
  "Taha",
  "Senior Full Stack Engineer",
  "Senior Software Engineer",
  "PKT (UTC+5), flexible for US/EU overlap",
]);
export const V1_KEYS = ["groqApiKey", "groqModel", "candidateProfile", "customCategories"];

export async function loadSettings(storage = chrome.storage.local) {
  return normalizeSettings(await storage.get(null));
}

export async function saveSettings(settings, storage = chrome.storage.local) {
  const clean = normalizeSettings(settings);
  await storage.set(clean);
  await storage.remove(V1_KEYS);
  return clean;
}

export function normalizeSettings(stored = {}) {
  const profile = { ...DEFAULT_PROFILE };
  for (const key of Object.keys(DEFAULT_PROFILE)) {
    if (typeof stored.profile?.[key] === "string") profile[key] = stored.profile[key];
  }
  if (!stored.profile && stored.candidateProfile) migrateV1Profile(stored.candidateProfile, profile);

  const model = MODELS.some((m) => m.id === (stored.model || stored.groqModel))
    ? stored.model || stored.groqModel
    : MODELS[0].id;

  return {
    apiKey: String(stored.apiKey ?? stored.groqApiKey ?? "").trim(),
    model,
    reasoningEffort: REASONING_LEVELS.some((r) => r.id === stored.reasoningEffort) ? stored.reasoningEffort : "low",
    profile,
    categories: mergeCategories(stored.categories),
  };
}

function migrateV1Profile(v1, profile) {
  const keep = (value) => (typeof value === "string" && value.trim() && !V1_PLACEHOLDERS.has(value.trim()) ? value.trim() : "");
  profile.name = keep(v1.name);
  profile.headline = keep(v1.role);
  profile.basedIn = keep(v1.timezone);
  if (keep(v1.keyQuestions)) profile.questions = keep(v1.keyQuestions);
  if (keep(v1.rules)) profile.style = keep(v1.rules);
}

// Keeps the user's edits and order, drops broken entries, and adds any built-in categories that are missing.
function mergeCategories(stored) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(stored) ? stored : []) {
    const id = slugify(c?.id || c?.label);
    if (!id || seen.has(id)) continue;
    const builtIn = BUILT_IN_CATEGORIES.find((b) => b.id === id);
    out.push({
      id,
      label: String(c.label || builtIn?.label || id).trim(),
      when: String(c.when ?? builtIn?.when ?? "").trim(),
      reply: String(c.reply ?? builtIn?.reply ?? "").trim(),
      enabled: c.enabled !== false,
      builtIn: Boolean(builtIn),
    });
    seen.add(id);
  }
  for (const b of BUILT_IN_CATEGORIES) if (!seen.has(b.id)) out.push({ ...b });
  if (!out.some((c) => c.enabled)) out.find((c) => c.id === "other").enabled = true;
  return out;
}

export function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}
