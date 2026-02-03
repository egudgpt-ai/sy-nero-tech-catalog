// Simple server to receive product requests and send email via Nodemailer
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// health
app.get('/_health', (req, res) => res.send('ok'));

app.post('/send-request', async (req, res) => {
  const { id, name, short, price, customerEmail } = req.body || {};
  if(!name) return res.status(400).send('missing product name');
  if(!customerEmail || !customerEmail.includes('@')) return res.status(400).send('invalid customer email');

  // SMTP config via env
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT,10) : undefined;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  let from = process.env.FROM_EMAIL || '';
  const to = process.env.TO_EMAIL || 'cto@sy-nero.com';

  if(!host || !port || !user || !pass){
    console.error('Missing SMTP config');
    return res.status(500).send('SMTP not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS');
  }

  // Ensure FROM is a valid email; fall back to SMTP user
  if(!from || !from.includes('@')) from = user;

  console.log('SMTP config:', { host, port, user: user ? '[set]' : '[missing]', from, to });

  let transporter;
  try{
transporter = nodemailer.createTransport({
  host,
  port,              // 587
  secure: false,     // ← שימי לב: false
  auth: { user, pass },
  tls: {
    servername: host,
    minVersion: 'TLSv1.2'
  }
});



    // verify connection configuration before sending
    try{
      await transporter.verify();
      console.log('SMTP connection verified');
    }catch(verifyErr){
      console.error('SMTP verify failed', verifyErr);
      return res.status(500).send('SMTP verify failed: ' + (verifyErr && verifyErr.message ? verifyErr.message : 'unknown'));
    }

    const html = `
      <h2>בקשת הצעה חדשה מ-SY-NERO TECH</h2>
      <p><strong>מוצר:</strong> ${escapeHtml(name)}</p>
      <p><strong>תיאור קצר:</strong> ${escapeHtml(short || '')}</p>
      <p><strong>מחיר משוער:</strong> ${escapeHtml(price || '')}</p>
      <p>מזהה מוצר: ${escapeHtml(id || '')}</p>
      <hr/>
      <p><strong>בקשה מ:</strong> ${escapeHtml(customerEmail)}</p>
      <p>נשלח אוטומטית מהאתר.</p>
    `;

    const info = await transporter.sendMail({
      from, to,
      replyTo: customerEmail,
      subject: `בקשת הצעה: ${name}`,
      html
    });

    console.log('Email sent:', info && info.messageId ? info.messageId : info);
    res.send('ok');
  }catch(err){
    console.error('send error', err);
    res.status(500).send('send failed: ' + (err && err.message ? err.message : 'unknown'));
  }
});

function escapeHtml(s){
  if(!s) return '';
  return String(s).replace(/[&<>"']/g, function(m){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[m];
  });
}

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
