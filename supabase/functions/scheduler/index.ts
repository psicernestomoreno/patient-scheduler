import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { staticAssets } from "./static-assets.ts";

type Appointment = {
  id: string;
  patientName: string;
  partnerName?: string;
  email: string;
  phone: string;
  reason?: string;
  language: "en" | "es";
  visitType: string;
  visitName: string;
  start: string;
  end: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  googleEventId?: string;
  confirmationEmail?: Record<string, unknown>;
};

type Settings = typeof defaultSettings;

const env = {
  supabaseUrl: Deno.env.get("SUPABASE_URL") || "",
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  clientId: Deno.env.get("GOOGLE_CLIENT_ID") || "",
  clientSecret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "",
  redirectUri: Deno.env.get("GOOGLE_REDIRECT_URI") || "",
  frontendUrl: (Deno.env.get("FRONTEND_URL") || "https://booking.ernestomoreno.net").replace(/\/$/, ""),
  resendApiKey: Deno.env.get("RESEND_API_KEY") || "",
  emailFrom: Deno.env.get("EMAIL_FROM") || "",
  emailReplyTo: Deno.env.get("EMAIL_REPLY_TO") || "psic.ernestomoreno@gmail.com"
};

const supabase = createClient(env.supabaseUrl, env.serviceRoleKey, {
  auth: { persistSession: false }
});

const defaultSettings = {
  clinicName: "Psicólogo Ernesto Moreno",
  allowedGoogleEmail: "psic.ernestomoreno@gmail.com",
  officeMapQuery: "Psicólogo Ernesto Moreno",
  officeAddress: "Calle Colombia 9112 - 10, Colonia Madero (La Cacho), 22040, Tijuana, Baja California, Mexico",
  calendarId: "primary",
  timezone: "America/Tijuana",
  appointmentMinutes: 50,
  bufferMinutes: 10,
  bookingWindowDays: 60,
  workingHours: {
    "1": [["10:00", "18:00"]],
    "2": [["10:00", "18:00"]],
    "3": [["10:00", "18:00"]],
    "4": [["10:00", "18:00"]],
    "5": [["10:00", "18:00"]],
    "6": [["09:00", "15:00"]]
  },
  visitTypes: [
    { id: "individual", name: "Individual Therapy", minutes: 50 },
    { id: "couples", name: "Couples Therapy", minutes: 50 },
    { id: "family", name: "Family Therapy", minutes: 50 }
  ]
};

Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(req.url);
    const pathname = normalizePathname(url.pathname);

    if (req.method === "GET" && pathname === "/api/settings") {
      const settings = await loadSettings();
      const { allowedGoogleEmail: _privateEmail, ...publicSettings } = settings;
      return json(req, {
        ...publicSettings,
        googleConnected: Boolean(await getAccessToken().catch(() => null)),
        patientLink: `${env.frontendUrl}/book.html`
      });
    }

    if (req.method === "GET" && pathname === "/api/appointments") {
      if (!(await currentUser(req))) return json(req, { error: "Sign in with Google to view this." }, 401);
      return json(req, await listAppointments());
    }

    const appointmentMatch = pathname.match(/^\/api\/appointments\/([^/]+)$/);
    if (appointmentMatch && req.method === "PATCH") {
      if (!(await currentUser(req))) return json(req, { error: "Sign in with Google to view this." }, 401);
      return json(req, await rescheduleAppointment(appointmentMatch[1], await req.json()));
    }

    if (appointmentMatch && req.method === "DELETE") {
      if (!(await currentUser(req))) return json(req, { error: "Sign in with Google to view this." }, 401);
      await deleteAppointment(appointmentMatch[1]);
      return json(req, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/calendar-events") {
      if (!(await currentUser(req))) return json(req, { error: "Sign in with Google to view this." }, 401);
      return json(req, await getGoogleCalendarEvents());
    }

    if (req.method === "GET" && pathname === "/api/slots") {
      return json(req, await availableSlots(url.searchParams.get("visitType") || "individual", "", {
        from: url.searchParams.get("from") || "",
        days: Number(url.searchParams.get("days") || 0) || undefined,
        includeUnavailable: url.searchParams.get("includeUnavailable") === "1"
      }));
    }

    if (req.method === "POST" && pathname === "/api/bookings") {
      return json(req, await createBooking(await req.json()), 201);
    }

    if (req.method === "GET" && pathname === "/auth/google") {
      return redirectToGoogle();
    }

    if (req.method === "GET" && pathname === "/oauth2callback") {
      return finishGoogleOAuth(url);
    }

    if (req.method === "GET" && pathname === "/logout") {
      return redirect(`${env.frontendUrl}/login.html`, cookieHeader("", 0));
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if ((pathname === "/" || pathname === "/index.html") && !(await currentUser(req))) {
        return redirect(`${appBaseUrl(req)}/login.html`);
      }
      return serveStatic(pathname, req);
    }

    return json(req, { error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    return json(req, { error: errorMessage(error) || "Something went wrong. Please try again." }, errorStatus(error));
  }
});

