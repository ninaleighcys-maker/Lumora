# Lumora free deployment

Lumora can run on Render’s Free web service with a free managed PostgreSQL provider. The web service filesystem is ephemeral, so the app now supports `DATABASE_URL` and stores its complete application state in PostgreSQL instead of relying on `data/db.json` when that variable is present.

## Recommended free setup

- **Web app:** Render Free Web Service
- **Database:** Supabase Free Postgres (or another PostgreSQL provider with a free tier)
- **Email:** Brevo Free transactional email using SMTP port `2525`
- **URL:** Render gives the app a free `*.onrender.com` address; no domain purchase is required.

## Required environment variables on Render

```text
APP_URL=https://YOUR-APP.onrender.com
DATABASE_URL=your-postgresql-connection-string
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=2525
SMTP_SECURE=false
SMTP_USER=your-brevo-smtp-login
SMTP_PASS=your-brevo-smtp-key
SMTP_FROM=your-verified-sender@example.com
```

Do not commit real SMTP credentials or the database connection string to GitHub. Put them in Render Environment Variables.

## Important free-tier behavior

Render Free web services can sleep after inactivity and their local filesystem is not persistent. Render’s own Free Postgres currently expires after 30 days, so this project is designed to use an external managed PostgreSQL database for longer-lived free testing.

Brevo’s Free plan currently provides 300 email sends per day. Render blocks outbound SMTP ports 25, 465, and 587, so Brevo port 2525 is used instead.
