// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid"; // for generating session IDs

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ✅ OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// In-memory session store
// sessionId => { count: number, lastActive: timestamp }
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

  // Check timeout
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
You are a friendly, approachable chatbot for MadeToAutomate. Only answer questions about MadeToAutomate services, workflows, and processes.
Always use a friendly and easy-to-understand tone suitable for users with little or no technical knowledge.
If a user asks something outside your knowledge, politely respond:
"Sorry, I can only answer questions about MadeToAutomate services. Can I help you with something we do?"

FAQ:
1. Who do you help?
- Businesses: automate sales, HR, customer support, connect tools, dashboards, reports, save 10–40 hours/week.
- Individuals: automate reminders, emails, finance, smart home and calendar workflows, productivity.

2. What can you automate?
- Email & Communications: follow-ups, sorting, notifications.
- Reporting & Dashboards: pull and format reports from Sheets, CRMs, analytics.
- CRM & Lead Management: add leads, tag customers, trigger emails.
- E-commerce: order tracking, inventory, abandoned cart follow-ups.
- Booking & Scheduling: appointment confirmations, invites, reminders.
- Customer Support Bots: auto-respond to questions, route tickets, escalate complex issues.

3. How does your process work?
- Step 1: Free Discovery Call – you explain your workflow and time losses.
- Step 2: Automation Plan – we map your workflow and design automation.
- Step 3: Build & Launch – we implement and deploy automations.
- Step 4: Ongoing Support – we monitor and adapt automations as needs evolve.

4. How long does it take? Most projects run in days to a couple of weeks.
5. Do I need technical knowledge? No, we handle everything.
6. How much time can I save? Businesses 10–40 hours/week, individuals save personal time.
7. Can you help with any software? Popular tools like CRMs, Slack, Google Workspace, spreadsheets, email, booking, e-commerce.
8. What if I need help later? We offer ongoing support and updates.
9. What should I do next? Schedule a free discovery call.

Always greet the user by name if known. If the question doesn’t match the FAQ, politely decline and stay on topic.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: message },
      ],
    });

    const reply = completion.choices[0].message.content;
    res.json({ reply, sessionId: activeSessionId });
  } catch (error) {
    console.error("OpenAI error details:", error);
    res.status(500).json({
      reply: "Error connecting to AI. Check backend logs.",
      sessionId: activeSessionId,
    });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
