// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import nodemailer from "nodemailer";
import { DateTime } from "luxon";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(bodyParser.json());

/* ========= ENV ========= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Email transport
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: process.env.MAIL_PORT,
  secure: process.env.MAIL_PORT == 465,
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});
const ADMIN_EMAIL = process.env.TO_EMAIL;

// Optional global Calendly defaults
const GLOBAL_CALENDLY_TOKEN = process.env.CALENDLY_TOKEN || "";
const GLOBAL_CALENDLY_EVENT_TYPE_URI = process.env.CALENDLY_EVENT_TYPE_URI || "";

// License handling
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

/* ========= Sessions ========= */
const sessions = {};
const SESSION_TIMEOUT_MS = 60 * 60 * 1000;

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
function generateFallbackSlots(count = 3) {
  const slots = [];
  let dt = DateTime.now().setZone("Europe/Paris").plus({ days: 1 }).startOf("day");
  while (slots.length < count) {
    if (dt.weekday <= 5) {
      const hour = 10 + Math.floor(Math.random() * 7);
      const minute = Math.random() < 0.5 ? 0 : 30;
      const slot = dt.set({ hour, minute });
      slots.push(slot.toISO({ suppressMilliseconds: true }));
    }
    dt = dt.plus({ days: 1 });
  }
  return slots;
}

/* ========= Calendly helpers ========= */
async function calendlyGetUserUri(token) {
  const resp = await fetch("https://api.calendly.com/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.resource?.uri || null;
}

async function calendlyListEventTypesByUser(token, userUri) {
  const url = new URL("https://api.calendly.com/event_types");
  url.searchParams.set("user", userUri);
  url.searchParams.set("active", "true");
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return Array.isArray(data?.collection) ? data.collection : [];
}

async function resolveCalendlyEventTypeUri({ token, providedEventTypeUri, schedulingLink }) {
  if (!token) return null;
  if (providedEventTypeUri) return providedEventTypeUri;

  // Try to match scheduling link slug
  let desiredSlug = null;
  if (schedulingLink) {
    try {
      const u = new URL(schedulingLink);
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) desiredSlug = parts[1].toLowerCase();
    } catch {}
  }

  const userUri = await calendlyGetUserUri(token);
  if (!userUri) return null;

  const types = await calendlyListEventTypesByUser(token, userUri);
  if (!types.length) return null;

  if (desiredSlug) {
    const match = types.find(t => (t.slug || "").toLowerCase() === desiredSlug);
    if (match?.uri) return match.uri;
  }

  const thirty = types.find(
    t => String(t?.duration) === "30" || /30/.test(String(t?.name || ""))
  );
  if (thirty?.uri) return thirty.uri;

  return types[0].uri || null;
}

async function getCalendlyAvailableTimes(tokenOverride, eventTypeUriOverride, schedulingLinkOverride) {
  const token = tokenOverride || GLOBAL_CALENDLY_TOKEN;
  if (!token) return null;

  const finalEventTypeUri =
    eventTypeUriOverride ||
    (await resolveCalendlyEventTypeUri({
      token,
      providedEventTypeUri: eventTypeUriOverride,
      schedulingLink: schedulingLinkOverride,
    }));

  if (!finalEventTypeUri) return null;

  try {
    const start = DateTime.now().toUTC().startOf("day");
    const end = start.plus({ days: 7 });

    const url = new URL("https://api.calendly.com/event_type_available_times");
    url.searchParams.set("event_type", finalEventTypeUri);
    url.searchParams.set("start_time", start.toISO());
    url.searchParams.set("end_time", end.toISO());

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const col = Array.isArray(data?.collection) ? data.collection : [];
    return col.map(i => i.start_time).slice(0, 12);
  } catch (e) {
    console.error("Calendly fetch failed:", e);
    return null;
  }
}