async function createBooking(body: Record<string, unknown>) {
  const settings = await loadSettings();
  const visit = settings.visitTypes.find((item) => item.id === clean(body.visitType)) || settings.visitTypes[0];
  const start = new Date(String(body.start || ""));
  if (Number.isNaN(start.getTime())) throw statusError("Choose a valid appointment time.", 400);

  const end = new Date(start.getTime() + visit.minutes * 60_000);
  const booking: Appointment = {
    id: crypto.randomUUID(),
    patientName: clean(body.patientName),
    partnerName: clean(body.partnerName),
    email: clean(body.email),
    phone: clean(body.phone),
    reason: clean(body.reason),
    language: body.language === "es" ? "es" : "en",
    visitType: visit.id,
    visitName: visit.name,
    start: start.toISOString(),
    end: end.toISOString(),
    status: "booked",
    createdAt: new Date().toISOString()
  };

  if (!booking.patientName || !booking.email || !booking.phone) throw statusError("Name, email, and phone are required.", 400);
  if (visit.id === "couples" && !booking.partnerName) throw statusError("Partner name is required for couples therapy.", 400);

  const slots = await availableSlots(visit.id);
  const selectedSlot = slots.find((slot) => slot.start === booking.start);
  const appointments = await listAppointments();
  const alreadyBooked = appointments.some((appointment) => appointment.status !== "cancelled" &&
    rangesOverlap(start, end, new Date(appointment.start), new Date(appointment.end)));
  if (!selectedSlot || alreadyBooked) throw statusError("That time was just booked. Please choose another time.", 409);

  await saveAppointment(booking);

  const event = await createCalendarEvent(booking, settings).catch((error) => {
    console.warn("Google Calendar event was not created:", errorMessage(error));
    return null;
  });
  if (event?.id) {
    booking.googleEventId = event.id;
    await updateAppointmentRecord(booking);
  }

  booking.confirmationEmail = await sendBookingConfirmation(booking, settings).catch((error) => {
    console.warn("Confirmation email was not sent:", errorMessage(error));
    return { sent: false, error: errorMessage(error) };
  });
  await updateAppointmentRecord(booking);
  return booking;
}

