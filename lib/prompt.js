// Builds the Groq request from settings + the conversation the content script read, and parses the reply.
// Pure functions (no chrome.* calls) so tests/eval.mjs can run them in Node.
import { techInConversation } from "./tech.js";

// Replies use ~250-350 completion tokens (reasoning included). Groq counts this cap against the
// per-minute token limit, so keep it tight.
const MAX_COMPLETION_TOKENS = { low: 1000, medium: 1800 };

/**
 * @param settings  normalized settings (lib/settings.js)
 * @param ctx       { participant: {name, headline}|null, messages: [{from, me, time, subject, text}],
 *                    rawTranscript, selection, myNotes, myName }
 * @param opts      { forcedCategory, instructions, previousDraft }
 */
export function buildRequest(settings, ctx, opts = {}) {
  const categories = settings.categories.filter((c) => c.enabled);
  const forced = categories.find((c) => c.id === opts.forcedCategory);
  const myName = settings.profile.name.trim() || ctx.myName || "";
  const tech = techInConversation(ctx, settings.profile);

  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: systemPrompt(settings.profile, myName, categories) },
      { role: "user", content: userPrompt(ctx, myName, opts, forced, tech) },
    ],
    temperature: 0.6,
    max_completion_tokens: MAX_COMPLETION_TOKENS[settings.reasoningEffort] || MAX_COMPLETION_TOKENS.low,
    reasoning_effort: settings.reasoningEffort,
    include_reasoning: false,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "linkedin_reply",
        strict: true,
        schema: outputSchema(forced ? [forced.id] : categories.map((c) => c.id)),
      },
    },
  };
  return { body, meta: { categories, signature: settings.profile.signature.trim(), tech } };
}

function systemPrompt(p, myName, categories) {
  const firstName = myName.split(/\s+/)[0];
  const vars = profileVars(p, myName, firstName);
  const line = (label, value) => (value.trim() ? `${label}: ${value.trim()}` : null);
  const about = [
    line("Name", myName),
    line("Headline", p.headline),
    line("Skills", p.skills),
    line("Based in", p.basedIn),
    line("Can work for employers in", p.workRegions),
    line("Work preference", p.workPreference),
    line("Minimum pay", p.minPay),
    p.links.trim() ? `Links (share only when they help, e.g. they asked for a resume or portfolio):\n${p.links.trim()}` : null,
    line("Questions I want answered about a role", p.questions),
  ].filter(Boolean);

  const signOff = p.signature.trim()
    ? "Don't add a sign-off or my name at the end; my signature is added automatically."
    : "End without a sign-off or signature.";

  const categoryText = categories
    .map((c) => `[${c.id}] ${c.label}\nUse when: ${fill(c.when, vars)}\nReply: ${fill(c.reply, vars)}`)
    .join("\n\n");

  return `You draft LinkedIn message replies for ${myName || "me"}. Write in first person as ${firstName || "me"}, ready to send.

ABOUT ME
${about.join("\n") || "(no details given)"}

WRITING RULES
- Always start with "Hi <their first name>," (or the equivalent in their language) when you know their name.
${bullets(p.style)}
- Reply in the language of their latest message.
- In an ongoing conversation, answer their latest message directly. Don't thank them for reaching out again or repeat anything already said.
- Ask about at most two topics, and only my_questions topics whose answered_by is null. A topic is answered once the conversation touches it at all (e.g. naming any technologies answers the tech stack), so never ask for more detail on it.
- If they ask for my availability, don't make up days or times: say I'm flexible and ask them to suggest a few times, unless my notes give times.
- Only state facts about me that appear above or in my notes and instructions. Never invent experience, availability, contact details or numbers.
- Plain text only: no markdown, no bullet points, no bracketed placeholders.
- ${signOff}
- My notes and instructions, when given, override my profile for this reply (e.g. a different title or tech stack) as well as the category's reply template.

CATEGORIES
Pick the single best fit, then follow its reply template closely, covering each point it asks for. A template may be instructions or a sample message; if it's a sample, keep its wording and fill in {first_name}, {company} and {role} from the conversation.

${categoryText}`;
}

