import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Setup mail transporter
const transporter = nodemailer.createTransport({
  host: "smtp.zenbox.pl",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Test email route
app.get("/test-email", async (req, res) => {
  try {
    await transporter.sendMail({
      from: `"MTA Bot" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER,
      subject: "Test Email from Chatbot",
      text: "If you see this, SMTP works ✅",
    });
    res.send("✅ Test email sent. Check your inbox!");
  } catch (err) {
    console.error("Email error:", err);
    res.status(500).send("❌ Failed to send email");
  }
});

app.post("/book", async (req, res) => {
  const { userName, userEmail, startTime, marketingConsent } = req.body;

  try {
    await transporter.sendMail({
      from: `"MTA Bot" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER,
      subject: "📅 New Booking Request",
      text: `New booking request:
Name: ${userName}
Email: ${userEmail}
Marketing Consent: ${marketingConsent ? "Yes" : "No"}
Date: ${startTime}`,
    });

    res.json({
      message: "Thanks! Someone from our team will confirm your appointment soon.",
    });
  } catch (err) {
    console.error("Booking email error:", err);
    res.status(500).json({ message: "Failed to send booking email." });
  }
});

// Keep alive
app.get("/", (req, res) => res.send("✅ Chatbot backend is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