async function rescheduleAppointment(id: string, body: Record<string, unknown>) {
  const settings = await loadSettings();
  const appointments = await listAppointments();
  const appointment = appointments.find((item) => item.id === id);
  if (!appointment) throw statusError("Appointment was not found.", 404);

  const visit = settings.visitTypes.find((item) => item.id === appointment.visitType) || settings.visitTypes[0];
  const start = new Date(String(body.start || ""));
  if (Number.isNaN(start.getTime())) throw statusError("Choose a valid appointment time.", 400);

  const end = new Date(start.getTime() + visit.minutes * 60_000);
  const slots = await availableSlots(visit.id, id);
  const selectedSlot = slots.find((slot) => slot.start === start.toISOString());
  const alreadyBooked = appointments.some((item) => item.id !== id && item.status !== "cancelled" &&
    rangesOverlap(start, end, new Date(item.start), new Date(item.end)));
  if (!selectedSlot || alreadyBooked) throw statusError("That time is not available. Please choose another time.", 409);

  const updatedAppointment = {
    ...appointment,
    start: start.toISOString(),
    end: end.toISOString(),
    updatedAt: new Date().toISOString()
  };
  await updateAppointmentRecord(updatedAppointment);
  if (updatedAppointment.googleEventId) {
    await updateCalendarEvent(updatedAppointment, settings).catch((error) => {
      console.warn("Google Calendar event was not updated:", errorMessage(error));
    });
  }
  return updatedAppointment;
}

async function deleteAppointment(id: string) {
  const appointments = await listAppointments();
  const deletedAppointment = appointments.find((item) => item.id === id);
  if (!deletedAppointment) throw statusError("Appointment was not found.", 404);
  await removeAppointment(id);
  if (deletedAppointment.googleEventId) {
    await deleteCalendarEvent(deletedAppointment.googleEventId).catch((error) => {
      console.warn("Google Calendar event was not deleted:", errorMessage(error));
    });
  }
}

async function availableSlots(visitTypeId: string, ignoreAppointmentId = "", options: { from?: string; days?: number; includeUnavailable?: boolean } = {}) {
  const settings = await loadSettings();
  const timezone = settings.timezone || "America/Tijuana";
  const visit = settings.visitTypes.find((item) => item.id === visitTypeId) || settings.visitTypes[0];
  const appointments = await listAppointments();
  const now = new Date();
  const today = zonedDateParts(now, timezone);
  const startDate = parseLocalDate(options.from) || today;
  const bookingWindowDays = Math.max(Number(settings.bookingWindowDays || 0), Number(defaultSettings.bookingWindowDays || 0), Number(options.days || 0));
  const daysToCheck = Math.min(Math.max(Number(options.days || bookingWindowDays), 1), bookingWindowDays);
  const windowStart = zonedTimeToUtc(startDate, "00:00", timezone);
  const windowEnd = zonedTimeToUtc(addDays(startDate, daysToCheck), "00:00", timezone);
  const localBusy = appointments
    .filter((item) => item.id !== ignoreAppointmentId && item.status !== "cancelled")
    .map((item) => ({ start: new Date(item.start), end: new Date(item.end) }));
  const googleBusy = await getGoogleBusy(settings, windowStart, windowEnd);
  const busy = [...localBusy, ...googleBusy];
  const slots = [];

  for (let dayOffset = 0; dayOffset < daysToCheck; dayOffset += 1) {
    const localDate = addDays(startDate, dayOffset);
    const ranges = settings.workingHours[String(weekdayForDate(localDate)) as keyof Settings["workingHours"]] || [];
    for (const [from, to] of ranges) {
      let cursor = zonedTimeToUtc(localDate, from, timezone);
      const lastStart = zonedTimeToUtc(localDate, to, timezone);
      while (cursor <= lastStart) {
        const end = new Date(cursor.getTime() + visit.minutes * 60_000);
        const beginsSoon = cursor.getTime() < now.getTime() + 2 * 60 * 60_000;
        const overlaps = busy.some((item) => cursor < item.end && end > item.start);
        const available = !beginsSoon && !overlaps;
        if (available || options.includeUnavailable) {
          slots.push({
            start: cursor.toISOString(),
            end: end.toISOString(),
            available,
            label: cursor.toLocaleString("en-US", {
              timeZone: timezone,
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit"
            })
          });
        }
        cursor = new Date(cursor.getTime() + (visit.minutes + Number(settings.bufferMinutes || 0)) * 60_000);
      }
    }
  }
  return slots.slice(0, options.includeUnavailable ? 800 : 600);
}

