// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import nodemailer from "nodemailer";
import fetch from "node-fetch";
import { DateTime } from "luxon";

const app = express();
app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: process.env.MAIL_PORT,
  secure: process.env.MAIL_PORT == 465,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

const ADMIN_EMAIL = process.env.TO_EMAIL;
const CALENDLY_TOKEN = process.env.CALENDLY_TOKEN;
const CALENDLY_EVENT_URL = process.env.CALENDLY_EVENT_URL;

const sessions = {};
const SESSION_TIMEOUT_MS = 60 * 60 * 1000;

function getSession(sessionId) {
  const now = Date.now();
  if (!sessionId || !sessions[sessionId]) {
    const newId = uuidv4();
    sessions[newId] = { messages: [], userName: null, userEmail: null, marketingConsent: null, lastActive: now, messageCount: 0 };
    return { sessionId: newId, session: sessions[newId] };
  }
  if (now - sessions[sessionId].lastActive > SESSION_TIMEOUT_MS) {
    sessions[sessionId] = { messages: [], userName: null, userEmail: null, marketingConsent: null, lastActive: now, messageCount: 0 };
  }
  sessions[sessionId].lastActive = now;
  return { sessionId, session: sessions[sessionId] };
}

// Fetch available slots from Calendly
async function getCalendlyAvailability() {
  const headers = { Authorization: `Bearer ${CALENDLY_TOKEN}` };
  const eventUri = CALENDLY_EVENT_URL.split('calendly.com/')[1];
  const res = await fetch(`https://api.calendly.com/scheduled_events?event_type=${eventUri}&status=active`, { headers });
  const data = await res.json();

  // Placeholder logic: just return next 3 hours for demo if Calendly API structure differs
  const now = DateTime.now().setZone("Europe/Paris");
  return [1,2,3].map(h => now.plus({ hours: h }).toFormat("yyyy-MM-dd HH:mm"));
}

// --- Chat endpoint ---
app.post("/chat", async (req, res) => {
  const { message, sessionId, userName, userEmail, marketingConsent } = req.body;
  const { sessionId: activeSessionId, session } = getSession(sessionId);

  if (userName) session.userName = userName;
  if (userEmail) session.userEmail = userEmail;
  if (marketingConsent !== undefined) session.marketingConsent = marketingConsent;

  session.messages.push({ role: "user", content: message });
  session.messageCount++;

  const systemMessage = `
You are a friendly chatbot for MadeToAutomate.
Answer only about MadeToAutomate services, workflows, and processes.
Greet user by name if available.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "system", content: systemMessage }, ...session.messages],
    });

    const replyText = completion.choices[0].message.content ||
      "Sorry, I can only answer questions about MadeToAutomate services. Can I help you with something we do?";
    session.messages.push({ role: "assistant", content: replyText });

    // Offer booking after 3 user messages
    let bookingSlots = null;
    if (session.messageCount >= 3 && session.userName && session.userEmail) {
      const slots = await getCalendlyAvailability();
      bookingSlots = slots.map(s => ({ start: s }));
    }

    res.json({ reply: replyText, sessionId: activeSessionId, bookingSlots });
  } catch (error) {
    console.error("Chat error:", error);
    res.json({ reply: "Sorry, a little trouble now. Can we continue talking about MadeToAutomate services?", sessionId: activeSessionId });
  }
});

// --- Booking endpoint ---
app.post("/book", async (req, res) => {
  const { startTime, userName, userEmail, marketingConsent } = req.body;

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
      from: `"MadeToAutomate Bot" <${process.env.MAIL_USER}>`,
      to: ADMIN_EMAIL,
      subject: "New Discovery Call Booking",
      text: emailText,
    });

    res.json({ success: true, message: `Thanks ${userName}! Someone from our team will contact you shortly to confirm the appointment.` });
  } catch (err) {
    console.error("Booking email error:", err);
    res.status(500).json({ success: false, message: "Failed to send booking info. Try again later." });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
