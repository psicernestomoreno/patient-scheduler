# Patient Scheduler

A small appointment scheduler for a clinic. Patients open a booking link, choose an available time, enter their details, and the appointment is saved. When Google Calendar is connected, the app checks Google Calendar free/busy time and creates calendar events for new bookings.

## Run

Use the bundled Node runtime in this Codex workspace:

```sh
/Users/ernestomoreno/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server.js
```

Then open:

- Clinician dashboard: http://localhost:4173
- Patient booking page: http://localhost:4173/book.html

## Google Calendar

Create OAuth credentials in Google Cloud Console and add this redirect URI:

```text
http://localhost:4173/oauth2callback
```

Start the app with these environment variables:

```sh
GOOGLE_CLIENT_ID="your-client-id" \
GOOGLE_CLIENT_SECRET="your-client-secret" \
/Users/ernestomoreno/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server.js
```

Open http://localhost:4173/auth/google to connect Calendar.

## Database

For local development, the app stores appointments in `data/appointments.json`.

For deployment, set `DATABASE_URL` to your Supabase Postgres connection string:

```text
postgresql://postgres:your-password@db.your-project.supabase.co:5432/postgres
```

When `DATABASE_URL` is present, the app creates an `appointments` table automatically and stores bookings there.

## Render environment variables

Set these on Render:

```text
DATABASE_URL=postgresql://...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://booking.ernestomoreno.net/oauth2callback
RESEND_API_KEY=re_...
EMAIL_FROM=Psicologo Ernesto Moreno <appointments@your-verified-domain.com>
EMAIL_REPLY_TO=psic.ernestomoreno@gmail.com
```

`RESEND_API_KEY` and `EMAIL_FROM` enable bilingual patient confirmation emails. The sender address must use a domain verified in Resend. `EMAIL_REPLY_TO` is the address that receives patient replies.

## Customize

Edit `data/settings.json` to change:

- clinic name
- appointment length
- buffer time
- available working hours
- visit types
- calendar ID
