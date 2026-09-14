# Supabase migration

This app can now run without Render by using one Supabase Edge Function named `scheduler`.

## What Supabase serves

- Static pages: dashboard, login, booking page, thank-you page, CSS, JS, images.
- API routes: settings, appointments, slots, bookings, calendar events.
- Google OAuth routes: `/auth/google` and `/oauth2callback`.

## Required Supabase secrets

Set these in Supabase Dashboard > Edge Functions > Secrets:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
FRONTEND_URL
RESEND_API_KEY
EMAIL_FROM
EMAIL_REPLY_TO
```

Use these production values:

```text
SUPABASE_URL=https://jqhvndttyqailhxmxfbq.supabase.co
GOOGLE_REDIRECT_URI=https://jqhvndttyqailhxmxfbq.supabase.co/functions/v1/scheduler/oauth2callback
FRONTEND_URL=https://jqhvndttyqailhxmxfbq.supabase.co/functions/v1/scheduler
EMAIL_REPLY_TO=psic.ernestomoreno@gmail.com
```

`SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_CLIENT_SECRET`, and `RESEND_API_KEY` are private. Never put them in `public/config.js`.

## Google Cloud Console

Add this exact authorized redirect URI to the OAuth client:

```text
https://jqhvndttyqailhxmxfbq.supabase.co/functions/v1/scheduler/oauth2callback
```

After this is live, the public booking page is:

```text
https://jqhvndttyqailhxmxfbq.supabase.co/functions/v1/scheduler/book.html
```

The dashboard is:

```text
https://jqhvndttyqailhxmxfbq.supabase.co/functions/v1/scheduler
```

## Deploy commands

From this project folder:

```sh
supabase link --project-ref jqhvndttyqailhxmxfbq
supabase db push
supabase functions deploy scheduler
```

## DNS later

After the Supabase version is verified, point `booking.ernestomoreno.net` to the Supabase-hosted version or keep using the Supabase function URL directly.