function redirectToGoogle() {
  if (!env.clientId || !env.clientSecret || !env.redirectUri) {
    return html("Google credentials are missing. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.");
  }
  const params = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: env.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: "openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.readonly",
    state: crypto.randomUUID()
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

function normalizePathname(pathname: string) {
  const stripped = pathname
    .replace(/^\/functions\/v1\/scheduler/, "")
    .replace(/^\/scheduler/, "");
  return stripped || "/";
}

async function finishGoogleOAuth(url: URL) {
  const code = url.searchParams.get("code");
  if (!code) return html("Google did not return an authorization code.");
  const token = await postForm("https://oauth2.googleapis.com/token", {
    code,
    client_id: env.clientId,
    client_secret: env.clientSecret,
    redirect_uri: env.redirectUri,
    grant_type: "authorization_code"
  });
  const user = await getGoogleUser(token.access_token);
  const settings = await loadSettings();
  const allowedEmail = clean(settings.allowedGoogleEmail).toLowerCase();
  const userEmail = clean(user.email).toLowerCase();
  if (allowedEmail && allowedEmail !== userEmail) {
    return html(`This Google account (${escapeHtml(user.email || "unknown")}) is not allowed to access the clinician dashboard.`);
  }

  token.expires_at = Date.now() + token.expires_in * 1000;
  token.user = { email: user.email, name: user.name, picture: user.picture };
  await saveState("google_token", token);
  const sessionId = crypto.randomUUID();
  await saveState(`session:${sessionId}`, { email: user.email, name: user.name, createdAt: new Date().toISOString() });
  return redirect(env.frontendUrl, cookieHeader(sessionId, 604800));
}

async function getAccessToken() {
  const token = await readState("google_token");
  if (!token?.access_token) return null;
  if (token.expires_at && token.expires_at > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) return token.access_token;

  const refreshed = await postForm("https://oauth2.googleapis.com/token", {
    client_id: env.clientId,
    client_secret: env.clientSecret,
    refresh_token: token.refresh_token,
    grant_type: "refresh_token"
  });
  const nextToken = {
    ...token,
    ...refreshed,
    refresh_token: refreshed.refresh_token || token.refresh_token,
    expires_at: Date.now() + refreshed.expires_in * 1000
  };
  await saveState("google_token", nextToken);
  return nextToken.access_token;
}

async function currentUser(req: Request) {
  const sessionId = parseCookies(req.headers.get("cookie") || "").scheduler_session;
  if (!sessionId) return null;
  return readState(`session:${sessionId}`);
}

async function createCalendarEvent(booking: Appointment, settings: Settings) {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(settings.calendarId || "primary")}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: `${booking.visitName}: ${booking.patientName}`,
      description: [
        `Phone: ${booking.phone}`,
        `Email: ${booking.email}`,
        booking.partnerName ? `Partner: ${booking.partnerName}` : "",
        booking.reason ? `Reason: ${booking.reason}` : ""
      ].filter(Boolean).join("\n"),
      start: { dateTime: booking.start, timeZone: settings.timezone },
      end: { dateTime: booking.end, timeZone: settings.timezone },
      attendees: [{ email: booking.email, displayName: booking.patientName }]
    })
  });
  if (!response.ok) throw new Error(await googleErrorMessage(response));
  return response.json();
}

async function updateCalendarEvent(appointment: Appointment, settings: Settings) {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(settings.calendarId || "primary")}/events/${encodeURIComponent(appointment.googleEventId || "")}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      start: { dateTime: appointment.start, timeZone: settings.timezone },
      end: { dateTime: appointment.end, timeZone: settings.timezone }
    })
  });
  if (!response.ok) throw new Error(await googleErrorMessage(response));
  return response.json();
}

