// server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// === Configure SMTP ===
const transporter = nodemailer.createTransport({
  host: "smtp.zenbox.pl",
  port: 587,
  secure: false, // TLS, not SSL
  auth: {
    user: "contact@madetoautomate.com",
    pass: "XmJ@Z%w@F9Ux"
  }
});

// === Test Email Route ===
app.get("/test-email", async (req, res) => {
  try {
    await transporter.sendMail({
      from: '"MTA Chatbot" <contact@madetoautomate.com>',
      to: "contact@madetoautomate.com",
      subject: "✅ Test Email from Chatbot Server",
      text: "This is a test email to confirm SMTP is working correctly."
    });
    res.json({ success: true, message: "Test email sent!" });
  } catch (error) {
    console.error("Test email error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// === Chat Endpoint (simple reply) ===
app.post("/chat", async (req, res) => {
  const { message, userName } = req.body;
  let reply = "I’m here to help you with MadeToAutomate services.";

  if (!userName) {
    reply = "Hi! Please provide your name and email (e.g. John Doe, john@example.com).";
  }

  res.json({ reply });
});

// === Booking Endpoint ===
app.post("/book", async (req, res) => {
  const { startTime, userName, userEmail, marketingConsent } = req.body;

  try {
    // Send booking details to your team
    await transporter.sendMail({
      from: '"MTA Chatbot" <contact@madetoautomate.com>',
      to: "contact@madetoautomate.com",
      subject: `📅 New Booking Request from ${userName || "Unknown User"}`,
      text: `
A new booking was requested via chatbot:

👤 Name: ${userName || "N/A"}
📧 Email: ${userEmail || "N/A"}
📰 Marketing Consent: ${marketingConsent ? "YES" : "NO"}
📅 Requested Time: ${startTime ? new Date(startTime).toLocaleString() : "N/A"}
      `
    });

    res.json({ success: true, message: "✅ Booking request received! Our team will contact you shortly." });
  } catch (error) {
    console.error("Booking email error:", error);
    res.status(500).json({ success: false, message: "❌ Failed to send booking email." });
  }
});

// === Start server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
