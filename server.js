// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import nodemailer from "nodemailer";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== OpenAI =====
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== Email (optional but recommended) =====
// Set these in Render -> Environment:
// MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASS, FROM_EMAIL, TO_EMAIL
let mailer = null;
if (process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT || 587),
    secure: String(process.env.MAIL_SECURE || "false") === "true",
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
  });
  // Optional: verify SMTP on boot
  mailer.verify().then(
    () => console.log("SMTP ready"),
    (e) => console.warn("SMTP verify failed (will fallback to console log):", e.message)
  );
}

const FROM_EMAIL = process.env.FROM_EMAIL || "no-reply@madetoautomate.com";
const TO_EMAIL = process.env.TO_EMAIL || "contact@madetoautomate.com";

// ===== Simple in-memory sessions =====
const sessions = {};
const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const MESSAGE_LIMIT = 50; // generous limit; tweak if you want tighter control

function getSession(sessionId) {
  const now = Date.now();

  if (!sessionId || !sessions[sessionId]) {
    const newId = uuidv4();
    sessions[newId] = {
      count: 0,
      lastActive: now,
      name: null,
      email: null,
      marketingConsent: null,
      lastAppointment: null, // ISO string
      offeredBooking: false,
      messages: [], // [{role:'user'|'assistant', content:'...'}]
    };
    return { sessionId: newId, session: sessions[newId] };
  }

  if (now - sessions[sessionId].lastActive > SESSION_TIMEOUT_MS) {
    sessions[sessionId] = {
      count: 0,
      lastActive: now,
      name: null,
      email: null,
      marketingConsent: null,
      lastAppointment: null,
      offeredBooking: false,
      messages: [],
    };
  }

  sessions[sessionId].lastActive = now;
  return { sessionId, session: sessions[sessionId] };
}

// Generate 3 suggested slots (next business days at 10:00, 14:00, 16:00 local time)
function getSuggestedSlots() {
  const slots = [];
  const hours = [10, 14, 16]; // 10:00, 14:00, 16:00
  let dayOffset = 1;

  while (slots.length < 3) {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);

    // skip weekends
    const weekday = d.getDay(); // 0 Sun, 6 Sat
    if (weekday !== 0 && weekday !== 6) {
      for (const h of hours) {
        if (slots.length >= 3) break;
        const slot = new Date(d);
        slot.setHours(h, 0, 0, 0);
        if (slot > new Date()) {
          slots.push({ start: slot.toISOString() });
        }
      }
    }
    dayOffset++;
  }
  return slots;
}

// ====== /chat ======
app.post("/chat", async (req, res) => {
  const { message, sessionId, userName, userEmail, marketingConsent } = req.body || {};
  const { sessionId: activeSessionId, session } = getSession(sessionId);

  // Persist user info if provided
  if (userName && !session.name) session.name = userName;
  if (userEmail && !session.email) session.email = userEmail;
  if (typeof marketingConsent === "boolean" && session.marketingConsent === null) {
    session.marketingConsent = marketingConsent;
  }

  // Hard cap
  if (session.count >= MESSAGE_LIMIT) {
    return res.json({
      reply:
        "We’ve covered a lot! If you need more help, please request a discovery call and we’ll follow up by email.",
      sessionId: activeSessionId,
    });
  }

  session.count++;
  session.messages.push({ role: "user", content: message || "" });

  // Build dynamic memory for the assistant
  const memory = `
Known user info:
- Name: ${session.name || "(unknown)"}
- Email: ${session.email || "(unknown)"}
- Marketing consent: ${session.marketingConsent === null ? "(unknown)" : session.marketingConsent ? "yes" : "no"}
- Last appointment: ${session.lastAppointment ? new Date(session.lastAppointment).toString() : "(none)"}
`;

  const systemMessage = `
You are a friendly, approachable chatbot for MadeToAutomate.
ONLY answer questions about MadeToAutomate services, workflows, and processes.
If the user asks something unrelated, respond: 
"Sorry, I can only answer questions about MadeToAutomate services. Can I help you with something we do?"
Always use clear, simple language. Greet or refer to the user by name if known.

FAQ (short):
- Who we help: businesses & individuals with workflow automation (email, reporting, CRM, e-commerce, scheduling, support bots).
- Process: Free Discovery Call → Automation Plan → Build & Launch → Ongoing Support.

Use this conversation memory to personalize answers:
${memory}
`;

  // After 3rd user message (first real mini-engagement), offer booking once per session
  let bookingSlots = null;
  let injectBookingPrompt = false;
  if (session.count === 3 && !session.offeredBooking) {
    bookingSlots = getSuggestedSlots();
    session.offeredBooking = true;
    injectBookingPrompt = true;
  }

  try {
    // Keep the last few turns for context
    const history = session.messages.slice(-8);

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemMessage },
        ...history,
      ],
    });

    const replyText =
      completion.choices?.[0]?.message?.content ||
      "Sorry, I can only answer questions about MadeToAutomate services. Can I help you with something we do?";

    session.messages.push({ role: "assistant", content: replyText });

    // If we are offering booking now, prepend a booking line to the reply
    let finalReply = replyText;
    if (injectBookingPrompt && bookingSlots?.length) {
      finalReply =
        "If you'd like, we can schedule a quick discovery call. Pick a time below, and we'll confirm by email.\n\n" +
        replyText;
    }

    res.json({
      reply: finalReply,
      sessionId: activeSessionId,
      bookingSlots: bookingSlots || undefined,
    });
  } catch (err) {
    console.error("OpenAI error:", err);
    res.json({
      reply:
        "Sorry, I’m having a little trouble right now. Can we continue talking about MadeToAutomate services?",
      sessionId: activeSessionId,
    });
  }
});

// ====== /book ======
app.post("/book", async (req, res) => {
  const { sessionId, startTime, userName, userEmail } = req.body || {};
  const { sessionId: activeSessionId, session } = getSession(sessionId);

  // Fall back to session info
  const name = userName || session.name || "Guest";
  const email = userEmail || session.email || "(no email provided)";
  session.lastAppointment = startTime || null;

  const subject = `New Discovery Call Request from ${name}`;
  const text =
`A new discovery call has been requested.

Name: ${name}
Email: ${email}
Requested time (ISO): ${startTime}

Please reply to confirm the appointment with the invitee.
`;

  try {
    if (mailer) {
      await mailer.sendMail({
        from: FROM_EMAIL,
        to: TO_EMAIL,
        subject,
        text,
      });
      console.log("Appointment request emailed to", TO_EMAIL);
    } else {
      // No SMTP configured: log to server only
      console.log("=== Appointment request (no SMTP configured) ===");
      console.log(text);
    }

    return res.json({
      success: true,
      message: `Thanks! Someone from our team will contact you at ${email} to confirm your appointment.`,
      sessionId: activeSessionId,
    });
  } catch (e) {
    console.error("Email send error:", e.message);
    // Still acknowledge to the user (don’t break UX)
    return res.json({
      success: true,
      message: `Thanks! Someone from our team will contact you at ${email} to confirm your appointment.`,
      sessionId: activeSessionId,
    });
  }
});

// ===== Start server =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
