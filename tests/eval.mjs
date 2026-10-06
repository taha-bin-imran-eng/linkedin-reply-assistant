// Runs the eval cases in tests/samples.mjs against Groq and reports category accuracy and reply checks.
//
//   node tests/eval.mjs [--keyfile=PATH] [--model=openai/gpt-oss-20b] [--reasoning=medium] [--temperature=0.3]
//                       [--only=id1,id2] [--out=report.json]
//
// The key comes from GROQ_API_KEY, --keyfile, or ~/.groq_api_key. It is never printed.
// Requests are paced using Groq's rate-limit headers, so a full run on the free tier takes a few minutes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatCompletion } from "../lib/groq.js";
import { buildRequest, parseResponse } from "../lib/prompt.js";
import { normalizeSettings } from "../lib/settings.js";
import { SAMPLES, TEST_PROFILE } from "./samples.mjs";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY.trim();
  const raw = fs.readFileSync(arg("keyfile") || path.join(os.homedir(), ".groq_api_key"), "utf8");
  return (raw.match(/gsk_[A-Za-z0-9]+/) || [raw.trim()])[0];
}

// Groq reset headers look like "7.66s", "1m2.5s" or "250ms".
function resetMs(value) {
  let ms = 0;
  for (const [, n, unit] of String(value || "").matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    ms += Number(n) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  }
  return ms;
}

const settings = normalizeSettings({
  profile: TEST_PROFILE,
  model: arg("model"),
  reasoningEffort: arg("reasoning"),
});
const only = arg("only")?.split(",");
const cases = SAMPLES.filter((s) => !only || only.includes(s.id));
const key = readKey();
const results = [];

console.log(`Model ${settings.model}, reasoning ${settings.reasoningEffort}, ${cases.length} cases\n`);
for (const sample of cases) {
  const { body, meta } = buildRequest(settings, sample.ctx, sample.opts);
  if (arg("temperature")) body.temperature = Number(arg("temperature"));
  let json = null;
  let ms = 0;
  for (let attempt = 0; attempt < 6 && !json; attempt++) {
    const started = Date.now();
    try {
      json = await chatCompletion(key, body);
      ms = Date.now() - started;
    } catch (err) {
      if (err.code === "BAD_JSON") continue; // the model dropped a field; ask again
      if (err.code !== "RATE_LIMIT") {
        results.push({ id: sample.id, error: err.message });
        console.log(`ERROR ${sample.id}: ${err.message}`);
        break;
      }
      await sleep((err.retryAfter || 5) * 1000 + 500);
    }
  }
  if (!json) continue;

  const r = parseResponse(json, meta);
  const categoryOk = sample.expect.includes(r.category);
  const checks = (sample.checks || []).map((c) => ({ name: c.name, ok: c.test(r.reply) }));
  const allOk = categoryOk && checks.every((c) => c.ok);
  results.push({ id: sample.id, expect: sample.expect, got: r.category, categoryOk, checks, ms, usage: r.usage, reason: r.reason, facts: r.facts, reply: r.reply });

  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  console.log(
    `${allOk ? "PASS" : "FAIL"} ${sample.id.padEnd(28)} ${categoryOk ? "" : `expected ${sample.expect.join("|")} → `}${r.category}` +
      `${failed.length ? `  ✗ ${failed.join("; ")}` : ""}  (${ms} ms, ${r.usage?.prompt_tokens}+${r.usage?.completion_tokens} tok)`
  );
  console.log(`     ${r.reply.replace(/\n/g, "\n     ")}\n`);

  // Stay under the tokens-per-minute limit: wait for the bucket to refill when it runs low.
  if (json._rate?.remainingTokens < 3500) await sleep(resetMs(json._rate.resetTokens) + 300);
}

const scored = results.filter((r) => !r.error);
const catPass = scored.filter((r) => r.categoryOk).length;
const checkTotal = scored.reduce((n, r) => n + r.checks.length, 0);
const checkPass = scored.reduce((n, r) => n + r.checks.filter((c) => c.ok).length, 0);
const avg = (f) => Math.round(scored.reduce((n, r) => n + f(r), 0) / (scored.length || 1));
console.log(
  `Categories ${catPass}/${scored.length} · reply checks ${checkPass}/${checkTotal} · errors ${results.length - scored.length}` +
    ` · avg ${avg((r) => r.ms)} ms · avg ${avg((r) => r.usage?.prompt_tokens || 0)} prompt + ${avg((r) => r.usage?.completion_tokens || 0)} completion tokens`
);
if (arg("out")) fs.writeFileSync(arg("out"), JSON.stringify({ settings: { ...settings, apiKey: undefined }, results }, null, 2));
