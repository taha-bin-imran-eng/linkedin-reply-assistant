// Eval cases: conversations shaped like what content/linkedin-dom.js extracts.
// All people and companies are fictional.
import { DEFAULT_PROFILE } from "../lib/defaults.js";

export const TEST_PROFILE = {
  ...DEFAULT_PROFILE,
  name: "Alex Morgan",
  headline: "Senior Full Stack Engineer (Python, Django, React, Next.js)",
  skills:
    "8 years building web platforms: Python/Django and Node backends, React/Next.js frontends, PostgreSQL, AWS. " +
    "Led payments and data-pipeline projects at two fintech startups.",
  basedIn: "New York, USA (Eastern Time)",
  workRegions: "United States and Canada",
  minPay: "$160k base salary",
  links: "GitHub: https://github.com/alexmorgan-dev\nPortfolio: https://alexmorgan.dev",
};

const them = (from, time, text, subject) => ({ from, me: false, time, subject: subject || "", text });
const me = (time, text) => ({ from: "Alex Morgan", me: true, time, subject: "", text });
const convo = (name, headline, messages, extra = {}) => ({ participant: { name, headline }, messages, ...extra });

// Checks on the reply text. Each returns true when the reply behaves as expected.
const greets = (name) => ({ name: `greets ${name}`, test: (r) => new RegExp(`^(hi|hello|hey|dear|hola)\\s+${name}\\b`, "i").test(r) });
const has = (re, label) => ({ name: label || `mentions ${re}`, test: (r) => re.test(r) });
const lacks = (re, label) => ({ name: label || `avoids ${re}`, test: (r) => !re.test(r) });
const asksQuestion = { name: "asks a question", test: (r) => r.includes("?") || /\b(could you|can you|would like to (know|learn|hear))\b/i.test(r) };
const noQuestion = { name: "asks no questions", test: (r) => !r.includes("?") };
const noRoadmap = lacks(/roadmap/i, 'no "roadmap"');
// A role being turned down shouldn't prompt questions about it.
const noPayQuestion = lacks(/compensation|salary|pay|band|rate/i, "doesn't ask about pay");

const STAFF_ROLE =
  "Hi Alex, I wanted to reach out to you about a fully remote Staff Engineer opening at Brightpath. " +
  "We're building payments infrastructure in Go and Postgres, and the team is spread across US time zones. " +
  "Are you open to new opportunities?";

