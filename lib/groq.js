// Minimal Groq client: one chat completion, friendly errors, and rate-limit handling.
const API = "https://api.groq.com/openai/v1";

export class GroqError extends Error {
  constructor(message, { status = 0, code = "API", retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export async function chatCompletion(apiKey, body) {
  let res;
  try {
    res = await fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GroqError("Couldn't reach Groq. Check your internet connection.", { code: "NETWORK" });
  }
  if (res.ok) {
    const json = await res.json();
    json._rate = {
      remainingTokens: Number(res.headers.get("x-ratelimit-remaining-tokens")),
      resetTokens: res.headers.get("x-ratelimit-reset-tokens"),
    };
    return json;
  }

  const payload = await res.json().catch(() => ({}));
  const apiMessage = payload.error?.message || res.statusText || "unknown error";
  const retryAfter = Number(res.headers.get("retry-after")) || null;
  if (res.status === 401) {
    throw new GroqError("Groq rejected the API key. Check it in Settings.", { status: 401, code: "BAD_KEY" });
  }
  if (res.status === 404 || payload.error?.code === "model_not_found") {
    throw new GroqError(`The model "${body.model}" isn't available for your key. Pick another one in Settings.`, {
      status: res.status,
      code: "BAD_MODEL",
    });
  }
  // Rare, but it happens: the model drops a field and Groq rejects its own structured output.
  if (res.status === 400 && /schema|json_validate/i.test(apiMessage)) {
    throw new GroqError("The model returned a malformed reply. Try again.", { status: 400, code: "BAD_JSON" });
  }
  if (res.status === 413) {
    throw new GroqError(
      "This conversation is too long for your Groq plan's per-minute limit. Highlight just the message you want to answer and try again.",
      { status: 413, code: "TOO_LARGE" }
    );
  }
  if (res.status === 429) {
    const daily = /per day/i.test(apiMessage);
    throw new GroqError(
      daily
        ? "You've used today's Groq allowance for this model. Switch models in Settings or try again tomorrow."
        : `Groq's rate limit was reached${retryAfter ? `. Try again in ${Math.ceil(retryAfter)}s` : ""}.`,
      { status: 429, code: daily ? "DAILY_LIMIT" : "RATE_LIMIT", retryAfter }
    );
  }
  throw new GroqError(`Groq error ${res.status}: ${apiMessage}`, { status: res.status, code: payload.error?.code || "API" });
}

// Retries a malformed reply once. On a per-minute rate limit: waits briefly and retries, then tries the
// fallback model, which has its own limit.
export async function chatCompletionWithRetry(apiKey, body, fallbackModel) {
  try {
    return await chatCompletion(apiKey, body);
  } catch (err) {
    if (err.code === "BAD_JSON") return chatCompletion(apiKey, body);
    if (err.code !== "RATE_LIMIT" && err.code !== "DAILY_LIMIT") throw err;
    if (err.code === "RATE_LIMIT" && err.retryAfter && err.retryAfter <= 8) {
      await new Promise((r) => setTimeout(r, err.retryAfter * 1000 + 300));
      try {
        return await chatCompletion(apiKey, body);
      } catch (again) {
        if (again.code !== "RATE_LIMIT") throw again;
      }
    }
    if (!fallbackModel || fallbackModel === body.model) throw err;
    const json = await chatCompletion(apiKey, { ...body, model: fallbackModel });
    json._fallbackFrom = body.model;
    return json;
  }
}

export async function listModels(apiKey) {
  let res;
  try {
    res = await fetch(`${API}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch {
    throw new GroqError("Couldn't reach Groq. Check your internet connection.", { code: "NETWORK" });
  }
  if (res.status === 401) throw new GroqError("Groq rejected the API key.", { status: 401, code: "BAD_KEY" });
  if (!res.ok) throw new GroqError(`Groq error ${res.status}`, { status: res.status });
  const json = await res.json();
  return (json.data || []).map((m) => m.id);
}