async function deleteCalendarEvent(eventId: string) {
  const settings = await loadSettings();
  const accessToken = await getAccessToken();
  if (!accessToken) return;
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(settings.calendarId || "primary")}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok && response.status !== 410 && response.status !== 404) throw new Error(await googleErrorMessage(response));
}

async function getGoogleCalendarEvents() {
  const settings = await loadSettings();
  const accessToken = await getAccessToken();
  if (!accessToken) return { connected: false, events: [] };
  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + 14);
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: windowEnd.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "12"
  });
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(settings.calendarId || "primary")}/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) return { connected: true, events: [], error: await googleErrorMessage(response) };
  const payload = await response.json();
  return {
    connected: true,
    events: (payload.items || []).map((event: Record<string, any>) => ({
      id: event.id,
      title: event.summary || "Busy",
      start: event.start?.dateTime || event.start?.date,
      end: event.end?.dateTime || event.end?.date,
      location: event.location || "",
      htmlLink: event.htmlLink || ""
    }))
  };
}

async function getGoogleBusy(settings: Settings, start: Date, end: Date) {
  const accessToken = await getAccessToken();
  if (!accessToken) throw statusError("Google Calendar is not connected. Please connect Google Calendar before accepting bookings.", 503);
  const calendarIds = await getGoogleBusyCalendarIds(accessToken, settings);
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone: settings.timezone,
      items: calendarIds.map((id) => ({ id }))
    })
  });
  if (!response.ok) throw new Error(await googleErrorMessage(response));
  const payload = await response.json();
  const readableCalendars = Object.values(payload.calendars || {}).filter((calendar: any) => !calendar?.errors?.[0]);
  if (!readableCalendars.length) throw new Error("Google Calendar availability could not be checked.");
  return readableCalendars
    .flatMap((calendar: any) => calendar?.busy || [])
    .map((item: any) => ({ start: new Date(item.start), end: new Date(item.end) }));
}

async function getGoogleBusyCalendarIds(accessToken: string, settings: Settings): Promise<string[]> {
  const response = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error(await googleErrorMessage(response));
  const payload = await response.json();
  const ids = (payload.items || [])
    .filter((calendar: any) => !calendar.deleted && !calendar.hidden)
    .map((calendar: any) => calendar.id)
    .filter(Boolean);
  return ids.length ? ids : [settings.calendarId || "primary"];
}

