// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import nodemailer from "nodemailer";
import { DateTime } from "luxon";

const app = express();
app.use(cors()); // adjust origins later if you want to restrict
app.use(bodyParser.json());

// ---- OpenAI ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-3.5-turbo";

// ---- Email (booking notifications) ----
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: process.env.MAIL_PORT,
  secure: String(process.env.MAIL_PORT) === "465",
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});
const ADMIN_EMAIL = process.env.TO_EMAIL;

// ---- Health ----
app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ---- In-memory session store ----
const sessions = {};
const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

function getSession(sessionId) {
  const now = Date.now();
  if (!sessionId || !sessions[sessionId]) {
    const newId = uuidv4();
    sessions[newId] = {
      messages: [],
      userName: null,
      userEmail: null,
      userPhone: null,
      marketingConsent: null,
      lastActive: now,
      messageCount: 0,
      askedBooking: false,

      // config sent from plugin (persist per session)
      companyName: null,
      tone: "friendly",
      language: "en",
      fallback: "Sorry, I don't have the answer to that right now.",
      faqs: [], // [{q, a}]
    };
    return { sessionId: newId, session: sessions[newId] };
  }
  if (now - sessions[sessionId].lastActive > SESSION_TIMEOUT_MS) {
    // reset expired session but keep same id for simplicity
    sessions[sessionId] = {
      messages: [],
      userName: null,
      userEmail: null,
      userPhone: null,
      marketingConsent: null,
      lastActive: now,
      messageCount: 0,
      askedBooking: false,
      companyName: null,
      tone: "friendly",
      language: "en",
      fallback: "Sorry, I don't have the answer to that right now.",
      faqs: [],
    };
  }
  sessions[sessionId].lastActive = now;
  return { sessionId, session: sessions[sessionId] };
}

function generateBookingSlots() {
  const slots = [];
  let dt = DateTime.now().setZone("Europe/Paris").plus({ days: 1 }).startOf("day");
  while (slots.length < 3) {
    if (dt.weekday <= 5) { // Mon-Fri
      const hour = 10 + Math.floor(Math.random() * 7); // 10..16
      const minute = Math.random() < 0.5 ? 0 : 30;
      const slot = dt.set({ hour, minute });
      slots.push(slot.toFormat("yyyy-MM-dd HH:mm"));
    }
    dt = dt.plus({ days: 1 });
  }
  return slots;
}

// ---- (Optional) Licensing hook ----
// Return false to block usage. Wire this up to your subscription system later.
function isLicensed(licenseKey, originHost) {
  // TODO: check licenseKey against your DB / Stripe webhook etc.
  // You can also gate by originHost (domain).
  return true; // allow all for now
}

// ---- Build system prompt dynamically from plugin config ----
function buildSystemPrompt({ companyName, tone, language, fallback, faqs }) {
  const brand = companyName?.trim() || "the client";
  const toneText = tone === "formal" ? "formal and professional" : "friendly and approachable";
  const lang = language || "en";

  // Add FAQs as lightweight grounding context
  let faqBlock = "";
  if (Array.isArray(faqs) && faqs.length > 0) {
    const top = faqs.slice(0, 25) // keep prompt light
      .map((f, i) => `Q${i + 1}: ${f.q}\nA${i + 1}: ${f.a}`)
      .join("\n\n");
    faqBlock = `\n\nKnowledge (FAQs provided by the site owner):\n${top}\n\nIf a user asks something that matches these FAQs, answer directly using them.`;
  }

  // Critical guardrails: only talk about the client's business; if unknown, use fallback.
  const guardrails = `
You are the chatbot for ${brand}.
- Tone: ${toneText}.
- Language: ${lang} (reply in this language).
- Only answer questions about ${brand}'s services, workflows, policies, processes, or other info provided by the site owner.
- If the user asks for anything outside the scope or you don't know the answer, reply EXACTLY with the fallback text (no extra words): "${fallback}"
- Greet the user by their name if it was provided.
${faqBlock}
`;

  return guardrails;
}

