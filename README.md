Run server + send-email instructions

1) Install dependencies

```bash
npm install
```

2) Set SMTP env vars (example using Gmail SMTP or any SMTP provider)

- `SMTP_HOST` (e.g. smtp.gmail.com)
- `SMTP_PORT` (e.g. 465 or 587)
- `SMTP_USER` (SMTP username)
- `SMTP_PASS` (SMTP password or app password)
- optional: `FROM_EMAIL` (from address)
- optional: `TO_EMAIL` (defaults to cto@sy-nero.com)

Example (macOS / zsh):

```bash
export SMTP_HOST=smtp.mailprovider.com
export SMTP_PORT=465
export SMTP_USER=you@example.com
export SMTP_PASS=yourpassword
export FROM_EMAIL=you@example.com
export TO_EMAIL=cto@sy-nero.com
```

3) Start the server

```bash
npm start
```

4) Open the site

Navigate to `http://localhost:3000/index.html` and click "צפייה בפרטים" then "בקשת הצעה" — the server will send an email to `TO_EMAIL` with the product info.

Notes
- For Gmail you may need to create an app password or allow less secure apps (not recommended). Use a transactional email provider for production.
- Deploy the server to a hosting platform (Vercel, Render, Heroku) and set env vars there for production use.
