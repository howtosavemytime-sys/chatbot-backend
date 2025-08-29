// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import nodemailer from "nodemailer";
import { DateTime } from "luxon";
import fetch from "node-fetch"; // keep in package.json

const app = express();
app.use(cors());
app.use(bodyParser.json());

/* ========= ENV (email & optional global defaults) ========= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Email (unchanged)
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: process.env.MAIL_PORT,
  secure: process.env.MAIL_PORT == 465,
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});
const ADMIN_EMAIL = process.env.TO_EMAIL;

// OPTIONAL: Global Calendly defaults (used only if request doesn’t include creds)
const GLOBAL_CALENDLY_TOKEN = process.env.CALENDLY_TOKEN || "";
const GLOBAL_CALENDLY_EVENT_TYPE_URI = process.env.CALENDLY_EVENT_TYPE_URI || "";

// OPTIONAL: simple license enforcement (toggle + comma-separated keys)
const ENFORCE_LICENSE = process.env.LICENSE_ENFORCE === "true";
const LICENSE_KEYS = (process.env.LICENSE_KEYS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function isLicensed(licenseKey) {
  if (!ENFORCE_LICENSE) return true;
  if (!licenseKey) return false;
  return LICENSE_KEYS.includes(licenseKey);
}

/* ========= OpenAI ========= */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ========= Sessions (in-memory) ========= */
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
    };
    return { sessionId: newId, session: sessions[newId] };
  }
  if (now - sessions[sessionId].lastActive > SESSION_TIMEOUT_MS) {
    sessions[sessionId] = {
      messages: [],
      userName: null,
      userEmail: null,
      userPhone: null,
      marketingConsent: null,
      lastActive: now,
      messageCount: 0,
      askedBooking: false,
    };
  }
  sessions[sessionId].lastActive = now;
  return { sessionId, session: sessions[sessionId] };
}

/* ========= Slot helpers ========= */

// Fallback random slots (Mon–Fri, 10:00–16:00 CET/Paris)
function generateFallbackSlots(count = 3) {
  const slots = [];
  let dt = DateTime.now().setZone("Europe/Paris").plus({ days: 1 }).startOf("day");
  while (slots.length < count) {
    if (dt.weekday <= 5) {
      const hour = 10 + Math.floor(Math.random() * 7); // 10..16
      const minute = Math.random() < 0.5 ? 0 : 30;
      const slot = dt.set({ hour, minute });
      slots.push(slot.toISO({ suppressMilliseconds: true }));
    }
    dt = dt.plus({ days: 1 });
  }
  return slots;
}

// Calendly: fetch available start times for next 7 days
async function getCalendlyAvailableTimes(tokenOverride, eventTypeUriOverride) {
  const token = tokenOverride || GLOBAL_CALENDLY_TOKEN;
  const eventTypeUri = eventTypeUriOverride || GLOBAL_CALENDLY_EVENT_TYPE_URI;
  if (!token || !eventTypeUri) return null;

  try {
    const start = DateTime.now().toUTC().startOf("day");
    const end = start.plus({ days: 7 }); // Calendly requires <= 7 days

    const url = new URL("https://api.calendly.com/event_type_available_times");
    url.searchParams.set("event_type", eventTypeUri);
    url.searchParams.set("start_time", start.toISO());
    url.searchParams.set("end_time", end.toISO());

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error("Calendly availability error:", resp.status, txt);
      return null;
    }
    const data = await resp.json();
    const col = Array.isArray(data?.collection) ? data.collection : [];
    return col.map(i => i.start_time).slice(0, 12); // ISO strings
  } catch (e) {
    console.error("Calendly fetch failed:", e);
    return null;
  }
}

// Booksy: placeholder (returns null). Wire real API when you have access.
async function getBooksyAvailableTimes({ apiKey, businessId, locationId, serviceId }) {
  // TODO: Implement Booksy availability call here once you have official API docs/keys.
  // Ideas:
  // - GET /availability?business={businessId}&location={locationId}&service={serviceId}&from=...&to=...
  // - Use bearer apiKey in Authorization header
  // Return array of ISO start times like Calendly function above.
  console.warn("Booksy availability not implemented yet.");
  return null;
}

