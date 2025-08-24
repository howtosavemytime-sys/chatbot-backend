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

// ✅ OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Email transporter (Zenbox)
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST || "smtp.zenbox.pl",
  port: process.env.MAIL_PORT || 587,
  secure: false, // TLS for port 587
  auth: {
    user: process.env.MAIL_USER || "contact@madetoautomate.com",
    pass: process.env.MAIL_PASS || "XmJ@Z%w@F9Ux",
  },
});

// In-memory session store
const sessions = {};
const MESSAGE_LIMIT = 10;
const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

function getSession(sessionId) {
  const now = Date.now();

  if (!sessionId || !sessions[sessionId]) {
    const newId = uuidv4();
    sessions[newId] = { count: 0, lastActive: now, messages: [], user: {} };
    return { sessionId: newId, session: sessions[newId] };
  }

  if (now - sessions[sessionId].lastActive > SESSION_TIMEOUT_MS) {
    sessions[sessionId] = { count: 0, lastActive: now, messages: [], user: {} };
  }

  sessions[sessionId].lastActive = now;
  return { sessionId, session: sessions[sessionId] };
}

// POST /chat endpoint
app.post("/chat", async (req, res) => {
  const { message, sessionId, userName, userEmail, marketingConsent } = req.body;
  const { sessionId: activeSessionId, session } = getSession(sessionId);

  // Persist user info if provided
  if (userName) session.user.name = userName;
  if (userEmail) session.user.email = userEmail;
  if (marketingConsent !== undefined) session.user.marketingConsent = marketingConsent;

  // Add message to memory
  session.messages.push({ role: "user", content: message });
  if (session.messages.length > MESSAGE_LIMIT) session.messages.shift();

  session.count++;

  // Suggest booking after 3 messages
  let suggestBooking = session.count === 3;

  const systemMessage = `
You are a friendly chatbot for MadeToAutomate. Only answer questions about MadeToAutomate services.
Always use friendly, simple language.
If user asks something unrelated, respond politely.
Greet the user by name if provided.
`;

  try {
    let replyText = "";

    if (suggestBooking) {
      replyText = "I see you’re interested in a free discovery call. Please provide a date and time you'd like, and we'll contact you to confirm!";
      res.json({ reply: replyText, sessionId: activeSessionId });
      return;
    }

    // Include past conversation in OpenAI request
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemMessage },
        ...session.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    replyText = completion.choices[0].message.content || 
      "Sorry, I can only answer questions about MadeToAutomate services. Can I help you with something we do?";

    session.messages.push({ role: "bot", content: replyText });

    res.json({ reply: replyText, sessionId: activeSessionId });
  } catch (error) {
    console.error("Error in chat:", error);
    res.json({ reply: "Sorry, a little trouble now. Can we continue talking about MadeToAutomate services?", sessionId: activeSessionId });
  }
});

// POST /book endpoint to notify team
app.post("/book", async (req, res) => {
  const { userName, userEmail, requestedTime } = req.body;

  try {
    await transporter.sendMail({
      from: `"MadeToAutomate Bot" <${process.env.MAIL_USER || "contact@madetoautomate.com"}>`,
      to: process.env.TO_EMAIL || "contact@madetoautomate.com",
      subject: "New Appointment Request",
      text: `
📅 New appointment request:
- Name: ${userName}
- Email: ${userEmail}
- Requested time: ${new Date(requestedTime).toLocaleString("en-GB")}
      `,
    });

    res.json({ message: "Thanks! Our team will get back to you shortly to confirm the appointment." });
  } catch (err) {
    console.error("Email send failed:", err);
    res.status(500).json({ message: "Booking request saved, but failed to notify our team." });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
