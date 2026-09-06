require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const path       = require('path');
const fs         = require('fs');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Upstash Redis via REST ──
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(commands) {
  if (!REDIS_URL || !REDIS_TOKEN) return commands.map(() => null);
  try {
    const r = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    const data = await r.json();
    return Array.isArray(data) ? data.map(d => d.result) : [];
  } catch (e) {
    console.error('Redis error:', e.message);
    return commands.map(() => null);
  }
}

app.use(bodyParser.json());
app.use(bodyParser.text({ type: '*/*' }));

function isoDate(ts) { return new Date(ts).toISOString().slice(0, 10); }
function isoHour(ts) { return String(new Date(ts).getUTCHours()).padStart(2, '0'); }

function parseBrowser(ua='') {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua) && !/Chrome/.test(ua)) return 'Safari';
  return 'Other';
}
function parseOS(ua='') {
  if (/Windows/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Other';
}
function parseDevice(ua='') {
  if (/Mobile|iPhone|Android(?!.*Tablet)/.test(ua)) return 'mobile';
  if (/iPad|Tablet/.test(ua)) return 'tablet';
  return 'desktop';
}

async function geolocate(ip) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.')) return {};
  try {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=country,city,regionName`);
    const d = await r.json();
    return { country: d.country||'', city: d.city||'', region: d.regionName||'' };
  } catch { return {}; }
}

async function saveVisitor(ip, ua, ref, lang) {
  const now = Date.now();
  const browser = parseBrowser(ua);
  const os = parseOS(ua);
  const device = parseDevice(ua);
  const visitor = { ts: now, ip, browser, os, device, ref: ref || '', lang: (lang||'').slice(0,10) };
  // Store basic first, then update with geo
  await redis([['LPUSH', 'visitors', JSON.stringify(visitor)], ['LTRIM', 'visitors', '0', '99']]);
  // Async geo update - best effort
  geolocate(ip).then(async (geo) => {
    if (!geo.country) return;
    const enriched = JSON.stringify({ ...visitor, country: geo.country, city: geo.city, region: geo.region });
    await redis([['LSET', 'visitors', '0', enriched]]);
  }).catch(() => {});
}

async function trackPV(ref, ip) {
  const now = Date.now();
  const d   = isoDate(now);
  const h   = isoHour(now);
  const cmds = [
    ['INCR', 'pv_total'],
    ['INCR', `pv_d:${d}`],
    ['EXPIRE', `pv_d:${d}`, 86400 * 9],
    ['INCR', `pv_h:${d}:${h}`],
    ['EXPIRE', `pv_h:${d}:${h}`, 86400 * 2],
  ];
  // Unique visitors via HyperLogLog
  if (ip) {
    cmds.push(['PFADD', `uv_d:${d}`, ip]);
    cmds.push(['EXPIRE', `uv_d:${d}`, 86400 * 9]);
    cmds.push(['PFADD', 'uv_total', ip]);
  }
  // Referrer — store full URL
  if (ref && ref.startsWith('http')) cmds.push(['ZINCRBY', 'refs', 1, ref]);
  await redis(cmds);
}

async function trackEvent(type) {
  await redis([['HINCRBY', 'events', type, 1]]);
}

async function saveLead(lead) {
  const json = JSON.stringify(lead);
  await redis([
    ['LPUSH', 'leads', json],
    ['LTRIM', 'leads', '0', '49'],
    ['INCR', 'leads_total'],
  ]);
}

app.get('/product', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'product.html'));
});

app.get(['/', '/index.html'], async (req, res) => {
  const ref = req.headers['referer'] || '';
  const ip  = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const ua  = req.headers['user-agent'] || '';
  const lang = req.headers['accept-language'] || '';
  trackPV(ref, ip).catch(() => {});
  saveVisitor(ip, ua, ref, lang).catch(() => {});
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Track client-side events ──
app.post('/api/track', async (req, res) => {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  const { type } = body || {};
  if (type) trackEvent(type).catch(() => {});
  res.send('ok');
});

// ── Admin ──
const ADMIN_PASS = process.env.ADMIN_PASS || 'synero2026';

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'assets', 'admin.html'));
});

app.get('/api/stats', async (req, res) => {
  if (req.query.pass !== ADMIN_PASS) return res.status(401).json({ error: 'unauthorized' });

  const now = Date.now();

  // Day keys for past 7 days
  const dayKeys = Array.from({ length: 7 }, (_, i) => `pv_d:${isoDate(now - i * 86400000)}`);

  // Hourly keys for past 24 hours
  const hourSlots = Array.from({ length: 24 }, (_, i) => {
    const t = now - (23 - i) * 3600000;
    return { key: `pv_h:${isoDate(t)}:${isoHour(t)}`, h: new Date(t).getUTCHours() };
  });

  const todayDate = isoDate(now);
  const uvDayKeys = Array.from({ length: 7 }, (_, i) => `uv_d:${isoDate(now - i * 86400000)}`);

  const pipeline = [
    ['GET', 'pv_total'],
    ['HGETALL', 'events'],
    ['ZREVRANGE', 'refs', '0', '9', 'WITHSCORES'],
    ['LRANGE', 'leads', '0', '19'],
    ['LRANGE', 'visitors', '0', '49'],
    ['GET', 'leads_total'],
    ['PFCOUNT', `uv_d:${todayDate}`],
    ['PFCOUNT', 'uv_total'],
    ...dayKeys.map(k => ['GET', k]),
    ...hourSlots.map(s => ['GET', s.key]),
  ];

  const results = await redis(pipeline);

  const [pvTotal, evHash, refsRaw, leadsRaw, visitorsRaw, leadsTotal, uvToday, uvTotal, ...rest] = results;
  const dayVals  = rest.slice(0, 7).map(v => parseInt(v) || 0);
  const hourVals = rest.slice(7).map(v => parseInt(v) || 0);

  // Parse events hash (flat array [k,v,k,v,...])
  const events = {};
  if (Array.isArray(evHash)) {
    for (let i = 0; i < evHash.length; i += 2) events[evHash[i]] = parseInt(evHash[i + 1]) || 0;
  }

  // Parse referrers (flat array [url, score, url, score,...])
  const top_ref = [];
  if (Array.isArray(refsRaw)) {
    for (let i = 0; i < refsRaw.length; i += 2) {
      top_ref.push({ k: refsRaw[i], v: parseInt(refsRaw[i + 1]) || 0 });
    }
  }

  // Parse leads
  const recent_leads = (leadsRaw || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

  // Parse visitors
  const recent_visitors = (visitorsRaw || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

  res.json({
    pv_today:     dayVals[0],
    pv_week:      dayVals.reduce((a, b) => a + b, 0),
    pv_total:     parseInt(pvTotal) || 0,
    leads_total:  parseInt(leadsTotal) || 0,
    uv_today:     parseInt(uvToday) || 0,
    uv_total:     parseInt(uvTotal) || 0,
    events,
    top_ref,
    hours:        hourSlots.map((s, i) => ({ h: s.h, v: hourVals[i] })),
    recent_leads,
    recent_visitors,
  });
});

app.get('/assets/:file', (req, res) => {
  const filePath = path.join(__dirname, 'assets', path.basename(req.params.file));
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

app.get('/_health', (req, res) => res.send('ok'));

app.get('/api/redis-test', async (req, res) => {
  if (req.query.pass !== ADMIN_PASS) return res.status(401).end();
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return res.json({ error: 'env vars missing', url: !!url, token: !!token });
  try {
    // Write a test event and read it back
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['HINCRBY', 'events', 'test_event', 1],
        ['HGETALL', 'events'],
      ]),
    });
    const data = await r.json();
    res.json({ status: r.status, results: data });
  } catch (e) {
    res.json({ error: e.message });
  }
});

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

  // Save lead to Redis
  saveLead({ ts: Date.now(), name, email: customerEmail, phone: phone||'', id: id||'contact' }).catch(() => {});

  // Send lead to CRM
  try {
    const nameParts = (name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || name;
    const lastName  = nameParts.slice(1).join(' ') || '';
    await fetch('https://app-one-beta-xengw8j0d0.vercel.app/api/ingest/leads', {
      method: 'POST',
      headers: { 'X-API-Key': 'ca087981-c22b-444b-b225-75f191ef9ddd', 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName, lastName, email: customerEmail, phone: phone || '', company: '' }),
    });
  } catch (e) {
    console.error('CRM ingest error:', e.message);
  }

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
        from:     'onboarding@resend.dev',
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

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
}

module.exports = app;
