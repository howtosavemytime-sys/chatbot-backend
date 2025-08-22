// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import OpenAI from "openai";

const app = express();
app.use(cors());           // Allow requests from any website
app.use(bodyParser.json()); // Parse JSON request bodies

// ✅ OpenAI client - make sure OPENAI_API_KEY is set in Render Environment Variables
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// POST /chat endpoint
app.post("/chat", async (req, res) => {
  const { message } = req.body;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: message }],
    });

    const reply = completion.choices[0].message.content;
    res.json({ reply });
  } catch (error) {
    console.error("Error from OpenAI:", error.response?.data || error.message);
    res.status(500).json({ reply: "Error connecting to AI." });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
