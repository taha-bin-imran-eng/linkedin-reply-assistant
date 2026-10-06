// Spots technology names in a message. Used to show what a recruiter's message mentions and to tell
// the model the tech stack is already answered, which it judges unreliably on its own.
//
// Ambiguous names (Go, React, Swift, Spring, Rust, …) are matched case-sensitively so ordinary
// sentences like "go ahead and react quickly" don't count as a tech stack.

// A hyphen may precede a name: InMail subjects run words together ("FOR YOU!-Python Engineer-Pre-IPO").
const BEFORE = "(?<![\\w.#+])";
const AFTER = "(?![\\w#+])";
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Case-insensitive by default; pass "" for names that are also ordinary words.
const rx = (names, flags = "i") => new RegExp(`${BEFORE}(?:${names.map(escape).join("|")})${AFTER}`, flags);

// "Go" only counts when a list or conjunction follows ("Go and Postgres", "Go, Python", "(Go)").
const GO = /(?<![\w.#+])(?:[Gg]olang|Go(?=\s*(?:[,/;)&]|and\b|or\b|$)))(?![\w#+])/;
const REACT = /(?<![\w.#+])React(?:\.js|JS|js)?(?![\w#+])(?!\s+Native)/;
const NODE = /(?<![\w.#+])(?:Node(?:\.js|JS|js)?|node\.js|nodejs)(?![\w#+])/;

const TECH = [
  // Languages
  ["Python", [rx(["Python", "Python3"])]],
  ["JavaScript", [rx(["JavaScript", "ECMAScript"]), rx(["JS"], "")]],
  ["TypeScript", [rx(["TypeScript"])]],
  ["Java", [rx(["Java"])]],
  ["Go", [GO]],
  ["Rust", [rx(["Rust"], "")]],
  ["C++", [rx(["C++", "cpp"])]],
  ["C#", [rx(["C#"])]],
  [".NET", [rx([".NET", "ASP.NET", "dotnet"])]],
  ["Kotlin", [rx(["Kotlin"])]],
  ["Swift", [rx(["Swift", "SwiftUI"], "")]],
  ["Scala", [rx(["Scala"])]],
  ["Ruby", [rx(["Ruby"], "")]],
  ["Ruby on Rails", [rx(["Ruby on Rails"]), rx(["Rails", "RoR"], "")]],
  ["PHP", [rx(["PHP"])]],
  ["Elixir", [rx(["Elixir"], "")]],
  ["Haskell", [rx(["Haskell"])]],
  ["Dart", [rx(["Dart"], "")]],
  ["Perl", [rx(["Perl"])]],
  ["SQL", [rx(["SQL"], "")]],
  ["NoSQL", [rx(["NoSQL"])]],
  ["Solidity", [rx(["Solidity"])]],
  ["DAML", [rx(["DAML"])]],
  // Front end
  ["React", [REACT, rx(["ReactJS", "React.js"])]],
  ["React Native", [rx(["React Native"])]],
  ["Next.js", [rx(["Next.js", "NextJS"])]],
  ["Vue", [rx(["Vue", "VueJS"], ""), rx(["Vue.js", "vuejs"])]],
  ["Nuxt", [rx(["Nuxt", "Nuxt.js"])]],
  ["Angular", [rx(["Angular", "AngularJS"], "")]],
  ["Svelte", [rx(["Svelte", "SvelteKit"])]],
  ["Redux", [rx(["Redux"])]],
  ["HTML", [rx(["HTML", "HTML5"], "")]],
  ["CSS", [rx(["CSS", "CSS3"], "")]],
  ["Tailwind", [rx(["Tailwind", "TailwindCSS"])]],
  ["Sass", [rx(["Sass", "SCSS"])]],
  ["jQuery", [rx(["jQuery"])]],
  ["Webpack", [rx(["Webpack"])]],
  ["Vite", [rx(["Vite"], "")]],
  // Back end
  ["Node.js", [NODE]],
  ["Express", [rx(["Express.js", "ExpressJS"])]],
  ["NestJS", [rx(["NestJS", "Nest.js"])]],
  ["Django", [rx(["Django", "DRF"])]],
  ["FastAPI", [rx(["FastAPI"])]],
  ["Flask", [rx(["Flask"])]],
  ["Spring Boot", [rx(["Spring Boot", "SpringBoot", "Spring Framework"])]],
  ["Laravel", [rx(["Laravel"])]],
  ["GraphQL", [rx(["GraphQL"])]],
  ["REST APIs", [rx(["RESTful", "REST"], "")]],
  ["gRPC", [rx(["gRPC"])]],
  ["Celery", [rx(["Celery"], "")]],
  // Data
  ["PostgreSQL", [rx(["PostgreSQL", "Postgres", "psql"])]],
  ["MySQL", [rx(["MySQL", "MariaDB"])]],
  ["SQL Server", [rx(["SQL Server", "MSSQL", "T-SQL"])]],
  ["MongoDB", [rx(["MongoDB", "Mongo"])]],
  ["Redis", [rx(["Redis"])]],
  ["Elasticsearch", [rx(["Elasticsearch", "Elastic Search", "OpenSearch"])]],
  ["DynamoDB", [rx(["DynamoDB"])]],
  ["Cassandra", [rx(["Cassandra"], "")]],
  ["Kafka", [rx(["Kafka"])]],
  ["RabbitMQ", [rx(["RabbitMQ"])]],
  ["Spark", [rx(["Apache Spark"]), rx(["Spark", "PySpark"], "")]],
  ["Airflow", [rx(["Airflow"], "")]],
  ["dbt", [rx(["dbt"], "")]],
  ["Snowflake", [rx(["Snowflake"], "")]],
  ["BigQuery", [rx(["BigQuery"])]],
  ["Databricks", [rx(["Databricks"])]],
  ["Pandas", [rx(["Pandas"], "")]],
  // AI
  ["PyTorch", [rx(["PyTorch"])]],
  ["TensorFlow", [rx(["TensorFlow"])]],
  ["scikit-learn", [rx(["scikit-learn", "sklearn"])]],
  ["LLMs", [rx(["LLM", "LLMs", "GenAI"], "")]],
  ["LangChain", [rx(["LangChain"])]],
  // Cloud and infrastructure
  ["AWS", [rx(["AWS", "Amazon Web Services"])]],
  ["Google Cloud", [rx(["GCP", "Google Cloud"])]],
  ["Azure", [rx(["Azure"])]],
  ["AWS Lambda", [rx(["Lambda"], "")]],
  ["Docker", [rx(["Docker"])]],
  ["Kubernetes", [rx(["Kubernetes", "K8s"])]],
  ["Terraform", [rx(["Terraform"])]],
  ["CI/CD", [rx(["CI/CD", "CICD"])]],
  ["GitHub Actions", [rx(["GitHub Actions"])]],
  ["Jenkins", [rx(["Jenkins"], "")]],
  ["Linux", [rx(["Linux"])]],
  ["Firebase", [rx(["Firebase"])]],
  ["Supabase", [rx(["Supabase"])]],
  // Web3
  ["Ethereum", [rx(["Ethereum"])]],
  ["Web3", [rx(["Web3"])]],
  ["Hyperledger", [rx(["Hyperledger"])]],
  // Mobile
  ["Flutter", [rx(["Flutter"], "")]],
  ["iOS", [rx(["iOS"], "")]],
  ["Android", [rx(["Android"], "")]],
  // Testing
  ["Jest", [rx(["Jest"], "")]],
  ["Cypress", [rx(["Cypress"], "")]],
  ["Playwright", [rx(["Playwright"], "")]],
  ["Selenium", [rx(["Selenium"])]],
];

// Extra names from Settings, so niche stacks can be spotted too.
function extraEntries(extraWords) {
  const known = new Set(TECH.map(([name]) => name.toLowerCase()));
  return String(extraWords || "")
    .split(/[,;\n]+/)
    .map((w) => w.trim())
    .filter((w) => w && !known.has(w.toLowerCase()))
    .map((word) => [word, [rx([word])]]);
}

/** Technology names found in `text`, in the order they appear. */
export function detectTech(text, extraWords = "") {
  if (!text) return [];
  const found = [];
  for (const [name, patterns] of [...TECH, ...extraEntries(extraWords)]) {
    const at = patterns.map((p) => text.search(p)).filter((i) => i >= 0);
    if (at.length) found.push([name, Math.min(...at)]);
  }
  return found.sort((a, b) => a[1] - b[1]).map(([name]) => name);
}

/** What the other person's messages mention, and which of those the profile already claims. */
export function techInConversation(ctx, profile = {}) {
  const theirs = (ctx.messages || []).filter((m) => m.me !== true).map((m) => `${m.subject || ""}\n${m.text || ""}`);
  if (!theirs.length && ctx.rawTranscript) theirs.push(ctx.rawTranscript);
  if (ctx.selection) theirs.push(ctx.selection);

  const mentioned = detectTech(theirs.join("\n"), profile.techWords);
  const known = new Set(detectTech(`${profile.headline || ""}\n${profile.skills || ""}`, profile.techWords));
  return { mentioned, mine: mentioned.filter((name) => known.has(name)) };
}