// --------------- Chat endpoint (driven by plugin config) ---------------
app.post("/chat", async (req, res) => {
  const {
    message,
    sessionId,
    userName,
    userEmail,
    userPhone,
    marketingConsent,

    // config coming from the plugin:
    companyName,
    tone,        // "friendly" | "formal"
    language,    // "en" | "es" | "fr" | "de" | etc.
    fallback,    // string fallback
    faqs,        // [{q, a}]
    licenseKey,  // optional - for future subscription control
  } = req.body || {};

  // License check (optional)
  const originHost = (req.headers.origin || "").replace(/^https?:\/\//, "");
  if (!isLicensed(licenseKey, originHost)) {
    return res.status(402).json({
      reply: "Your subscription is inactive. Please contact the site owner.",
      sessionId: null,
      bookingSlots: null,
    });
  }

  // Session
  const { sessionId: activeSessionId, session } = getSession(sessionId);

  // Persist user fields if provided
  if (userName) session.userName = userName;
  if (userEmail) session.userEmail = userEmail;
  if (userPhone) session.userPhone = userPhone;
  if (marketingConsent !== undefined) session.marketingConsent = marketingConsent;

  // Persist config coming from plugin
  if (companyName) session.companyName = companyName;
  if (tone) session.tone = tone;
  if (language) session.language = language;
  if (fallback) session.fallback = fallback;
  if (Array.isArray(faqs)) session.faqs = faqs;

  // Save user message
  session.messages.push({ role: "user", content: message || "" });
  session.messageCount++;

  // Build system message from persisted session config
  const systemMessage = buildSystemPrompt({
    companyName: session.companyName,
    tone: session.tone,
    language: session.language,
    fallback: session.fallback,
    faqs: session.faqs,
  });

  try {
    const completion = await openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: systemMessage },
        ...session.messages,
      ],
      temperature: 0.3,
    });

    let replyText =
      completion?.choices?.[0]?.message?.content?.trim() ||
      session.fallback ||
      "Sorry, I don't have the answer to that right now.";

    // Offer booking after 3 messages if we have name+email and we haven't asked yet
    let bookingSlots = null;
    if (
      session.messageCount >= 3 &&
      session.userName &&
      session.userEmail &&
      !session.askedBooking
    ) {
      session.askedBooking = true;
      replyText += `

Would you like to book a 30-minute appointment with our representative?`;
      bookingSlots = generateBookingSlots().map((s) => ({ start: s }));
    }

    session.messages.push({ role: "assistant", content: replyText });

    res.json({ reply: replyText, sessionId: activeSessionId, bookingSlots });
  } catch (error) {
    console.error("Chat error:", error);
    res.json({
      reply: session.fallback || "Sorry, something went wrong. Please try again.",
      sessionId: activeSessionId,
      bookingSlots: null,
    });
  }
});

// --------------- Booking endpoint ---------------
app.post("/book", async (req, res) => {
  const { startTime, userName, userEmail, marketingConsent } = req.body || {};

  if (!userName || !userEmail || !startTime) {
    return res.status(400).json({ success: false, message: "Missing booking info" });
  }

  const emailText = `
New Discovery Call Booking Request:

Name: ${userName}
Email: ${userEmail}
Marketing Consent: ${marketingConsent === true ? "Agreed" : "Declined"}
Requested Time: ${startTime} CET
`;

  try {
    await transporter.sendMail({
      from: `"Website Bot" <${process.env.MAIL_USER}>`,
      to: ADMIN_EMAIL,
      subject: "New Discovery Call Booking",
      text: emailText,
    });

    res.json({
      success: true,
      message: `Thanks ${userName}! Someone from our team will contact you shortly to confirm the appointment.`,
    });
  } catch (err) {
    console.error("Booking email error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to send booking info. Try again later.",
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