/* ========= Booksy placeholder ========= */
async function getBooksyAvailableTimes({ apiKey, businessId, locationId, serviceId }) {
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
    companyName,
    botName,
    tone = "friendly",
    language = "en",
    fallback = "Sorry, I don't have the answer to that right now. Please send us an email and one of our representatives will come back to you.",
    aboutText = "",
    allowedServices = [],
    faqs = [],
    licenseKey,
    bookingProvider = "none",
    calendlyToken,
    calendlyEventTypeUri,
    calendlySchedulingLink,
    booksyApiKey,
    booksyBusinessId,
    booksyLocationId,
    booksyServiceId,
    fileData, // NEW: File attachment data
  } = req.body || {};

  if (!isLicensed(licenseKey)) {
    return res.status(402).json({ reply: fallback });
  }

  const { sessionId: activeSessionId, session } = getSession(sessionId);
  if (userName) session.userName = userName;
  if (userEmail) session.userEmail = userEmail;
  if (userPhone) session.userPhone = userPhone;
  if (marketingConsent !== undefined) session.marketingConsent = marketingConsent;

  const faqsList = Array.isArray(faqs)
    ? faqs.filter(f => f && f.q && f.a).map(f => `Q: ${f.q}\nA: ${f.a}`).join("\n\n")
    : "";

  const style =
    tone === "formal"
      ? "Use a professional, concise tone."
      : "Use a friendly, approachable tone.";

  // NEW: Handle file attachments
  let fileContext = "";
  let useVisionModel = false;
  
  if (fileData && fileData.url) {
    const fileExt = fileData.name.split('.').pop().toLowerCase();
    
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExt)) {
      // Image file - use vision model
      useVisionModel = true;
      fileContext = `The user has shared an image file: ${fileData.name}. Please analyze and describe what you see in this image.`;
    } else if (['pdf', 'doc', 'docx', 'txt'].includes(fileExt)) {
      // Document file
      fileContext = `The user has shared a document: ${fileData.name}. While I cannot directly read the file content, I can help answer questions about documents, provide guidance on document analysis, or suggest how to work with this type of file.`;
    } else {
      // Other file types
      fileContext = `The user has shared a file: ${fileData.name} (${fileData.type}). I can provide general information about this file type or suggest ways to work with it.`;
    }
  }

  const systemMessage = `
You are the chatbot for "${companyName || "Your Company"}"${botName ? `, named ${botName}` : ""}.
${style} Reply in language code: ${language}.

BUSINESS PROFILE:
${aboutText || "(no profile provided)"}

FAQS:
${faqsList || "(none)"}

${fileContext}

${allowedServices.length
  ? `Only answer about these services: ${allowedServices.join(", ")}. If asked outside this list, respond with: "${fallback}".`
  : `Only answer about the company. If asked outside scope, respond with: "${fallback}".`}
`.trim();

  if (message) {
    session.messages.push({ role: "user", content: message });
    session.messageCount++;
  }

  try {
    let messages = [{ role: "system", content: systemMessage }, ...session.messages];
    
    // NEW: If image file, modify the last user message to include the image
    if (useVisionModel && fileData && fileData.url) {
      // Replace the last user message with vision-compatible format
      const lastMessageIndex = messages.length - 1;
      if (messages[lastMessageIndex].role === "user") {
        messages[lastMessageIndex] = {
          role: "user",
          content: [
            {
              type: "text",
              text: message || "Please analyze this image."
            },
            {
              type: "image_url",
              image_url: {
                url: fileData.url
              }
            }
          ]
        };
      }
    }

    const completion = await openai.chat.completions.create({
      model: useVisionModel ? "gpt-4o" : "gpt-3.5-turbo", // Use GPT-4V for images
      messages: messages,
      max_tokens: useVisionModel ? 1000 : undefined, // Set max tokens for vision model
    });

    let replyText =
      completion.choices?.[0]?.message?.content?.trim() || fallback;

    let bookingSlots = null;
    if (
      session.messageCount >= 3 &&
      session.userName &&
      session.userEmail &&
      !session.askedBooking
    ) {
      session.askedBooking = true;

      let isoStarts = null;
      if (bookingProvider === "calendly") {
        isoStarts = await getCalendlyAvailableTimes(
          calendlyToken,
          calendlyEventTypeUri,
          calendlySchedulingLink
        );
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
    res.json({ reply: replyText, sessionId: activeSessionId, bookingSlots });
  } catch (err) {
    console.error("Chat error:", err);
    
    // NEW: Better error handling for vision model
    if (err.message && err.message.includes('vision')) {
      res.json({ 
        reply: "I can see you've shared an image, but I'm having trouble analyzing it right now. Could you describe what you'd like me to help you with regarding this image?", 
        sessionId: activeSessionId 
      });
    } else {
      res.json({ reply: fallback, sessionId: activeSessionId });
    }
  }
});

