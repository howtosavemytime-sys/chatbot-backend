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

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Email config
const transporter = nodemailer.createTransport({
  host: "smtp.zenbox.pl",
  port: 587,
  secure: false,
  auth: {
    user: "contact@madetoautomate.com",
    pass: "XmJ@Z%w@F9Ux"
  }
});
const ADMIN_EMAIL = "contact@madetoautomate.com";

// Session store
const sessions = {};
const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1h

function getSession(sessionId) {
  const now = Date.now();
  if (!sessionId || !sessions[sessionId]) {
    const newId = uuidv4();
    sessions[newId] = { messages: [], userName: null, userEmail: null, marketingConsent: null, lastActive: now };
    return { sessionId: newId, session: sessions[newId] };
  }
  if (now - sessions[sessionId].lastActive > SESSION_TIMEOUT_MS) {
    sessions[sessionId] = { messages: [], userName: null, userEmail: null, marketingConsent: null, lastActive: now };
  }
  sessions[sessionId].lastActive = now;
  return { sessionId, session: sessions[sessionId] };
}

// POST /chat
app.post("/chat", async (req, res) => {
  const { message, sessionId, userName, userEmail, marketingConsent } = req.body;
  const { sessionId: activeSessionId, session } = getSession(sessionId);

  // Store user info
  if (userName) session.userName = userName;
  if (userEmail) session.userEmail = userEmail;
  if (marketingConsent !== undefined) session.marketingConsent = marketingConsent;

  // Add user message
  session.messages.push({ role: "user", content: message });

  const systemMessage = `
You are a friendly chatbot for MadeToAutomate. Only answer questions about MadeToAutomate services.
Always use friendly, simple language.
Greet the user by name if provided.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemMessage },
        ...session.messages
      ]
    });

    const replyText = completion.choices[0].message.content || 
      "Sorry, I can only answer questions about MadeToAutomate services. Can I help you with something we do?";

    // Store bot reply
    session.messages.push({ role: "assistant", content: replyText });

    // After 3 messages, suggest booking slots (stub)
    let bookingSlots = null;
    if (session.messages.filter(m => m.role === "user").length >= 3) {
      const now = new Date();
      bookingSlots = [];
      for (let i = 1; i <= 3; i++) {
        const slotDate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
        slotDate.setHours(10, 0, 0, 0);
        bookingSlots.push({ start: slotDate.toISOString() });
      }
    }

    res.json({ reply: replyText, sessionId: activeSessionId, bookingSlots });
  } catch (error) {
    console.error("Error in chat:", error);
    res.json({ reply: "Sorry, a little trouble now. Can we continue talking about MadeToAutomate services?", sessionId: activeSessionId });
  }
});

// POST /book
app.post("/book", async (req, res) => {
  const { startTime, userName, userEmail, marketingConsent } = req.body;
  if (!userName || !userEmail || !startTime) {
    return res.status(400).json({ success: false, message: "Missing booking info" });
  }

  const mailOptions = {
    from: `"MadeToAutomate Bot" <contact@madetoautomate.com>`,
    to: ADMIN_EMAIL,
    subject: "New Discovery Call Booking",
    text: `A user wants to book a discovery call.\n\nName: ${userName}\nEmail: ${userEmail}\nMarketing consent: ${marketingConsent ? "Yes" : "No"}\nRequested Time: ${startTime}`
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({ success: true, message: `Thanks ${userName}! Someone from our team will contact you shortly to confirm the appointment.` });
  } catch (err) {
    console.error("Email sending error:", err);
    res.status(500).json({ success: false, message: "Failed to send booking info. Try again later." });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
