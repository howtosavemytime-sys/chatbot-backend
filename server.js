import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

// Create Express app
const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Example health check route
app.get("/", (req, res) => {
  res.send("Chatbot backend is running!");
});

// Example chatbot endpoint
app.post("/chat", (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "No message provided" });
  }

  // Example reply
  const reply = `You said: ${message}`;
  res.json({ reply });
});

// Listen on Render's port or 3000 locally
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

