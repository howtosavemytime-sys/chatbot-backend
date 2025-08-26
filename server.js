// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import nodemailer from "nodemailer";
import { DateTime } from "luxon";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

// --- simple file storage for consents ---
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CONSENTS_FILE = path.join(DATA_DIR, "consents.jsonl");

// --- app ---
const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- OpenAI setup (read key from env) ---
if (!process.env.OPENAI_API_KEY) console.warn("Warning: OPENAI_API_KEY not set.");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Mailer setup ---
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: process.env.MAIL_PORT ? Number(process.env.MAIL_PORT) : 587,
  secure: String(process.env.MAIL_PORT) === "465",
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});
const ADMIN_EMAIL = process.env.TO_EMAIL || process.env.MAIL_USER || null;

// --- session store (in-memory) ---
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
      marketingConsent: null,
      lastActive: now,
      messageCount: 0,
      askedBooking: false,
    };
  }
  sessions[sessionId].lastActive = now;
  return { sessionId, session: sessions[sessionId] };
}

function generateBookingSlotsFallback() {
  const slots = [];
  let dt = DateTime.now().setZone("Europe/Paris").plus({ days: 1 }).startOf("day");
  while (slots.length < 3) {
    if (dt.weekday <= 5) {
      const hour = 10 + Math.floor(Math.random() * 7); // 10..16
      const minute = Math.random() < 0.5 ? 0 : 30;
      const slot = dt.set({ hour, minute });
      slots.push(slot.toFormat("yyyy-MM-dd HH:mm"));
    }
    dt = dt.plus({ days: 1 });
  }
  return slots;
}

// Calendly helpers (best-effort)
async function fetchCalendlyFirstEventTypeUri() {
  if (!process.env.CALENDLY_TOKEN) return null;
  try {
    const res = await fetch("https://api.calendly.com/event_types", {
      headers: { Authorization: `Bearer ${process.env.CALENDLY_TOKEN}` },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const arr = j.data || j.collection || [];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr[0].uri || arr[0].resource || arr[0].id || null;
  } catch (e) {
    console.error("Calendly event_types error", e);
    return null;
  }
}

async function fetchCalendlyAvailableSlotsForEventType(eventTypeUri) {
  if (!process.env.CALENDLY_TOKEN || !eventTypeUri) return null;
  try {
    const start = DateTime.now().setZone("Europe/Paris").plus({ days: 1 }).startOf("day").toUTC().toISO();
    const end = DateTime.now().setZone("Europe/Paris").plus({ days: 7 }).endOf("day").toUTC().toISO();
    const url = `https://api.calendly.com/event_type_available_times?event_type=${encodeURIComponent(
      eventTypeUri
    )}&start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.CALENDLY_TOKEN}`, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      console.warn("Calendly available times non-ok", res.status);
      return null;
    }
    const j = await res.json();
    let items = j.collection || j.data || j.available_times || [];
    if (!Array.isArray(items)) {
      if (Array.isArray(j.collection?.available_times)) items = j.collection.available_times;
      else if (Array.isArray(j.available_times)) items = j.available_times;
      else items = [];
    }
    const slots = [];
    for (const it of items) {
      const startISO = it.start_time || it.start || it.datetime || it.start_time_utc || null;
      if (!startISO) continue;
      const dt = DateTime.fromISO(startISO, { zone: "utc" }).setZone("Europe/Paris");
      slots.push({ start: dt.toFormat("yyyy-MM-dd HH:mm"), raw: startISO, scheduling_url: it.scheduling_url || it.schedulingUrl || null });
      if (slots.length >= 6) break;
    }
    return slots;
  } catch (e) {
    console.error("Calendly available times fetch error", e);
    return null;
  }
}

function saveConsentToDisk(record) {
  try {
    const line = JSON.stringify(record) + "\n";
    fs.appendFileSync(CONSENTS_FILE, line);
  } catch (e) {
    console.error("Failed to write consent file", e);
  }
}

// --- Chat endpoint ---
app.post("/chat", async (req, res) => {
  const { message, sessionId, userName, userEmail, marketingConsent } = req.body || {};
  const { sessionId: activeSessionId, session } = getSession(sessionId);

  if (userName) session.userName = userName;
  if (userEmail) session.userEmail = userEmail;
  if (marketingConsent !== undefined) session.marketingConsent = marketingConsent;

  if (message) session.messages.push({ role: "user", content: message });
  session.messageCount++;

  const systemMessage =
    "You are a friendly chatbot for MadeToAutomate.\nAnswer only about MadeToAutomate services, workflows, and processes.\nGreet user by name if available.";

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "system", content: systemMessage }, ...session.messages],
    });

    let replyText =
      (completion && completion.choices && completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content) ||
      "Sorry, I can only answer questions about MadeToAutomate services.";

    let bookingSlots = null;
    if (session.messageCount >= 3 && session.userName && session.userEmail && !session.askedBooking) {
      session.askedBooking = true;
      replyText += "\n\nWould you like to book a 30-minute appointment with our representative?";

      let calendlySlots = null;
      const eventTypeEnv = process.env.CALENDLY_EVENT_TYPE_URI || null;
      const eventTypeUri = eventTypeEnv || (await fetchCalendlyFirstEventTypeUri());
      if (eventTypeUri) {
        calendlySlots = await fetchCalendlyAvailableSlotsForEventType(eventTypeUri);
      }
      if (calendlySlots && calendlySlots.length > 0) {
        bookingSlots = calendlySlots.slice(0, 3).map((s) => ({ start: s.start, scheduling_url: s.scheduling_url }));
      } else {
        bookingSlots = generateBookingSlotsFallback().map((s) => ({ start: s }));
      }
    }

    session.messages.push({ role: "assistant", content: replyText });

    res.json({ reply: replyText, sessionId: activeSessionId, bookingSlots });
  } catch (error) {
    console.error("Chat error:", error);
    res.json({ reply: "Sorry, a little trouble now. Can we continue talking about MadeToAutomate services?", sessionId: activeSessionId });
  }
});

