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

// ✅ Email config
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com", // or your provider
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER, // add to Render secrets
    pass: process.env.EMAIL_PASS, // add to Render secrets
  },
});

// In-memory session store
const sessions = {};
const MESSAGE_LIMIT = 10;
const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

// Helper: get or create session
function getSession(sessionId) {
  const now = Date.now();

  if (!sessionId || !sessions[sessionId]) {
    const newId = uuidv4();
    sessions[newId] = {
      count: 0,
      lastActive: now,
      history: [],
      userName: null,
      userEmail: null,
    };
    return { sessionId: newId, session: sessions[newId] };
  }

  if (now - sessions[sessionId].lastActive > SESSION_TIMEOUT_MS) {
    sessions[sessionId] = {
      count: 0,
      lastActive: now,
      history: [],
      userName: null,
      userEmail: null,
    };
  }

  sessions[sessionId].lastActive = now;
  return { sessionId, session: sessions[sessionId] };
}

// POST /chat endpoint
app.post("/chat", async (req, res) => {
  const { message, sessionId, userName, userEmail } = req.body;
  const { sessionId: activeSessionId, session } = getSession(sessionId);

  // Save user info if provided
  if (userName && !session.userName) session.userName = userName;
  if (userEmail && !session.userEmail) session.userEmail = userEmail;

  // Increment count
  session.count++;

  // Add user message to history
  session.history.push({ role: "user", content: message });
  if (session.history.length > MESSAGE_LIMIT) {
    session.history.shift(); // keep last N messages
  }

  const systemMessage = `
You are a friendly chatbot for MadeToAutomate. 
Always answer only about MadeToAutomate services.
Use friendly, simple language. 
If the user asks about something else, reply:
"Sorry, I can only answer questions about MadeToAutomate services. Can I help you with something we do?"
Always remember their name (${session.userName || "unknown"}) and email (${session.userEmail || "unknown"}) if available.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemMessage },
        ...session.history,
      ],
    });

    const replyText =
      completion.choices[0].message.content ||
      "Sorry, I can only answer questions about MadeToAutomate services.";

    // Save bot reply in history
    session.history.push({ role: "assistant", content: replyText });

    res.json({
      reply: replyText,
      sessionId: activeSessionId,
    });
  } catch (err) {
    console.error("Error in chat:", err);
    res.json({
      reply: "Sorry, a little trouble now. Can we continue talking about MadeToAutomate services?",
      sessionId: activeSessionId,
    });
  }
});

// POST /book → send email instead of Calendly
app.post("/book", async (req, res) => {
  const { startTime, sessionId } = req.body;
  const { session } = getSession(sessionId);

  const userName = session.userName || "Unknown";
  const userEmail = session.userEmail || "Unknown";

  try {
    await transporter.sendMail({
      from: `"MadeToAutomate Bot" <${process.env.EMAIL_USER}>`,
      to: "contact@madetoautomate.com",
      subject: "New Appointment Request",
      text: `
A new appointment was requested:

Name: ${userName}
Email: ${userEmail}
Requested Time: ${startTime}
    `,
    });

    res.json({
      success: true,
      message:
        "Thanks! Someone from our team will get back to you shortly to confirm your appointment.",
    });
  } catch (err) {
    console.error("Email send error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to send booking request." });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
