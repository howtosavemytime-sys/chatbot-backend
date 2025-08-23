// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ✅ OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Calendly config
const CALENDLY_TOKEN = process.env.CALENDLY_TOKEN; // Add token in Render secrets
const EVENT_URL = "https://calendly.com/madetoautomate/15-minut-meeting";
const TIMEZONE = "CET";

// In-memory session store
const sessions = {};
const MESSAGE_LIMIT = 10;
const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

// Helper to get or create session
function getSession(sessionId) {
  const now = Date.now();

  if (!sessionId || !sessions[sessionId]) {
    const newId = uuidv4();
    sessions[newId] = { count: 0, lastActive: now };
    return { sessionId: newId, session: sessions[newId] };
  }

  if (now - sessions[sessionId].lastActive > SESSION_TIMEOUT_MS) {
    sessions[sessionId] = { count: 0, lastActive: now };
  }

  sessions[sessionId].lastActive = now;
  return { sessionId, session: sessions[sessionId] };
}

// Helper: get next 3 available slots from Calendly
async function getCalendlySlots() {
  const res = await fetch("https://api.calendly.com/scheduled_events", {
    headers: {
      Authorization: `Bearer ${CALENDLY_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  const data = await res.json();
  // This is a simplified version: pick next 3 upcoming times
  const now = new Date();
  const slots = data.collection
    .filter(e => new Date(e.start_time) > now)
    .slice(0, 3)
    .map(e => ({
      start: e.start_time,
      end: e.end_time,
    }));
  return slots;
}

// POST /chat endpoint
app.post("/chat", async (req, res) => {
  const { message, sessionId, userName, userEmail, marketingConsent } = req.body;
  const { sessionId: activeSessionId, session } = getSession(sessionId);

  // Increment message count
  session.count++;

  // After 3 messages, suggest booking
  let suggestBooking = false;
  if (session.count === 3) suggestBooking = true;

  const systemMessage = `
You are a friendly chatbot for MadeToAutomate. Only answer questions about MadeToAutomate services.
Always use friendly, simple language.
If user asks something unrelated, respond:
"Sorry, I can only answer questions about MadeToAutomate services. Can I help you with something we do?"
Greet the user by name if provided.
`;

  try {
    let replyText = "";

    if (suggestBooking) {
      // Get 3 available slots
      const slots = await getCalendlySlots();
      if (slots.length > 0) {
        replyText = "I see you’re interested! Here are 3 available times to book a free discovery call:";
        res.json({ 
          reply: replyText, 
          sessionId: activeSessionId, 
          bookingSlots: slots 
        });
        return;
      }
    }

    // Regular OpenAI reply
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: message },
      ],
    });

    replyText = completion.choices[0].message.content || 
      "Sorry, I can only answer questions about MadeToAutomate services. Can I help you with something we do?";

    res.json({ reply: replyText, sessionId: activeSessionId });
  } catch (error) {
    console.error("Error in chat:", error);
    res.json({ reply: "Sorry, a little trouble now. Can we continue talking about MadeToAutomate services?", sessionId: activeSessionId });
  }
});

// POST /book endpoint to create booking
app.post("/book", async (req, res) => {
  const { startTime, userName, userEmail } = req.body;

  try {
    const body = {
      max_event_count: 1,
      invitee: {
        email: userEmail,
        name: userName
      },
      event: EVENT_URL,
      start_time: startTime,
      timezone: TIMEZONE
    };

    const response = await fetch("https://api.calendly.com/scheduled_events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CALENDLY_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) throw new Error("Failed to book on Calendly");

    res.json({ success: true, message: "Your discovery call has been booked!" });
  } catch (err) {
    console.error("Booking error:", err);
    res.status(500).json({ success: false, message: "Failed to book appointment. Try again later." });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