export const SAMPLES = [
  {
    id: "remote_experience",
    expect: ["remote_role"],
    ctx: convo("Emily Carter", "Senior Technical Recruiter at Northwind Labs", [
      them("Emily Carter", "Mon 9:14 AM",
        "Hi Alex, I came across your profile and was really impressed by your experience with distributed systems. " +
        "I'm hiring a Senior Backend Engineer for Northwind Labs. The role is 100% remote with async-first collaboration. " +
        "Would you be open to a quick chat this week?"),
    ]),
    checks: [greets("Emily"), asksQuestion],
  },
  {
    id: "remote_stack_given",
    expect: ["remote_role"],
    ctx: convo("Sarah Khan", "Talent Partner at Brightpath", [them("Sarah Khan", "Tue 10:02 AM", STAFF_ROLE)]),
    checks: [greets("Sarah"), lacks(/stack|technolog/i, "doesn't re-ask the stack"), has(/compensation|salary|pay|range/i, "asks about pay")],
  },
  {
    id: "hybrid_dubai",
    expect: ["non_remote_role"],
    ctx: convo("Omar Haddad", "HR Manager at Gulf Digital", [
      them("Omar Haddad", "Wed 3:40 PM",
        "Hello Alex, we have a Senior Software Engineer opening at our Dubai office. It's a hybrid setup with 3 days onsite " +
        "per week, and relocation support is provided. Let me know if you'd be interested."),
    ]),
    checks: [greets("Omar"), has(/remote/i), noPayQuestion],
  },
  {
    id: "onsite_austin",
    expect: ["non_remote_role"],
    ctx: convo("Jordan Lee", "Director of Talent at Helix Robotics", [
      them("Jordan Lee", "Thu 8:15 AM",
        "Hi Alex, I'm the Director of Talent at Helix Robotics. We're looking for a Lead Engineer to join our team onsite " +
        "in Austin, TX. We offer a competitive package and visa sponsorship. Interested?"),
    ]),
    checks: [greets("Jordan"), has(/remote/i), noPayQuestion],
  },
  {
    id: "promo_founder",
    expect: ["promo"],
    ctx: convo("Priya Nair", "Founder at ShipFast AI", [
      them("Priya Nair", "Fri 1:05 PM",
        "Hi Alex, I'm the founder of ShipFast AI. We help engineering teams cut code review time by 60% using AI agents. " +
        "Would you be open to a 15-minute demo next week?"),
    ]),
    checks: [greets("Priya"), noQuestion, noRoadmap],
  },
  {
    id: "promo_dev_agency",
    expect: ["promo"],
    ctx: convo("Kevin Brooks", "Business Development at CodeCrafters Agency", [
      them("Kevin Brooks", "Mon 11:30 AM",
        "Hello Alex, we are a software development agency with 200+ vetted developers. We can help you scale your team " +
        "quickly at 40% lower cost. Can I share our portfolio?"),
    ]),
    checks: [noQuestion, noRoadmap],
  },
  {
    id: "vendor_hiring_services",
    expect: ["promo"],
    ctx: convo("Tom Hughes", "Sales at HireFast", [
      them("Tom Hughes", "Tue 4:10 PM",
        "Hi Alex, HireFast helps startups hire senior engineers in 2 weeks. We'd love to support your hiring plans this " +
        "quarter. Open to a quick call?"),
    ]),
    checks: [noQuestion],
  },
  {
    id: "remote_eu_only",
    expect: ["remote_restricted"],
    ctx: convo("Lena Fischer", "Recruiter at Berlin Tech Partners", [
      them("Lena Fischer", "Wed 9:45 AM",
        "Hi Alex, my client is hiring a Senior Python Engineer. The role is fully remote, but candidates must be based in " +
        "the EU and work CET hours. Salary is EUR 85-100k. Interested?"),
    ]),
    checks: [greets("Lena"), has(/New York|United States|\bUS\b|\bU\.S\./i, "says where I'm based")],
  },
  {
    id: "agency_recruiter_us_remote",
    expect: ["remote_role"],
    ctx: convo("Marcus Green", "Talent Partner at TopTech Recruiting", [
      them("Marcus Green", "Thu 2:20 PM",
        "Hi Alex, I'm a Talent Partner at TopTech Recruiting. My client, a Series B fintech, needs a Senior Full Stack " +
        "Engineer (React/Node). Remote, but candidates must be based in the US. Base pay is $170-190k. " +
        "Required skills: TypeScript and AWS."),
    ]),
    checks: [greets("Marcus"), lacks(/(compensation|salary|pay) (range|band)/i, "doesn't re-ask pay")],
  },
  {
    id: "location_not_mentioned",
    expect: ["location_unclear"],
    ctx: convo("Chris Wong", "Engineering Manager at Acme Corp", [
      them("Chris Wong", "Fri 10:10 AM",
        "Hi Alex, loved your background in fintech. We're hiring a Lead Engineer at Acme Corp to own our platform team. " +
        "Would you be interested in learning more?"),
    ]),
    checks: [greets("Chris"), has(/remote/i), asksQuestion],
  },
  {
    id: "nyc_inmail_with_subject",
    expect: ["location_unclear"],
    ctx: convo("Daniel Reyes", "Recruiting Manager at Northbridge Talent Group", [
      them("Daniel Reyes", "Tuesday 11:52 AM",
        "Hi Alex,\n\nI came across your profile earlier, I think you might be a great match for this role I have with a " +
        "financial client here in the NYC area. If interested in discussing and learning more please contact me at " +
        "555-0142 or daniel@example.com.\n\nResponsibilities\n• Design and implement a private and permissioned distributed " +
        "ledger using DAML or Canton and other open-source blockchain frameworks\n• Build and maintain a RESTful API using " +
        "Python and FastAPI\n• Provide technical leadership to motivate and guide team members\n\nQualifications\n" +
        "• 5-7+ years of software engineering experience building enterprise SaaS cloud-based solutions\n" +
        "• Experience with DAML, Solidity, or other blockchain programming languages\n" +
        "• Demonstrated understanding of relational database concepts and modelling practices\n" +
        "• Experience building APIs for large scale applications using AWS",
        "JOB OPPORTUNITY FOR YOU! Python Engineer - Pre-IPO FinTech - Full-Time - Competitive Salary/Bonus/Benefits/Equity"),
    ]),
    checks: [greets("Daniel"), has(/remote/i), asksQuestion, lacks(/stack|technolog/i, "doesn't ask about the stack they listed")],
  },
  {
    id: "recruiter_follows_up",
    expect: ["remote_role"],
    ctx: convo("Emily Carter", "Senior Technical Recruiter at Northwind Labs", [
      them("Emily Carter", "Sep 10",
        "Hi Alex, we're hiring a remote Platform Engineer at Northwind Labs (Python and AWS). Open to a chat?"),
      them("Emily Carter", "Sep 17",
        "Hi Alex, just following up on my note from last week. Are you still open to chatting about the remote Platform Engineer role?"),
    ]),
    checks: [greets("Emily")],
  },
  {
    id: "ongoing_asks_availability",
    expect: ["remote_role"],
    ctx: convo("Sarah Khan", "Talent Partner at Brightpath", [
      them("Sarah Khan", "Sep 15", STAFF_ROLE + " The base salary range is $180-210k."),
      me("Sep 15", "Hi Sarah, thanks for reaching out. This sounds interesting and I'm open to learning more. Could you share more about the team and the interview process?"),
      them("Sarah Khan", "Sep 16",
        "Great to hear! The team is 12 engineers across the US. The process is a recruiter screen, a technical interview " +
        "and a system design round. Could you share your availability for a 20-minute call this week?"),
    ]),
    checks: [
      lacks(/reaching out/i, "no re-thanking for reaching out"),
      lacks(/compensation|salary|stack|interview process/i, "doesn't re-ask answered questions"),
      lacks(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i, "doesn't invent specific times"),
    ],
  },
  {
    id: "my_message_unanswered",
    expect: ["follow_up"],
    ctx: convo("Chris Wong", "Engineering Manager at Acme Corp", [
      them("Chris Wong", "Sep 8", "Hi Alex, we're hiring a remote Senior Engineer for our platform team. Interested?"),
      me("Sep 9", "Hi Chris, thanks for thinking of me. Is the role fully remote across the US, and what's the compensation range?"),
    ]),
    checks: [greets("Chris")],
  },
  {
    id: "pay_below_minimum",
    expect: ["remote_role"],
    ctx: convo("Nina Patel", "Recruiter at CloudBase", [
      them("Nina Patel", "Mon 2:00 PM",
        "Hi Alex, we have a fully remote Senior Django Engineer role at CloudBase, open to anyone in the US. " +
        "The base salary range is $110k-$125k plus equity. Would you like to hear more?"),
    ]),
    checks: [greets("Nina"), has(/160/, "states my minimum")],
  },
  {
    id: "networking_student",
    expect: ["networking"],
    ctx: convo("Ravi Kumar", "Computer Science student at Rutgers University", [
      them("Ravi Kumar", "Tue 7:30 PM",
        "Hi Alex, I'm a CS student and really enjoyed your post about scaling Django. Do you have any advice for someone " +
        "trying to land their first backend role?"),
    ]),
    checks: [greets("Ravi")],
  },
  {
    id: "outreach_new_thread",
    expect: ["outreach"],
    ctx: convo("Sarah Chen", "VP of Engineering at Stripe", [], { myNotes: "ask if her team is hiring remote backend engineers" }),
    checks: [greets("Sarah"), has(/remote/i)],
  },
  {
    // Notes for one reply outrank the saved profile (which says full stack, Python/Django/React).
    id: "notes_override_profile",
    expect: ["remote_role"],
    ctx: convo("Emily Carter", "Senior Technical Recruiter at Northwind Labs", [
      them("Emily Carter", "Mon 9:14 AM",
        "Hi Alex, I'm hiring a Senior Backend Engineer for Northwind Labs. The role is 100% remote. Would you be open to " +
        "a quick chat, and could you tell me a bit about your background?"),
    ], { myNotes: "Introduce me as a Backend Engineer, not full stack. Say my main stack is Go and Kubernetes." }),
    checks: [greets("Emily"), has(/backend engineer/i, "uses the title from my notes"), has(/Kubernetes/i, "uses the stack from my notes")],
  },
  {
    id: "spanish_recruiter",
    expect: ["remote_role"],
    ctx: convo("Lucía Gómez", "Reclutadora en DataViva", [
      them("Lucía Gómez", "Wed 12:00 PM",
        "Hola Alex, estamos buscando un Ingeniero Backend Senior (Python) para un puesto 100% remoto, abierto a candidatos " +
        "en EE. UU. y Canadá. ¿Te interesaría conversar?"),
    ]),
    checks: [has(/hola|gracias/i, "replies in Spanish")],
  },
  {
    id: "highlighted_profile_only",
    expect: ["outreach"],
    ctx: {
      participant: null,
      messages: [],
      selection:
        "Sarah Chen · VP of Engineering at Stripe\nAbout: 15 years building payments infrastructure and leading platform teams.\n" +
        "Experience: Stripe, Square, Google\nSkills: distributed systems, Go, Kubernetes",
    },
    checks: [has(/Sarah/)],
  },
];