// --- Booking endpoint ---
app.post("/book", async (req, res) => {
  const { startTime, userName, userEmail, marketingConsent } = req.body || {};

  if (!userName || !userEmail || !startTime) {
    return res.status(400).json({ success: false, message: "Missing booking info" });
  }

  const emailText = `New Discovery Call Booking Request:\n\nName: ${userName}\nEmail: ${userEmail}\nMarketing Consent: ${
    marketingConsent === true ? "Agreed" : "Declined"
  }\nRequested Time: ${startTime} CET\n`;

  try {
    saveConsentToDisk({ ts: new Date().toISOString(), name: userName, email: userEmail, marketingConsent: !!marketingConsent, requestedTime: startTime });

    if (!ADMIN_EMAIL) console.warn("No ADMIN_EMAIL configured; booking email will not be sent.");
    else {
      await transporter.sendMail({
        from: `"MadeToAutomate Bot" <${process.env.MAIL_USER}>`,
        to: ADMIN_EMAIL,
        subject: "New Discovery Call Booking",
        text: emailText,
      });
    }

    res.json({ success: true, message: `Thanks ${userName}! Someone from our team will contact you shortly to confirm the appointment.` });
  } catch (err) {
    console.error("Booking email error:", err);
    res.status(500).json({ success: false, message: "Failed to send booking info. Try again later." });
  }
});

// --- Admin consents download (protected by ADMIN_TOKEN if set) ---
app.get("/consents", (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || null;
  const provided = req.headers["x-admin-token"] || req.query.token || null;
  if (adminToken && provided !== adminToken) return res.status(403).send("Forbidden");
  if (!fs.existsSync(CONSENTS_FILE)) return res.json([]);
  try {
    const lines = fs.readFileSync(CONSENTS_FILE, "utf8").trim().split("\n").filter(Boolean);
    const items = lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        return { raw: l };
      }
    });
    return res.json(items.reverse());
  } catch (e) {
    console.error("Read consents error", e);
    return res.status(500).send("Error reading consents");
  }
});

app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
