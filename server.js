// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ✅ OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

  // Reset session if inactive
  if (now - sessions[sessionId].lastActive > SESSION_TIMEOUT_MS) {
    sessions[sessionId] = { count: 0, lastActive: now };
  }

  sessions[sessionId].lastActive = now;
  return { sessionId, session: sessions[sessionId] };
}

// POST /chat endpoint
app.post("/chat", async (req, res) => {
  const { message, sessionId, userName } = req.body;

  const { sessionId: activeSessionId, session } = getSession(sessionId);

  // Check message limit
  if (session.count >= MESSAGE_LIMIT) {
    return res.json({
      reply:
        "It looks like we’ve covered a lot! For more help, please schedule a free discovery call.",
      sessionId: activeSessionId,
    });
  }

  session.count++;

  // System message with FAQ and instructions
  const systemMessage = `
You are a friendly chatbot for MadeToAutomate. Only answer questions about MadeToAutomate services, workflows, and processes.
Always use a friendly, simple, and easy-to-understand tone suitable for users with little or no technical knowledge.
If a user asks something outside your knowledge, politely respond:
"Sorry, I can only answer questions about MadeToAutomate services. Can I help you with something we do?"

FAQ:
- Who do you help? Businesses and individuals with workflow automation.
- What can you automate? Email, reporting, CRM, e-commerce, scheduling, customer support bots.
- How it works? Free Discovery Call → Automation Plan → Build & Launch → Ongoing Support.
- Other questions? Politely guide users to the relevant service or Discovery Call.

Greet the user by name if provided.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: message },
      ],
    });

    // Always send a reply, even if off-topic
    const reply = completion.choices[0].message.content || 
      "Sorry, I can only answer questions about MadeToAutomate services. Can I help you with something we do?";

    res.json({ reply, sessionId: activeSessionId });
  } catch (error) {
    console.error("OpenAI error details:", error);

    // Instead of showing "Error connecting to AI", always return a friendly fallback
    res.json({
      reply:
        "Sorry, I’m having a little trouble right now. Can we continue talking about MadeToAutomate services?",
      sessionId: activeSessionId,
    });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
