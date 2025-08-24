import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import nodemailer from "nodemailer";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());

// Nodemailer transporter with SSL (port 465)
const transporter = nodemailer.createTransport({
  host: "smtp.zenbox.pl",
  port: 465,
  secure: true, // SSL
  auth: {
    user: "contact@madetoautomate.com",
    pass: "XmJ@Z%w@F9Ux",
  },
});

// Test email route
app.get("/test-email", async (req, res) => {
  try {
    let info = await transporter.sendMail({
      from: '"Chatbot Test" <contact@madetoautomate.com>',
      to: "contact@madetoautomate.com",
      subject: "✅ Test Email from Chatbot Backend (SSL)",
      text: "If you see this, SMTP over SSL works correctly!",
    });

    console.log("Email sent: ", info.messageId);
    res.send("✅ Test email sent");
  } catch (err) {
    console.error("Email error:", err);
    res.send("❌ Failed to send email: " + err.message);
  }
});

// Booking route
app.post("/send-booking", async (req, res) => {
  const { name, email, bookingDate, marketingConsent } = req.body;

  try {
    await transporter.sendMail({
      from: '"Chatbot" <contact@madetoautomate.com>',
      to: "contact@madetoautomate.com",
      subject: "📅 New Booking Request",
      text: `New booking request:\n\nName: ${name}\nEmail: ${email}\nDate: ${bookingDate}\nMarketing consent: ${marketingConsent}`,
    });

    res.json({ success: true, message: "Booking email sent" });
  } catch (err) {
    console.error("Booking email error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
