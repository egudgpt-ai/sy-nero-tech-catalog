require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const path       = require('path');
const fs         = require('fs');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/assets/:file', (req, res) => {
  const filePath = path.join(__dirname, 'assets', path.basename(req.params.file));
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

app.get('/_health', (req, res) => res.send('ok'));

function buildHtml({ id, name, short, price, customerEmail, phone, message }) {
  const esc = s => String(s||'').replace(/[&<>"']/g, m =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m]);
  return `
    <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;padding:24px;border-radius:8px;">
      <h2 style="color:#00b89c;margin-top:0;">פנייה חדשה מהאתר - SYNERO.TECH</h2>
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;">
        <tr style="background:#f0f0f0;"><td colspan="2" style="padding:10px 14px;font-weight:bold;font-size:14px;">פרטי הפונה</td></tr>
        <tr><td style="padding:10px 14px;color:#555;width:120px;">שם</td><td style="padding:10px 14px;font-weight:bold;">${esc(name)}</td></tr>
        <tr style="background:#fafafa;"><td style="padding:10px 14px;color:#555;">מייל</td><td style="padding:10px 14px;"><a href="mailto:${esc(customerEmail)}" style="color:#00b89c;">${esc(customerEmail)}</a></td></tr>
        ${phone ? `<tr><td style="padding:10px 14px;color:#555;">טלפון</td><td style="padding:10px 14px;">${esc(phone)}</td></tr>` : ''}
        ${message ? `<tr style="background:#fafafa;"><td style="padding:10px 14px;color:#555;">הודעה</td><td style="padding:10px 14px;">${esc(message)}</td></tr>` : ''}
        ${short && short !== message ? `<tr><td style="padding:10px 14px;color:#555;">תיאור</td><td style="padding:10px 14px;">${esc(short)}</td></tr>` : ''}
        ${price ? `<tr style="background:#fafafa;"><td style="padding:10px 14px;color:#555;">מחיר</td><td style="padding:10px 14px;">${esc(price)}</td></tr>` : ''}
        ${id && id !== 'contact' ? `<tr><td style="padding:10px 14px;color:#555;">מזהה שירות</td><td style="padding:10px 14px;">${esc(id)}</td></tr>` : ''}
      </table>
      <p style="margin-top:20px;color:#999;font-size:11px;">נשלח אוטומטית מ-SYNERO.TECH</p>
    </div>
  `;
}

app.post('/send-request', async (req, res) => {
  const { id, name, short, price, customerEmail, phone, message } = req.body || {};
  if (!name)    return res.status(400).send('missing name');
  if (!customerEmail || !customerEmail.includes('@')) return res.status(400).send('invalid email');

  const to      = process.env.TO_EMAIL   || 'cto@sy-nero.com';
  const subject = id === 'contact'
    ? `פנייה מהאתר - ${name}`
    : `בקשת פגישת אסטרטגיה: ${name}`;

  const html = buildHtml({ id, name, short, price, customerEmail, phone, message });

  // Try SMTP first (Gmail app password)
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (smtpUser && smtpPass) {
    try {
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST || 'smtp.gmail.com',
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth: { user: smtpUser, pass: smtpPass },
      });
      await transporter.sendMail({
        from:     `"SYNERO.TECH" <${smtpUser}>`,
        to,
        replyTo:  customerEmail,
        subject,
        html,
      });
      console.log('Email sent via SMTP to', to);
      return res.send('ok');
    } catch (err) {
      console.error('SMTP error:', err.message);
      // fall through to Resend
    }
  }

  // Fallback: Resend
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('No email service configured');
    return res.status(500).send('Email service not configured');
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:     process.env.FROM_EMAIL || 'onboarding@resend.dev',
        to:       [to],
        reply_to: customerEmail,
        subject,
        html,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend error:', resp.status, errText);
      return res.status(500).send('send failed');
    }
    console.log('Email sent via Resend');
    res.send('ok');
  } catch (err) {
    console.error('send error', err);
    res.status(500).send('send failed');
  }
});

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]
  );
}

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
}

module.exports = app;
