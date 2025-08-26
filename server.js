// server.js
// Offer booking after 3 messages if user has name/email and hasn't been asked yet
if (session.messageCount >= 3 && session.userName && session.userEmail && !session.askedBooking) {
session.askedBooking = true;
replyText += '\n\nWould you like to book a 30-minute appointment with our representative?';


// Try Calendly first (if configured), else fallback
let calendlySlots = null;
const eventTypeEnv = process.env.CALENDLY_EVENT_TYPE_URI || null;
const useEventTypeUri = eventTypeEnv || await fetchCalendlyFirstEventTypeUri();
if (useEventTypeUri) {
calendlySlots = await fetchCalendlyAvailableSlotsForEventType(useEventTypeUri);
}
if (calendlySlots && calendlySlots.length > 0) {
// return up to 3 slots
bookingSlots = calendlySlots.slice(0,3).map(s => ({ start: s.start, scheduling_url: s.scheduling_url }));
} else {
bookingSlots = generateBookingSlotsFallback().map(s => ({ start: s }));
}
}


session.messages.push({ role: 'assistant', content: replyText });


res.json({ reply: replyText, sessionId: activeSessionId, bookingSlots });
} catch (error) {
console.error('Chat error:', error);
res.json({ reply: 'Sorry, a little trouble now. Can we continue talking about MadeToAutomate services?', sessionId: activeSessionId });
}
});


// --- Booking endpoint ---
app.post('/book', async (req, res) => {
const { startTime, userName, userEmail, marketingConsent } = req.body || {};


if (!userName || !userEmail || !startTime) {
return res.status(400).json({ success: false, message: 'Missing booking info' });
}


const emailText = `New Discovery Call Booking Request:\n\nName: ${userName}\nEmail: ${userEmail}\nMarketing Consent: ${marketingConsent === true ? 'Agreed' : 'Declined'}\nRequested Time: ${startTime} CET\n`;


try {
// save consent to disk (simple persistent store)
saveConsentToDisk({ ts: new Date().toISOString(), name: userName, email: userEmail, marketingConsent: !!marketingConsent, requestedTime: startTime });


// send admin email
await transporter.sendMail({
from: `"MadeToAutomate Bot" <${process.env.MAIL_USER}>`,
to: ADMIN_EMAIL,
subject: 'New Discovery Call Booking',
text: emailText,
});


res.json({ success: true, message: `Thanks ${userName}! Someone from our team will contact you shortly to confirm the appointment.` });
} catch (err) {
console.error('Booking email error:', err);
res.status(500).json({ success: false, message: 'Failed to send booking info. Try again later.' });
}
});


// --- Admin: download consents (protected by ADMIN_TOKEN env) ---
app.get('/consents', (req, res) => {
const adminToken = process.env.ADMIN_TOKEN || null;
const provided = req.headers['x-admin-token'] || req.query.token || null;
if (adminToken && provided !== adminToken) return res.status(403).send('Forbidden');
if (!fs.existsSync(CONSENTS_FILE)) return res.json([]);
try {
const lin
