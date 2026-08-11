/**
 * Empire ABA — chat backend (Cloudflare Worker)
 * ---------------------------------------------------------------------------
 * The widget on the website talks ONLY to this Worker. The secret API keys
 * live here (as Wrangler secrets), never in the browser, so they can't be
 * stolen by viewing the page source.
 *
 * Two endpoints:
 *   POST /chat   -> answers a visitor question with Claude (optional; only used
 *                   if the widget is in "ai" mode)
 *   POST /lead   -> emails you the captured lead + transcript (via Resend)
 *
 * Secrets (set with:  npx wrangler secret put NAME):
 *   ANTHROPIC_API_KEY   - your Anthropic API key (only needed for /chat)
 *   RESEND_API_KEY      - your Resend API key    (only needed for /lead)
 *
 * Vars (in wrangler.toml [vars], safe to be public):
 *   ALLOWED_ORIGINS  - comma-separated site origins allowed to call this
 *   MODEL            - e.g. claude-sonnet-4-6  (or claude-haiku-4-5 for cheapest)
 *   LEAD_TO          - inbox that receives leads, e.g. info@empireaba.com
 *   LEAD_FROM        - verified sender, e.g. "Empire ABA Chat <chat@empireaba.com>"
 */

import WIDGET_JS from "./widget.txt";
import AVATAR_JPG from "./avatar.jpg"; // binary module -> ArrayBuffer

const SYSTEM_PROMPT = `You are Riley, the friendly virtual assistant for Empire ABA, which provides in-home ABA (Applied Behavior Analysis) therapy for children with autism.

YOUR JOB
Have a warm, natural conversation with website visitors. Answer their questions, and over the course of the chat gather what the team needs to follow up. Keep every reply SHORT — 1 to 3 sentences. Warm, plain-spoken, neurodiversity-affirming. Never clinical or cold. No bullet lists.

GATHERING — ORDER AND RESTRAINT
Gather details in this exact order: (1) location, (2) child's age, (3) insurance, (4) email, (5) phone number, (6) name.
Email is the most important contact detail, but always ask for a phone number too. Ask, "What's the best email to contact you at?" and then ask for their phone number before asking their name.
- Ask for ONE thing at a time, woven into the conversation. Never list questions.
- Location always comes first. Ask exactly, "What city or area are you in?" Do not mention or assume a state, and do not limit the question to any geographic area.
- Ask the child's age warmly and explain why, for example: "So we can better understand what support may be a good fit, how old is your child?"
- Respond positively to every location with a simple acknowledgment such as, "Great, we serve that area." Never reject or screen someone out because of their location, and never offer to guide them to a partner or another provider.
- Respond positively to every insurance plan. Say that Empire ABA works with that insurance. Do not reject or screen someone out because their plan is not listed; explain that the team will verify their exact benefits for free.
- If someone declines to answer something, drop it immediately and never ask again.
- After asking for both email and phone, ask for their name last, then stop asking and wrap up warmly.
- Never hold up the handoff if someone declines a detail. The team can gather anything missing during follow-up.

FACTS YOU MAY SHARE
- Empire ABA provides IN-HOME ABA therapy. Therapists come to the family's home.
- Phone number: 910-773-1234. This is the only phone number Riley should give visitors, regardless of their location.
- Email: info@empireaba.com. Careers: empireaba.com/enrollment.
- ABA builds communication, social, daily-living, and safety skills. It gives children tools to thrive, never changes who they are.
- Services include in-home therapy, parent support, school collaboration, and community-based support.
- Insurance: Medicaid and most major commercial plans, including Blue Cross NC, UnitedHealthcare, Aetna, Cigna, plus NC Medicaid plans Alliance Health, AmeriHealth Caritas NC, Carolina Complete Health, Healthy Blue, Partners, Vaya Health, WellCare, and Trillium. Whatever insurance a visitor names, respond warmly that Empire ABA works with that insurance and that the team will verify their exact benefits for free before therapy starts.

HARD RULES
- Never diagnose or give medical advice.
- Never promise specific coverage, weekly hours, or outcomes. Those are decided case by case after a BCBA assessment — say the team will confirm.
- If someone describes an emergency, crisis, or risk of harm, tell them to call 911 or a crisis line immediately.
- If you don't know something, say the team can help and ask for their contact info.
- Never invent phone numbers, prices, hour counts, wait times, or policies.
- Never recommend, mention, or offer to connect the visitor with a partner, another provider, or an outside organization. Continue helping them through Empire ABA.

FINISHING
After you have asked for location, child's age, insurance, email, phone number, and name—in that order—thank them warmly, tell them the team will reach out soon, and mention 910-773-1234 as the number they can call. If they declined any detail, leave it blank and do not ask again. Append this exact marker to the very end of that message:
[[DONE name="..." phone="..." email="..." region="..." age="..." insurance="..."]]
Fill in what you know; leave anything unknown as an empty string. Include the marker only once.

Write only your next reply as Riley — no JSON, no quotation marks, no "Riley:" label.`;