function userPrompt(ctx, myName, opts, forced, tech) {
  const parts = [`Today is ${new Date().toDateString()}.`];
  const who = ctx.participant?.name;
  if (who) parts.push(`Conversation with ${who}${ctx.participant.headline ? ` (${ctx.participant.headline})` : ""}.`);

  const messages = ctx.messages || [];
  if (messages.length) {
    parts.push(`MESSAGES (oldest first)\n\n${messages.map((m) => formatMessage(m, myName)).join("\n\n")}`);
    // Decided here rather than left to the model, which misses it easily.
    if (messages.every((m) => m.me === true)) parts.push("Note: every message so far is mine; they haven't written anything yet.");
    else if (messages.at(-1).me === true) parts.push("Note: the last message is mine and they haven't replied yet.");
  } else if (ctx.rawTranscript) {
    parts.push(`CONVERSATION TEXT (copied from the page; may include button labels)\n"""\n${ctx.rawTranscript}\n"""`);
  } else if (who) {
    parts.push("There are no messages yet: I'm starting this conversation.");
  }
  if (ctx.selection) {
    parts.push(`TEXT I HIGHLIGHTED (focus on this)\n"""\n${ctx.selection}\n"""`);
    if (!who && !messages.length && !ctx.rawTranscript) {
      parts.push("I highlighted this outside any chat. If it's someone's profile or post, I want to start a conversation with them.");
    }
  }
  if (ctx.myNotes) parts.push(`MY NOTES (typed in the message box)\n"""\n${ctx.myNotes}\n"""`);
  // Found in their text by the extension, so it's reliable: treat it as settled, not something to judge.
  if (tech?.mentioned.length) {
    parts.push(
      `TECHNOLOGIES THEY NAMED: ${tech.mentioned.join(", ")}.` +
        (tech.mine.length ? ` Of these I know: ${tech.mine.join(", ")}.` : "") +
        (tech.mentioned.length > 1 ? " That answers the tech stack question, so do not ask about the stack or technologies." : "")
    );
  }
  if (opts.previousDraft) parts.push(`MY CURRENT DRAFT (revise it and keep what already works)\n"""\n${opts.previousDraft}\n"""`);
  if (opts.instructions) parts.push(`CHANGES I WANT\n${opts.instructions}`);
  if (forced) parts.push(`Use the "${forced.id}" category.`);
  parts.push(opts.previousDraft ? "Write the revised reply." : "Write my reply.");
  return parts.join("\n\n");
}

function formatMessage(m, myName) {
  const sender = m.me === true ? `Me (${myName || "me"})` : m.from || "Them";
  const header = m.time ? `[${m.time}] ${sender}:` : `${sender}:`;
  return `${header}\n${m.subject ? `Subject: ${m.subject}\n` : ""}${m.text}`;
}

function profileVars(p, myName, firstName) {
  const v = (s) => s.trim() || "(not set)";
  return {
    my_name: v(myName),
    my_first_name: v(firstName || ""),
    headline: v(p.headline),
    based_in: v(p.basedIn),
    work_regions: v(p.workRegions),
    work_preference: v(p.workPreference),
    min_pay: v(p.minPay),
    links: v(p.links.replace(/\s*\n\s*/g, "; ")),
    questions: v(p.questions),
  };
}

const bullets = (text) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/^[-•*]/.test(l) ? `- ${l.replace(/^[-•*]\s*/, "")}` : `- ${l}`))
    .join("\n");

// Replaces profile placeholders; leaves message placeholders like {first_name} for the model.
function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match));
}

function outputSchema(categoryIds) {
  const text = { type: "string" };
  const textOrNull = { type: ["string", "null"] };
  const facts = {
    their_first_name: textOrNull,
    company: textOrNull,
    role: textOrNull,
    work_arrangement: { type: "string", enum: ["remote", "hybrid", "onsite", "unknown", "not_a_job"] },
    job_location: textOrNull,
    can_i_work_from_there: { type: "string", enum: ["yes", "no", "unclear", "not_applicable"] },
    pay: textOrNull,
    pay_vs_my_minimum: { type: "string", enum: ["meets", "below", "unknown", "not_applicable"] },
    they_asked: { type: "array", items: text, description: "What their latest message asks me, if anything" },
    my_questions: {
      type: "array",
      description: "Each topic from my questions about a role",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "answered_by"],
        properties: {
          topic: text,
          answered_by: { type: ["string", "null"], description: "Exact words from the conversation that answer it, even partly, or null" },
        },
      },
    },
    language: text,
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["facts", "category", "reason", "reply"],
    properties: {
      facts: { type: "object", additionalProperties: false, required: Object.keys(facts), properties: facts },
      category: { type: "string", enum: categoryIds },
      reason: { type: "string", description: "One short sentence: why this category" },
      reply: { type: "string", description: "The message to send, plain text" },
    },
  };
}

export function parseResponse(json, meta) {
  const choice = json?.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new Error("The model ran out of room before finishing. Try again, or set reasoning to Low in Settings.");
  }
  const content = choice?.message?.content;
  if (!content) throw new Error("Groq returned an empty response. Try again.");

  let data;
  try {
    data = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    data = match ? JSON.parse(match[0]) : null;
  }
  if (typeof data?.reply !== "string" || !data.reply.trim()) throw new Error("Groq's response didn't include a reply. Try again.");

  const category =
    meta.categories.find((c) => c.id === data.category) ||
    meta.categories.find((c) => c.id === "other") ||
    meta.categories[0];
  let reply = data.reply.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (meta.signature) reply += `\n\n${meta.signature}`;

  return {
    category: category.id,
    categoryLabel: category.label,
    reason: String(data.reason || ""),
    facts: data.facts || null,
    tech: meta.tech || { mentioned: [], mine: [] },
    reply,
    model: json.model,
    usage: json.usage || null,
  };
}