async function sendBookingConfirmation(booking: Appointment, settings: Settings) {
  if (!env.resendApiKey || !env.emailFrom) return { sent: false, reason: "not_configured" };
  const spanish = booking.language === "es";
  const dateTime = formatAppointmentDate(booking.start, settings.timezone, booking.language);
  const visitName = translatedVisitName(booking.visitType, booking.language);
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(settings.officeAddress)}`;
  const subject = spanish ? `Cita confirmada - ${dateTime}` : `Appointment confirmed - ${dateTime}`;
  const greeting = spanish ? `Hola ${booking.patientName},` : `Hello ${booking.patientName},`;
  const intro = spanish ? "Tu cita ha sido reservada. Estos son los detalles:" : "Your appointment has been booked. Here are the details:";
  const labels = spanish
    ? { visit: "Tipo de cita", when: "Fecha y hora", duration: "Duración", address: "Dirección", minutes: "50 minutos", map: "Ver en Google Maps", closing: "Si necesitas hacer un cambio, responde a este correo." }
    : { visit: "Visit type", when: "Date and time", duration: "Duration", address: "Address", minutes: "50 minutes", map: "View in Google Maps", closing: "If you need to make a change, reply to this email." };
  const text = [
    greeting,
    "",
    intro,
    `${labels.visit}: ${visitName}`,
    `${labels.when}: ${dateTime}`,
    `${labels.duration}: ${labels.minutes}`,
    `${labels.address}: ${settings.officeAddress}`,
    "",
    `${labels.map}: ${mapUrl}`,
    "",
    labels.closing,
    settings.clinicName
  ].join("\n");
  const htmlBody = `<!doctype html><html lang="${spanish ? "es" : "en"}"><body style="margin:0;background:#f4f6f5;font-family:Arial,sans-serif;color:#1d2925"><div style="max-width:620px;margin:0 auto;padding:32px 16px"><div style="background:#ffffff;border:1px solid #dce4e0;padding:32px"><p style="margin:0 0 18px;font-size:18px">${escapeHtml(greeting)}</p><p style="margin:0 0 24px;line-height:1.6">${escapeHtml(intro)}</p><table role="presentation" style="width:100%;border-collapse:collapse;line-height:1.5">${emailDetailRow(labels.visit, visitName)}${emailDetailRow(labels.when, dateTime)}${emailDetailRow(labels.duration, labels.minutes)}${emailDetailRow(labels.address, settings.officeAddress)}</table><p style="margin:28px 0"><a href="${escapeHtml(mapUrl)}" style="display:inline-block;background:#19624b;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:4px">${escapeHtml(labels.map)}</a></p><p style="margin:28px 0 6px;line-height:1.6">${escapeHtml(labels.closing)}</p><p style="margin:0;font-weight:bold">${escapeHtml(settings.clinicName)}</p></div></div></body></html>`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `booking-${booking.id}`
    },
    body: JSON.stringify({ from: env.emailFrom, to: [booking.email], reply_to: env.emailReplyTo, subject, html: htmlBody, text })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `Email service returned ${response.status}`);
  return { sent: true, id: payload.id, sentAt: new Date().toISOString() };
}

async function loadSettings(): Promise<Settings> {
  const saved = await readState("settings") || {};
  return {
    ...defaultSettings,
    ...saved,
    workingHours: saved.workingHours || defaultSettings.workingHours,
    visitTypes: saved.visitTypes || defaultSettings.visitTypes
  };
}

async function listAppointments(): Promise<Appointment[]> {
  const { data, error } = await supabase.from("appointments").select("data");
  if (error) throw error;
  return (data || [])
    .map((row: any) => row.data)
    .sort((a: Appointment, b: Appointment) => new Date(a.start).getTime() - new Date(b.start).getTime());
}

async function saveAppointment(appointment: Appointment) {
  const { error } = await supabase.from("appointments").insert({ id: appointment.id, data: appointment });
  if (error) throw error;
}

async function updateAppointmentRecord(appointment: Appointment) {
  const { error } = await supabase.from("appointments").update({ data: appointment, updated_at: new Date().toISOString() }).eq("id", appointment.id);
  if (error) throw error;
}

async function removeAppointment(id: string) {
  const { error } = await supabase.from("appointments").delete().eq("id", id);
  if (error) throw error;
}

async function readState(key: string) {
  const { data, error } = await supabase.from("app_state").select("data").eq("key", key).maybeSingle();
  if (error) throw error;
  return data?.data || null;
}

async function saveState(key: string, data: Record<string, unknown>) {
  const { error } = await supabase.from("app_state").upsert({ key, data, updated_at: new Date().toISOString() });
  if (error) throw error;
}

function rangesOverlap(firstStart: Date, firstEnd: Date, secondStart: Date, secondEnd: Date) {
  return firstStart < secondEnd && firstEnd > secondStart;
}

function zonedDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function parseLocalDate(value = "") {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function addDays(dateParts: { year: number; month: number; day: number }, days: number) {
  const date = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayForDate(dateParts: { year: number; month: number; day: number }) {
  return new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day)).getUTCDay();
}

function zonedTimeToUtc(dateParts: { year: number; month: number; day: number }, hhmm: string, timeZone: string) {
  const [hour, minute] = hhmm.split(":").map(Number);
  const guess = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, hour, minute, 0));
  return new Date(guess.getTime() - timeZoneOffset(guess, timeZone));
}

function timeZoneOffset(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second)) - date.getTime();
}

async function getGoogleUser(accessToken: string) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error(`Google user info returned ${response.status}`);
  return response.json();
}

async function googleErrorMessage(response: Response) {
  const payload = await response.json().catch(() => ({}));
  const reason = payload.error?.errors?.[0]?.reason;
  const message = payload.error?.message || `Google Calendar returned ${response.status}`;
  if (reason === "notACalendarUser") {
    return "This Google account has not activated Google Calendar yet. Open Google Calendar once with this account, or ask your Workspace admin to enable Calendar.";
  }
  return message;
}

async function postForm(url: string, form: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form)
  });
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return response.json();
}

function emailDetailRow(label: string, value: string) {
  return `<tr><td style="width:130px;padding:10px 12px 10px 0;border-top:1px solid #e5ebe8;color:#52635d;vertical-align:top">${escapeHtml(label)}</td><td style="padding:10px 0;border-top:1px solid #e5ebe8;font-weight:bold;vertical-align:top">${escapeHtml(value)}</td></tr>`;
}

function formatAppointmentDate(value: string, timezone: string, language: string) {
  return new Intl.DateTimeFormat(language === "es" ? "es-MX" : "en-US", {
    timeZone: timezone || "America/Tijuana",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function translatedVisitName(visitType: string, language: string) {
  const names: Record<string, Record<string, string>> = {
    individual: { en: "Individual Therapy", es: "Terapia individual" },
    couples: { en: "Couples Therapy", es: "Terapia de pareja" },
    family: { en: "Family Therapy", es: "Terapia familiar" }
  };
  return names[visitType]?.[language === "es" ? "es" : "en"] || visitType;
}

function clean(value: unknown) {
  return String(value || "").trim().slice(0, 500);
}

function parseCookies(cookieHeader: string) {
  return Object.fromEntries(cookieHeader.split(";").filter(Boolean).map((cookie) => {
    const [name, ...rest] = cookie.trim().split("=");
    return [decodeURIComponent(name), decodeURIComponent(rest.join("="))];
  }));
}

function statusError(message: string, status: number) {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message || "");
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error || "");
  }
}

function errorStatus(error: unknown) {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return 500;
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || env.frontendUrl;
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin"
  });
}

function json(req: Request, payload: unknown, status = 200) {
  const headers = corsHeaders(req);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  return new Response(JSON.stringify(payload), { status, headers });
}

function redirect(location: string, cookie = "") {
  const headers = new Headers({ Location: location });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

async function serveStatic(pathname: string, req: Request) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = requested.replace(/^\/+/, "").replace(/\.\./g, "") || "index.html";
  const asset = staticAssets[safePath as keyof typeof staticAssets];

  if (!asset) {
    return html("Not found");
  }

  const headers = corsHeaders(req);
  headers.set("Content-Type", asset.contentType);
  headers.set("Content-Disposition", "inline");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", /\.(html|css|js)$/i.test(safePath)
    ? "no-store, no-cache, must-revalidate, proxy-revalidate"
    : "public, max-age=300");
  const body = isTextAsset(asset.contentType)
    ? new TextDecoder().decode(base64ToBytes(asset.base64))
    : base64ToBytes(asset.base64);
  return new Response(body, { headers });
}

function isTextAsset(contentType: string) {
  return contentType.startsWith("text/") || contentType.includes("javascript");
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function appBaseUrl(req: Request) {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/functions/v1/scheduler")) {
    return `${url.origin}/functions/v1/scheduler`;
  }
  return env.frontendUrl;
}

function html(message: string) {
  return new Response(`<!doctype html><meta name="viewport" content="width=device-width"><title>Scheduler</title><body style="font-family:system-ui;padding:40px;line-height:1.5">${message}</body>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

function cookieHeader(sessionId: string, maxAge: number) {
  const value = sessionId ? `scheduler_session=${sessionId}` : "scheduler_session=";
  return `${value}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAge}`;
}

function escapeHtml(value: unknown) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char] || char);
}
