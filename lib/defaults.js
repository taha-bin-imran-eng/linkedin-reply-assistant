// Default settings and built-in categories, shared by the background worker, the options page and the tests.

export const MODELS = [
  { id: "openai/gpt-oss-120b", label: "gpt-oss-120b — best replies (recommended)" },
  { id: "openai/gpt-oss-20b", label: "gpt-oss-20b — faster, separate rate limit" },
];

// Used automatically when the chosen model is rate-limited (Groq limits each model separately).
export const FALLBACK_MODEL = "openai/gpt-oss-20b";

export const REASONING_LEVELS = [
  { id: "low", label: "Low — fastest, uses the fewest tokens" },
  { id: "medium", label: "Medium — more careful, uses more tokens" },
];

export const DEFAULT_PROFILE = {
  name: "",
  headline: "",
  skills: "",
  basedIn: "",
  workRegions: "",
  workPreference: "Fully remote roles only",
  minPay: "",
  links: "",
  questions: "Team location and time zones, the compensation range, and the core tech stack",
  techWords: "",
  signature: "",
  style:
    "Keep it short: 2-4 sentences. Warm, professional and direct. " +
    "Never write \"I hope this message finds you well\". No exclamation marks, no emojis.",
};

// Every field here is editable in Settings. "when" tells the model when to pick the category,
// "reply" is the template it follows. Both can use the placeholders listed in PROFILE_PLACEHOLDERS.
export const BUILT_IN_CATEGORIES = [
  {
    id: "remote_role",
    label: "Remote role",
    when: "A recruiter or hiring manager offers a job that is clearly fully remote, and I can work from where they hire.",
    reply:
      "Thank them for reaching out and say I'm interested. Ask one or two of my questions ({questions}) " +
      "that the conversation hasn't answered yet. If they state pay below my minimum ({min_pay}), " +
      "say politely that my expectations start there and ask if there's flexibility.",
  },
  {
    id: "location_unclear",
    label: "Location unclear",
    when:
      "A job offer that doesn't say whether it's remote, hybrid or onsite. " +
      "A city or area alone (e.g. \"NYC area\") doesn't make it onsite.",
    reply:
      "Thank them, say the role sounds interesting, and ask whether it can be done fully remotely, " +
      "since that's what I'm looking for.",
  },
  {
    id: "remote_restricted",
    label: "Remote, wrong region",
    when: "A remote job limited to countries, regions or time zones that I can't work from (compare with where I can work).",
    reply: "Thank them, say where I'm based ({based_in}) and ask whether they can hire from there. Keep it short.",
  },
  {
    id: "non_remote_role",
    label: "Hybrid / onsite",
    when: "A job that is explicitly hybrid, onsite or in-office, or that needs relocation.",
    reply:
      "Thank them for thinking of me, say I'm only considering fully remote roles right now, " +
      "and ask them to keep me in mind for remote openings. " +
      "Never ask about pay or any other detail of a role I'm turning down.",
  },
  {
    id: "promo",
    label: "Promo / pitch",
    when:
      "Someone selling me a product, service, tool, course or agency services. " +
      "A recruiter offering me a job is not promo.",
    reply: "Thank them briefly and say it's not something I need right now. No questions, no call to action.",
  },
  {
    id: "follow_up",
    label: "Follow-up nudge",
    when: "I sent the last message and they haven't replied yet.",
    reply: "A short, friendly nudge that refers back to my last message without repeating it.",
  },
  {
    id: "outreach",
    label: "Cold outreach",
    when: "I'm starting the conversation: there are no messages from them yet, or my notes ask for a new message to them.",
    reply: "A concise, personal opener based on their headline or profile and my notes, with one clear ask.",
  },
  {
    id: "networking",
    label: "Networking",
    when:
      "Networking, advice or referral requests, invitations, congratulations and other personal messages " +
      "that aren't job offers or sales pitches.",
    reply: "A friendly, helpful reply to what they asked.",
  },
  {
    id: "other",
    label: "Other",
    when: "Anything that doesn't fit the other categories.",
    reply: "A brief, professional reply that fits the context.",
  },
].map((c) => ({ ...c, builtIn: true, enabled: true }));

// Filled in from the profile before the prompt is sent.
export const PROFILE_PLACEHOLDERS = {
  my_name: "Your full name",
  my_first_name: "Your first name",
  headline: "Your headline",
  based_in: "Where you're based",
  work_regions: "Where you can work",
  work_preference: "Your work preference",
  min_pay: "Your minimum pay",
  links: "Your links",
  questions: "Your questions for recruiters",
};

// Filled in by the model from the conversation.
export const MESSAGE_PLACEHOLDERS = {
  first_name: "Their first name",
  company: "Their company",
  role: "The role they mention",
};