/* ========= Health ========= */
app.get("/health", (_, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

/* ========= Chat ========= */
app.post("/chat", async (req, res) => {
  const {
    message,
    sessionId,
    userName,
    userEmail,
    userPhone,
    marketingConsent,

    // From WP plugin (branding & knowledge)
    companyName,
    botName,
    tone = "friendly",
    language = "en",
    fallback = "Sorry, I don't have the answer to that right now. Please send us an email and one of our representatives will come back to you.",
    aboutText = "",
    allowedServices = [],
    faqs = [],

    // License
    licenseKey,

    // Booking provider + creds
    bookingProvider = "none", // none | calendly | booksy
    calendlyToken,
    calendlyEventTypeUri,
    booksyApiKey,
    booksyBusinessId,
    booksyLocationId,
    booksyServiceId,
  } = req.body || {};

  // License gate
  if (!isLicensed(licenseKey)) {
    return res.status(402).json({ reply: fallback });
  }

  const { sessionId: activeSessionId, session } = getSession(sessionId);

  if (userName) session.userName = userName;
  if (userEmail) session.userEmail = userEmail;
  if (userPhone) session.userPhone = userPhone;
  if (marketingConsent !== undefined) session.marketingConsent = marketingConsent;

  // Build system prompt from WP settings
  const servicesList = Array.isArray(allowedServices) ? allowedServices.filter(Boolean) : [];
  const faqsList = Array.isArray(faqs)
    ? faqs.filter(f => f && f.q && f.a).map(f => `Q: ${f.q}\nA: ${f.a}`).join("\n\n")
    : "";

  const style =
    tone === "formal"
      ? "Use a professional, concise tone."
      : "Use a friendly, approachable tone.";

  const systemMessage = `
You are the chatbot for "${companyName || "Your Company"}"${botName ? `, named ${botName}` : ""}.
${style} Reply in language code: ${language}.

BUSINESS PROFILE:
${aboutText || "(no profile provided)"}

FAQS (use exactly if relevant):
${faqsList || "(none)"}

${servicesList.length
  ? `Only answer about these services: ${servicesList.join(", ")}. If asked outside this list, respond with: "${fallback}".`
  : `Only answer about the company based on the profile and FAQs above. If asked outside scope, respond with: "${fallback}".`
}

Behavior:
- Greet by name if available.
- Be clear for non-technical users.
- Keep answers brief unless asked for detail.
- If unsure or out of scope, say the fallback line above.
`.trim();

  // Track conversation
  if (message) {
    session.messages.push({ role: "user", content: message });
    session.messageCount++;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "system", content: systemMessage }, ...session.messages],
    });

    let replyText =
      completion.choices?.[0]?.message?.content?.trim() ||
      fallback;

    // Booking offer after 3 msg and having name+email
    let bookingSlots = null;
    if (
      session.messageCount >= 3 &&
      session.userName &&
      session.userEmail &&
      !session.askedBooking
    ) {
      session.askedBooking = true;

      // Try chosen provider → fallback if needed
      let isoStarts = null;

      if (bookingProvider === "calendly") {
        isoStarts = await getCalendlyAvailableTimes(calendlyToken, calendlyEventTypeUri);
      } else if (bookingProvider === "booksy") {
        isoStarts = await getBooksyAvailableTimes({
          apiKey: booksyApiKey,
          businessId: booksyBusinessId,
          locationId: booksyLocationId,
          serviceId: booksyServiceId,
        });
      }

      if (!isoStarts || !isoStarts.length) {
        isoStarts = generateFallbackSlots(3);
      }

      replyText += `\n\nWould you like to book a 30-minute appointment with our representative?`;
      bookingSlots = isoStarts.slice(0, 3).map(s => ({ start: s }));
    }

    session.messages.push({ role: "assistant", content: replyText });
    return res.json({ reply: replyText, sessionId: activeSessionId, bookingSlots });

  } catch (error) {
    console.error("Chat error:", error);
    return res.json({
      reply: fallback,
      sessionId: activeSessionId,
    });
  }
});

/* ========= Booking (email notification) ========= */
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
Requested Time: ${startTime} (ISO/UTC)
`;

  try {
    await transporter.sendMail({
      from: `"MadeToAutomate Bot" <${process.env.MAIL_USER}>`,
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
    res
      .status(500)
      .json({ success: false, message: "Failed to send booking info. Try again later." });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