/* ========= Booking ========= */
app.post("/book", async (req, res) => {
  const { startTime, userName, userEmail, marketingConsent } = req.body || {};
  if (!userName || !userEmail || !startTime) {
    return res.status(400).json({ success: false, message: "Missing booking info" });
  }

  const emailText = `
New Booking Request:

Name: ${userName}
Email: ${userEmail}
Marketing Consent: ${marketingConsent === true ? "Agreed" : "Declined"}
Requested Time: ${startTime}
`;

  try {
    await transporter.sendMail({
      from: `"Chatbot" <${process.env.MAIL_USER}>`,
      to: ADMIN_EMAIL,
      subject: "New Booking",
      text: emailText,
    });
    res.json({
      success: true,
      message: `Thanks ${userName}! Someone from our team will contact you shortly.`,
    });
  } catch (err) {
    console.error("Booking email error:", err);
    res.status(500).json({ success: false, message: "Failed to send booking info." });
  }
});

/* ========= Calendly discovery endpoints ========= */
app.post("/calendly/event-types", async (req, res) => {
  try {
    const { calendlyToken, calendlySchedulingLink } = req.body || {};
    const token = calendlyToken || process.env.CALENDLY_TOKEN || "";
    if (!token) return res.status(400).json({ error: "Missing calendlyToken" });

    const userUri = await calendlyGetUserUri(token);
    if (!userUri) return res.status(401).json({ error: "Invalid Calendly token" });

    const types = await calendlyListEventTypesByUser(token, userUri);
    const simplified = types.map(t => ({
      name: t.name,
      slug: t.slug,
      duration: t.duration,
      uri: t.uri,
      scheduling_url: t.scheduling_url,
    }));

    let desiredSlug = null;
    if (calendlySchedulingLink) {
      try {
        const u = new URL(calendlySchedulingLink);
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts.length >= 2) desiredSlug = parts[1].toLowerCase();
      } catch {}
    }

    res.json({
      ok: true,
      count: simplified.length,
      items: simplified,
      suggested_uri:
        desiredSlug
          ? (simplified.find(x => (x.slug || "").toLowerCase() === desiredSlug)?.uri || null)
          : (simplified.find(x => String(x.duration) === "30")?.uri || simplified[0]?.uri || null),
    });
  } catch (e) {
    console.error("Calendly event-types error:", e);
    res.status(500).json({ error: "Failed to list Calendly event types" });
  }
});

app.post("/calendly/resolve", async (req, res) => {
  try {
    const { calendlyToken, calendlyEventTypeUri, calendlySchedulingLink } = req.body || {};
    const token = calendlyToken || process.env.CALENDLY_TOKEN || "";
    if (!token) return res.status(400).json({ error: "Missing calendlyToken" });

    const uri = await resolveCalendlyEventTypeUri({
      token,
      providedEventTypeUri: calendlyEventTypeUri,
      schedulingLink: calendlySchedulingLink,
    });

    if (!uri) return res.status(404).json({ ok: false, uri: null });
    res.json({ ok: true, uri });
  } catch (e) {
    console.error("Calendly resolve error:", e);
    res.status(500).json({ ok: false, uri: null });
  }
});

/* ========= Start ========= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
