import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

const app = express();

app.use(cors());
app.use(bodyParser.json());

// Health check route
app.get("/", (req, res) => {
  res.send("Chatbot backend is running!");
});

// Chat endpoint
app.post("/chat", (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "No message provided" });

  const reply = `You said: ${message}`;
  res.json({ reply });
});

// Listen on Render's port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
