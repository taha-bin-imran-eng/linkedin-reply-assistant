// Fast checks for settings migration, prompt building, response parsing and Groq error handling.
//   node tests/unit.mjs
import assert from "node:assert/strict";
import { chatCompletion, chatCompletionWithRetry } from "../lib/groq.js";
import { buildRequest, parseResponse } from "../lib/prompt.js";
import { normalizeSettings } from "../lib/settings.js";
import { detectTech, techInConversation } from "../lib/tech.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

const categoryEnum = (body) => body.response_format.json_schema.schema.properties.category.enum;
const reply = (content, extra = {}) => ({ model: "openai/gpt-oss-120b", choices: [{ finish_reason: "stop", message: { content } }], ...extra });

await test("defaults: nine categories, gpt-oss-120b, low reasoning", () => {
  const s = normalizeSettings({});
  assert.equal(s.categories.length, 9);
  assert.equal(s.model, "openai/gpt-oss-120b");
  assert.equal(s.reasoningEffort, "low");
  assert.equal(s.profile.workPreference, "Fully remote roles only");
});

await test("v1.1 settings migrate, skipping v1.1's placeholder values and dead models", () => {
  const s = normalizeSettings({
    groqApiKey: " gsk_old ",
    groqModel: "mixtral-8x7b-32768",
    candidateProfile: { name: "Taha", role: "Senior Software Engineer", timezone: "Lahore (PKT)", keyQuestions: "Stack?", rules: "Be brief." },
  });
  assert.equal(s.apiKey, "gsk_old");
  assert.equal(s.model, "openai/gpt-oss-120b");
  assert.equal(s.profile.name, "");
  assert.equal(s.profile.headline, "");
  assert.equal(s.profile.basedIn, "Lahore (PKT)");
  assert.equal(s.profile.questions, "Stack?");
  assert.equal(s.profile.style, "Be brief.");
});

await test("categories: keeps edits and custom ones, drops duplicates, restores missing built-ins", () => {
  const s = normalizeSettings({
    categories: [
      { id: "promo", label: "Sales pitch", when: "w", reply: "r", enabled: true },
      { id: "promo", label: "dupe" },
      { id: "podcast", label: "Podcast invite", when: "They invite me to a podcast", reply: "Say yes", enabled: true },
    ],
  });
  assert.equal(s.categories[0].label, "Sales pitch");
  assert.equal(s.categories.filter((c) => c.id === "promo").length, 1);
  assert.equal(s.categories.find((c) => c.id === "podcast").builtIn, false);
  assert.equal(s.categories.length, 10);
});

await test("disabled categories are left out of the prompt and the schema", () => {
  const s = normalizeSettings({ categories: [{ id: "networking", label: "Networking", enabled: false }] });
  const { body } = buildRequest(s, { participant: { name: "Jo Park" }, messages: [] });
  assert.ok(!categoryEnum(body).includes("networking"));
  assert.ok(!body.messages[0].content.includes("[networking]"));
});

await test("prompt: profile placeholders filled, conversation placeholders left for the model", () => {
  const s = normalizeSettings({
    profile: { name: "Sam Rivera", minPay: "$150k", basedIn: "Toronto" },
    categories: [{ id: "custom_one", label: "Custom", when: "When {based_in}", reply: "Hi {first_name}, my floor is {min_pay}", enabled: true }],
  });
  const system = buildRequest(s, { messages: [] }).body.messages[0].content;
  assert.match(system, /Use when: When Toronto/);
  assert.match(system, /Reply: Hi \{first_name\}, my floor is \$150k/);
  assert.match(system, /my minimum \(\$150k\)/);
});