// naive in-memory rate limit (per Worker isolate). Good enough for a low-traffic
// site; swap for KV/Durable Objects if you need strict global limits.
const RL = new Map();
const RL_MAX = 30; // requests
const RL_WINDOW_MS = 60 * 1000; // per minute per IP

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Serve the widget itself, so the site needs only this one origin:
    // <script src="https://<worker>/widget.js" ...></script>
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/widget.js" || url.pathname === "/")) {
      return new Response(WIDGET_JS, {
        status: 200,
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "public, max-age=300",
          "access-control-allow-origin": "*",
        },
      });
    }

    // Only allow known origins to POST
    if (!originAllowed(origin, env)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    if (request.method === "GET" && url.pathname === "/avatar.jpg") {
      return new Response(AVATAR_JPG, {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "public, max-age=86400",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, cors);
    }

    // Rate limit by IP
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (rateLimited(ip)) {
      return json({ error: "Too many requests, please slow down." }, 429, cors);
    }

    try {
      if (url.pathname === "/lead") {
        return await handleLead(request, env, cors);
      }
      if (url.pathname === "/chat") {
        return await handleChat(request, env, cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      console.error("Worker error:", err && err.message);
      return json({ error: "Server error" }, 500, cors);
    }
  },
};

/* ------------------------------- /chat ---------------------------------- */

async function handleChat(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "AI not configured" }, 501, cors);
  }
  const body = await request.json().catch(() => ({}));
  const messages = Array.isArray(body.messages) ? body.messages : [];

  // sanitize: keep only role/content, cap length + count
  const clean = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (clean.length === 0) {
    return json({ error: "No message" }, 400, cors);
  }

  // Fold whatever the widget has collected so far into the system prompt, so
  // Claude doesn't re-ask for details the visitor already gave.
  const L = body.lead && typeof body.lead === "object" ? body.lead : {};
  const known =
    "\n\nWHAT YOU ALREADY KNOW ABOUT THIS VISITOR\n" +
    "(Blank means not collected yet. Never re-ask for a filled-in field, and never guess a blank one.)\n" +
    "Region: " + (str(L.region) || "(blank)") + "\n" +
    "Child's age: " + (str(L.childAge) || "(blank)") + "\n" +
    "Insurance: " + (str(L.insurance) || "(blank)") + "\n" +
    "Name: " + (str(L.name) || "(blank)") + "\n" +
    "Phone: " + (str(L.phone) || "(blank)") + "\n" +
    "Email: " + (str(L.email) || "(blank)") + "\n" +
    "Page they are on: " + (str(body.page) || "(blank)");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.MODEL || "claude-sonnet-4-6",
      max_tokens: 400,
      system: SYSTEM_PROMPT + known,
      messages: clean,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error("Anthropic error:", resp.status, detail.slice(0, 300));
    return json({ error: "AI request failed" }, 502, cors);
  }

  const data = await resp.json();
  const reply = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return json({ reply: reply || "Sorry, I didn't catch that — could you rephrase?" }, 200, cors);
}

/* ------------------------------- /lead ---------------------------------- */

async function handleLead(request, env, cors) {
  if (!env.RESEND_API_KEY) {
    return json({ error: "Email not configured" }, 501, cors);
  }
  const body = await request.json().catch(() => ({}));
  const lead = body.lead || {};
  const transcript = Array.isArray(body.transcript) ? body.transcript : [];

  const name = str(lead.name) || "(not provided)";
  const phone = str(lead.phone) || "(not provided)";
  const email = str(lead.email) || "(not provided)";
  const childAge = str(lead.childAge) || "(not provided)";
  const insurance = str(lead.insurance) || "(not provided)";
  const notes = str(lead.notes) || "";
  const interest = str(lead.interest) || "";

  const transcriptText = transcript
    .filter((m) => m && m.role && typeof m.content === "string")
    .map((m) => `${m.role === "user" ? "Visitor" : "Bot"}: ${m.content}`)
    .join("\n");

  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#1a1a2e;line-height:1.55">
      <h2 style="margin:0 0 12px">New chat lead — Empire ABA</h2>
      <table style="border-collapse:collapse;width:100%;max-width:560px">
        ${row("Name", name)}
        ${row("Phone", phone)}
        ${row("Email", email)}
        ${row("Child's age", childAge)}
        ${row("Insurance", insurance)}
        ${interest ? row("Looking for", interest) : ""}
        ${notes ? row("Notes", notes) : ""}
      </table>
      ${
        transcriptText
          ? `<h3 style="margin:20px 0 8px">Conversation</h3>
             <pre style="white-space:pre-wrap;background:#f4f4f8;padding:12px 14px;border-radius:8px;font-family:inherit;font-size:14px">${esc(
               transcriptText
             )}</pre>`
          : ""
      }
      <p style="color:#666;font-size:12px;margin-top:16px">Sent by the Empire ABA website chat.</p>
    </div>`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.LEAD_FROM || "Empire ABA Chat <onboarding@resend.dev>",
      to: [env.LEAD_TO || "info@empireaba.com"],
      reply_to: email !== "(not provided)" ? email : undefined,
      subject: `New chat lead: ${name}`,
      html,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error("Resend error:", resp.status, detail.slice(0, 300));
    return json({ error: "Could not send lead" }, 502, cors);
  }

  return json({ ok: true }, 200, cors);
}

/* ------------------------------ helpers --------------------------------- */

function row(label, value) {
  return `<tr>
    <td style="padding:6px 10px;border:1px solid #e2e2ee;background:#fafafe;font-weight:600;white-space:nowrap">${esc(
      label
    )}</td>
    <td style="padding:6px 10px;border:1px solid #e2e2ee">${esc(value)}</td>
  </tr>`;
}

function str(v) {
  return typeof v === "string" ? v.trim().slice(0, 500) : "";
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function originAllowed(origin, env) {
  const list = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // If nothing configured, be safe and deny cross-origin (only same-origin/no-Origin).
  if (list.length === 0) return origin === "";
  return origin === "" || list.includes(origin);
}

function corsHeaders(origin, env) {
  const allowed = originAllowed(origin, env) && origin ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowed || "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function rateLimited(ip) {
  const now = Date.now();
  const entry = RL.get(ip);
  if (!entry || now - entry.start > RL_WINDOW_MS) {
    RL.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RL_MAX;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}