await test("prompt: notes, forced category, revision and 'last message is mine' hints", () => {
  const s = normalizeSettings({ profile: { name: "Sam Rivera" } });
  const ctx = {
    participant: { name: "Jo Park", headline: "Recruiter" },
    messages: [
      { from: "Jo Park", me: false, time: "Mon", subject: "", text: "Remote role?" },
      { from: "Sam Rivera", me: true, time: "Tue", subject: "", text: "Yes, tell me more." },
    ],
    myNotes: "mention I'm free Friday",
  };
  const { body } = buildRequest(s, ctx, { forcedCategory: "follow_up", instructions: "Shorter.", previousDraft: "Hi Jo, any news?" });
  const user = body.messages[1].content;
  assert.deepEqual(categoryEnum(body), ["follow_up"]);
  assert.match(user, /Conversation with Jo Park \(Recruiter\)/);
  assert.match(user, /\[Tue\] Me \(Sam Rivera\):\nYes, tell me more\./);
  assert.match(user, /the last message is mine/);
  assert.match(user, /MY NOTES[^]*mention I'm free Friday/);
  assert.match(user, /MY CURRENT DRAFT[^]*Hi Jo, any news\?/);
  assert.match(user, /CHANGES I WANT\nShorter\./);
  assert.match(user, /Use the "follow_up" category/);
});

await test("prompt: a highlight outside any chat is treated as a possible cold message", () => {
  const { body } = buildRequest(normalizeSettings({}), { participant: null, messages: [], selection: "VP of Engineering at Stripe" });
  assert.match(body.messages[1].content, /outside any chat/);
});

await test("prompt: strict JSON schema with every property required", () => {
  const { body } = buildRequest(normalizeSettings({}), { messages: [] });
  const walk = (schema) => {
    if (schema.type === "object") {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(walk);
    }
    if (schema.items) walk(schema.items);
  };
  assert.equal(body.response_format.json_schema.strict, true);
  walk(body.response_format.json_schema.schema);
});

await test("parse: appends the signature and falls back to 'other' for unknown categories", () => {
  const s = normalizeSettings({ profile: { signature: "Best,\nSam" } });
  const { meta } = buildRequest(s, { messages: [] });
  const r = parseResponse(reply(JSON.stringify({ facts: {}, category: "made_up", reason: "x", reply: "Hi Jo,\n\n\n\nThanks." })), meta);
  assert.equal(r.category, "other");
  assert.equal(r.reply, "Hi Jo,\n\nThanks.\n\nBest,\nSam");
});

await test("parse: a truncated response gives a clear error", () => {
  const { meta } = buildRequest(normalizeSettings({}), { messages: [] });
  assert.throws(() => parseResponse({ choices: [{ finish_reason: "length", message: { content: '{"facts":' } }] }, meta), /ran out of room/);
});

await test("tech: finds the technologies in a recruiter's message, in order", () => {
  const message =
    "Build and maintain a RESTful API using Python and FastAPI. Experience with DAML, Solidity, or other blockchain " +
    "languages. Experience building APIs for large scale applications using AWS.";
  assert.deepEqual(detectTech(message), ["REST APIs", "Python", "FastAPI", "DAML", "Solidity", "AWS"]);
});

await test("tech: everyday words aren't mistaken for technologies", () => {
  assert.deepEqual(detectTech("Go ahead and react quickly; we spring into action with swift, express service. Let's go!"), []);
  assert.deepEqual(detectTech("We're building payments infrastructure in Go and Postgres"), ["Go", "PostgreSQL"]);
  assert.deepEqual(detectTech("A JavaScript role (no Java)"), ["JavaScript", "Java"]);
  assert.deepEqual(detectTech("MySQL only"), ["MySQL"]);
  assert.deepEqual(detectTech("React Native app"), ["React Native"]);
  assert.deepEqual(detectTech("Stack: C#, C++ and .NET with Next.js/Node.js"), ["C#", "C++", ".NET", "Next.js", "Node.js"]);
});

await test("tech: names run together with hyphens in InMail subjects are still found", () => {
  assert.deepEqual(detectTech("JOB OPPORTUNITY FOR YOU!-Python Engineer-Pre-IPO FinTech-Full-Time"), ["Python"]);
});

await test("tech: extra words from settings are spotted too", () => {
  assert.deepEqual(detectTech("Experience with Canton and Temporal", "Canton, Temporal"), ["Canton", "Temporal"]);
});

await test("tech: only their messages count, and mine are ticked off against my skills", () => {
  const ctx = {
    messages: [
      { from: "Recruiter", me: false, subject: "Python Engineer", text: "We use Django and AWS." },
      { from: "Me", me: true, subject: "", text: "I also use Kubernetes." },
    ],
  };
  const tech = techInConversation(ctx, { skills: "Python, Django, React", headline: "Full Stack Engineer" });
  assert.deepEqual(tech.mentioned, ["Python", "Django", "AWS"]);
  assert.deepEqual(tech.mine, ["Python", "Django"]);
});

await test("prompt: naming two technologies rules out the stack question", () => {
  const ctx = { participant: { name: "Daniel Reyes" }, messages: [{ from: "Daniel Reyes", me: false, subject: "", text: "Python and FastAPI on AWS." }] };
  const user = buildRequest(normalizeSettings({ profile: { skills: "Python" } }), ctx).body.messages[1].content;
  assert.match(user, /TECHNOLOGIES THEY NAMED: Python, FastAPI, AWS\./);
  assert.match(user, /Of these I know: Python\./);
  assert.match(user, /do not ask about the stack/);
});

await test("prompt: a single technology still leaves the stack open to ask about", () => {
  const ctx = { messages: [{ from: "R", me: false, subject: "", text: "A Python role." }] };
  const user = buildRequest(normalizeSettings({}), ctx).body.messages[1].content;
  assert.match(user, /TECHNOLOGIES THEY NAMED: Python\./);
  assert.ok(!/do not ask about the stack/.test(user));
});

const realFetch = globalThis.fetch;
const respond = (status, payload, headers = {}) => new Response(JSON.stringify(payload), { status, headers });

await test("groq: 401 becomes a key error", async () => {
  globalThis.fetch = async () => respond(401, { error: { message: "Invalid API Key" } });
  await assert.rejects(chatCompletion("k", { model: "m" }), (e) => e.code === "BAD_KEY");
});

await test("groq: per-day limit is reported as a daily limit", async () => {
  globalThis.fetch = async () => respond(429, { error: { message: "Rate limit reached ... tokens per day (TPD)" } }, { "retry-after": "900" });
  await assert.rejects(chatCompletion("k", { model: "m" }), (e) => e.code === "DAILY_LIMIT");
});

await test("groq: a rate-limited model falls back to the other one", async () => {
  const models = [];
  globalThis.fetch = async (_url, opts) => {
    const { model } = JSON.parse(opts.body);
    models.push(model);
    return model === "openai/gpt-oss-120b"
      ? respond(429, { error: { message: "Rate limit reached ... tokens per minute (TPM)" } }, { "retry-after": "30" })
      : respond(200, reply("{}"));
  };
  const json = await chatCompletionWithRetry("k", { model: "openai/gpt-oss-120b" }, "openai/gpt-oss-20b");
  assert.deepEqual(models, ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  assert.equal(json._fallbackFrom, "openai/gpt-oss-120b");
});

await test("groq: a reply that fails Groq's own schema check is retried once", async () => {
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1
      ? respond(400, { error: { message: "Generated JSON does not match the expected schema.", code: "json_validate_failed" } })
      : respond(200, reply("{}"));
  const json = await chatCompletionWithRetry("k", { model: "openai/gpt-oss-120b" }, "openai/gpt-oss-20b");
  assert.equal(calls, 2);
  assert.ok(json.choices);
  globalThis.fetch = async () => respond(400, { error: { message: "Generated JSON does not match the expected schema." } });
  await assert.rejects(chatCompletionWithRetry("k", { model: "m" }), /malformed reply/);
});

await test("groq: a short wait is retried on the same model first", async () => {
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1 ? respond(429, { error: { message: "tokens per minute" } }, { "retry-after": "0.2" }) : respond(200, reply("{}"));
  const json = await chatCompletionWithRetry("k", { model: "openai/gpt-oss-120b" }, "openai/gpt-oss-20b");
  assert.equal(calls, 2);
  assert.equal(json._fallbackFrom, undefined);
});
globalThis.fetch = realFetch;

console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
