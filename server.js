import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const appointmentsFile = path.join(dataDir, "appointments.json");
const settingsFile = path.join(dataDir, "settings.json");
const tokenFile = path.join(dataDir, "google-token.json");
const port = Number(process.env.PORT || 4173);

const env = {
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/oauth2callback`,
  databaseUrl: process.env.DATABASE_URL,
  resendApiKey: process.env.RESEND_API_KEY,
  emailFrom: process.env.EMAIL_FROM,
  emailReplyTo: process.env.EMAIL_REPLY_TO || "psic.ernestomoreno@gmail.com"
};
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
let bookingQueue = Promise.resolve();
const sessions = new Map();
let dbPool;

await mkdir(dataDir, { recursive: true });
if (env.databaseUrl) await ensureDatabase();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname === "/auth/google") {
      await redirectToGoogle(res);
      return;
    }

    if (url.pathname === "/oauth2callback") {
      await finishGoogleOAuth(res, url);
      return;
    }

    if (url.pathname === "/logout") {
      signOut(req, res);
      return;
    }

    if (isProtectedPage(url.pathname) && !(await currentUser(req))) {
      res.writeHead(302, { Location: "/login.html" });
      res.end();
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, error.status || 500, { error: error.message || "Something went wrong. Please try again." });
  }
});

server.listen(port, () => {
  console.log(`Patient scheduler running at http://localhost:${port}`);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/settings") {
    const settings = await loadSettings();
    const { allowedGoogleEmail, ...publicSettings } = settings;
    sendJson(res, 200, {
      ...publicSettings,
      googleConnected: Boolean(await getAccessToken().catch(() => null)),
      patientLink: `${publicOrigin(req)}/book.html`
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/appointments") {
    if (!(await requireAuthenticatedApi(req, res))) return;
    sendJson(res, 200, await listAppointments());
    return;
  }

  const appointmentMatch = url.pathname.match(/^\/api\/appointments\/([^/]+)$/);
  if (appointmentMatch && req.method === "PATCH") {
    if (!(await requireAuthenticatedApi(req, res))) return;
    const body = await readBody(req);
    const appointment = await rescheduleAppointment(appointmentMatch[1], body);
    sendJson(res, 200, appointment);
    return;
  }

  if (appointmentMatch && req.method === "DELETE") {
    if (!(await requireAuthenticatedApi(req, res))) return;
    await deleteAppointment(appointmentMatch[1]);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/calendar-events") {
    if (!(await requireAuthenticatedApi(req, res))) return;
    sendJson(res, 200, await getGoogleCalendarEvents());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/slots") {
    const visitType = url.searchParams.get("visitType") || "consult";
    sendJson(res, 200, await availableSlots(visitType, "", {
      from: url.searchParams.get("from"),
      days: Number(url.searchParams.get("days") || 0) || undefined,
      includeUnavailable: url.searchParams.get("includeUnavailable") === "1"
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/bookings") {
    const body = await readBody(req);
    const booking = await createBooking(body);
    sendJson(res, 201, booking);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function createBooking(body) {
  const settings = await loadSettings();
  const visit = settings.visitTypes.find((item) => item.id === (body.visitType || "")) || settings.visitTypes[0];
  const start = new Date(body.start);

  if (Number.isNaN(start.getTime())) {
    const error = new Error("Choose a valid appointment time.");
    error.status = 400;
    throw error;
  }

  const end = new Date(start.getTime() + visit.minutes * 60_000);
  const booking = {
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

  if (!booking.patientName || !booking.email || !booking.phone) {
    const error = new Error("Name, email, and phone are required.");
    error.status = 400;
    throw error;
  }

  if (visit.id === "couples" && !booking.partnerName) {
    const error = new Error("Partner name is required for couples therapy.");
    error.status = 400;
    throw error;
  }

  await withBookingLock(async () => {
    const slots = await availableSlots(visit.id);
    const selectedSlot = slots.find((slot) => slot.start === booking.start);
    const appointments = await listAppointments();
    const alreadyBooked = appointments.some((appointment) => (
      appointment.status !== "cancelled" &&
      rangesOverlap(start, end, new Date(appointment.start), new Date(appointment.end))
    ));

    if (!selectedSlot || alreadyBooked) {
      const error = new Error("That time was just booked. Please choose another time.");
      error.status = 409;
      throw error;
    }

    await saveAppointment(booking);
  });

  const event = await createCalendarEvent(booking, settings).catch((error) => {
    console.warn("Google Calendar event was not created:", error.message);
    return null;
  });

  if (event?.id) {
    booking.googleEventId = event.id;
    await withBookingLock(async () => {
      await updateAppointmentRecord(booking);
    });
  }

  const email = await sendBookingConfirmation(booking, settings).catch((error) => {
    console.warn("Confirmation email was not sent:", error.message);
    return { sent: false, error: error.message };
  });

  booking.confirmationEmail = email;
  await withBookingLock(async () => {
    await updateAppointmentRecord(booking);
  });

  return booking;
}

async function sendBookingConfirmation(booking, settings) {
  if (!env.resendApiKey || !env.emailFrom) {
    return { sent: false, reason: "not_configured" };
  }

  const spanish = booking.language === "es";
  const dateTime = formatAppointmentDate(booking.start, settings.timezone, booking.language);
  const visitName = translatedVisitName(booking.visitType, booking.language);
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(settings.officeAddress)}`;
  const subject = spanish
    ? `Cita confirmada - ${dateTime}`
    : `Appointment confirmed - ${dateTime}`;
  const greeting = spanish ? `Hola ${booking.patientName},` : `Hello ${booking.patientName},`;
  const intro = spanish
    ? "Tu cita ha sido reservada. Estos son los detalles:"
    : "Your appointment has been booked. Here are the details:";
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
  const html = `<!doctype html>
<html lang="${spanish ? "es" : "en"}">
  <body style="margin:0;background:#f4f6f5;font-family:Arial,sans-serif;color:#1d2925">
    <div style="max-width:620px;margin:0 auto;padding:32px 16px">
      <div style="background:#ffffff;border:1px solid #dce4e0;padding:32px">
        <p style="margin:0 0 18px;font-size:18px">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 24px;line-height:1.6">${escapeHtml(intro)}</p>
        <table role="presentation" style="width:100%;border-collapse:collapse;line-height:1.5">
          ${emailDetailRow(labels.visit, visitName)}
          ${emailDetailRow(labels.when, dateTime)}
          ${emailDetailRow(labels.duration, labels.minutes)}
          ${emailDetailRow(labels.address, settings.officeAddress)}
        </table>
        <p style="margin:28px 0">
          <a href="${escapeHtml(mapUrl)}" style="display:inline-block;background:#19624b;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:4px">${escapeHtml(labels.map)}</a>
        </p>
        <p style="margin:28px 0 6px;line-height:1.6">${escapeHtml(labels.closing)}</p>
        <p style="margin:0;font-weight:bold">${escapeHtml(settings.clinicName)}</p>
      </div>
    </div>
  </body>
</html>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `booking-${booking.id}`,
      "User-Agent": "patient-scheduler/1.0"
    },
    body: JSON.stringify({
      from: env.emailFrom,
      to: [booking.email],
      reply_to: env.emailReplyTo,
      subject,
      html,
      text
    })
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message || `Email service returned ${response.status}`);
  }

  return { sent: true, id: payload.id, sentAt: new Date().toISOString() };
}

function emailDetailRow(label, value) {
  return `<tr>
    <td style="width:130px;padding:10px 12px 10px 0;border-top:1px solid #e5ebe8;color:#52635d;vertical-align:top">${escapeHtml(label)}</td>
    <td style="padding:10px 0;border-top:1px solid #e5ebe8;font-weight:bold;vertical-align:top">${escapeHtml(value)}</td>
  </tr>`;
}

function formatAppointmentDate(value, timezone, language) {
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

function translatedVisitName(visitType, language) {
  const names = {
    individual: { en: "Individual Therapy", es: "Terapia individual" },
    couples: { en: "Couples Therapy", es: "Terapia de pareja" },
    family: { en: "Family Therapy", es: "Terapia familiar" }
  };
  return names[visitType]?.[language === "es" ? "es" : "en"] || visitType;
}

async function rescheduleAppointment(id, body) {
  const settings = await loadSettings();
  let updatedAppointment;

  await withBookingLock(async () => {
    const appointments = await listAppointments();
    const appointment = appointments.find((item) => item.id === id);

    if (!appointment) {
      const error = new Error("Appointment was not found.");
      error.status = 404;
      throw error;
    }

    const visit = settings.visitTypes.find((item) => item.id === appointment.visitType) || settings.visitTypes[0];
    const start = new Date(body.start);

    if (Number.isNaN(start.getTime())) {
      const error = new Error("Choose a valid appointment time.");
      error.status = 400;
      throw error;
    }

    const end = new Date(start.getTime() + visit.minutes * 60_000);
    const slots = await availableSlots(visit.id, id);
    const selectedSlot = slots.find((slot) => slot.start === start.toISOString());
    const alreadyBooked = appointments.some((item) => (
      item.id !== id &&
      item.status !== "cancelled" &&
      rangesOverlap(start, end, new Date(item.start), new Date(item.end))
    ));

    if (!selectedSlot || alreadyBooked) {
      const error = new Error("That time is not available. Please choose another time.");
      error.status = 409;
      throw error;
    }

    updatedAppointment = {
      ...appointment,
      start: start.toISOString(),
      end: end.toISOString(),
      updatedAt: new Date().toISOString()
    };

    await updateAppointmentRecord(updatedAppointment);
  });

  if (updatedAppointment?.googleEventId) {
    await updateCalendarEvent(updatedAppointment, settings).catch((error) => {
      console.warn("Google Calendar event was not updated:", error.message);
    });
  }

  return updatedAppointment;
}

async function deleteAppointment(id) {
  let deletedAppointment;

  await withBookingLock(async () => {
    const appointments = await listAppointments();
    deletedAppointment = appointments.find((item) => item.id === id);

    if (!deletedAppointment) {
      const error = new Error("Appointment was not found.");
      error.status = 404;
      throw error;
    }

    await removeAppointment(id);
  });

  if (deletedAppointment?.googleEventId) {
    await deleteCalendarEvent(deletedAppointment.googleEventId).catch((error) => {
      console.warn("Google Calendar event was not deleted:", error.message);
    });
  }
}

async function withBookingLock(task) {
  const run = bookingQueue.then(task, task);
  bookingQueue = run.catch(() => {});
  return run;
}

function rangesOverlap(firstStart, firstEnd, secondStart, secondEnd) {
  return firstStart < secondEnd && firstEnd > secondStart;
}

async function availableSlots(visitTypeId, ignoreAppointmentId = "", options = {}) {
  const settings = await loadSettings();
  const timezone = settings.timezone || "America/Tijuana";
  const visit = settings.visitTypes.find((item) => item.id === visitTypeId) || settings.visitTypes[0];
  const appointments = await listAppointments();
  const now = new Date();
  const today = zonedDateParts(now, timezone);
  const startDate = parseLocalDate(options.from) || today;
  const bookingWindowDays = Math.max(
    Number(settings.bookingWindowDays || 0),
    Number(defaultSettings.bookingWindowDays || 0),
    Number(options.days || 0)
  );
  const daysToCheck = Math.min(Math.max(Number(options.days || bookingWindowDays), 1), bookingWindowDays);
  const windowStart = zonedTimeToUtc(startDate, "00:00", timezone);
  const afterLastDate = addDays(startDate, daysToCheck);
  const windowEnd = zonedTimeToUtc(afterLastDate, "00:00", timezone);
  const localBusy = appointments
    .filter((item) => item.id !== ignoreAppointmentId && item.status !== "cancelled")
    .map((item) => ({ start: new Date(item.start), end: new Date(item.end) }));
  const googleBusy = await getGoogleBusy(settings, windowStart, windowEnd);
  const busy = [...localBusy, ...googleBusy];
  const slots = [];

  for (let dayOffset = 0; dayOffset < daysToCheck; dayOffset += 1) {
    const localDate = addDays(startDate, dayOffset);
    const weekday = weekdayForDate(localDate);
    const ranges = settings.workingHours[String(weekday)] || [];

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

async function redirectToGoogle(res) {
  if (!env.clientId || !env.clientSecret) {
    sendHtml(res, "Google credentials are missing. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before connecting.");
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: env.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: "openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.readonly",
    state
  });

  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  res.end();
}

async function finishGoogleOAuth(res, url) {
  const code = url.searchParams.get("code");
  if (!code) {
    sendHtml(res, "Google did not return an authorization code.");
    return;
  }

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
    sendHtml(res, `This Google account (${escapeHtml(user.email || "unknown")}) is not allowed to access the clinician dashboard.`);
    return;
  }

  token.expires_at = Date.now() + token.expires_in * 1000;
  token.user = {
    email: user.email,
    name: user.name,
    picture: user.picture
  };
  await saveGoogleToken(token);
  signIn(res, token.user);
  res.writeHead(302, { Location: "/" });
  res.end();
}

async function getAccessToken() {
  const token = await readGoogleToken();
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
  await saveGoogleToken(nextToken);
  return nextToken.access_token;
}

async function getGoogleUser(accessToken) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Google user info returned ${response.status}`);
  }

  return response.json();
}

async function currentUser(req) {
  const sessionId = parseCookies(req.headers.cookie || "").scheduler_session;
  if (!sessionId) return null;
  return sessions.get(sessionId) || null;
}

async function requireAuthenticatedApi(req, res) {
  if (await currentUser(req)) return true;
  sendJson(res, 401, { error: "Sign in with Google to view this." });
  return false;
}

function signIn(res, user) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionId, {
    email: user.email,
    name: user.name,
    createdAt: new Date().toISOString()
  });
  res.setHeader("Set-Cookie", `scheduler_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}

function signOut(req, res) {
  const sessionId = parseCookies(req.headers.cookie || "").scheduler_session;
  if (sessionId) sessions.delete(sessionId);
  res.writeHead(302, {
    Location: "/login.html",
    "Set-Cookie": "scheduler_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  });
  res.end();
}

function parseCookies(cookieHeader) {
  return Object.fromEntries(cookieHeader.split(";").filter(Boolean).map((cookie) => {
    const [name, ...rest] = cookie.trim().split("=");
    return [decodeURIComponent(name), decodeURIComponent(rest.join("="))];
  }));
}

function isProtectedPage(pathname) {
  return pathname === "/" || pathname === "/index.html";
}

function publicOrigin(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${port}`;
  const protocol = req.headers["x-forwarded-proto"] || (String(host).startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}

async function createCalendarEvent(booking, settings) {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;

  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(settings.calendarId || "primary")}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
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

  if (!response.ok) {
    const message = await googleErrorMessage(response);
    throw new Error(message);
  }

  return response.json();
}

async function updateCalendarEvent(appointment, settings) {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;

  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(settings.calendarId || "primary")}/events/${encodeURIComponent(appointment.googleEventId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      start: { dateTime: appointment.start, timeZone: settings.timezone },
      end: { dateTime: appointment.end, timeZone: settings.timezone }
    })
  });

  if (!response.ok) {
    throw new Error(await googleErrorMessage(response));
  }

  return response.json();
}

async function deleteCalendarEvent(eventId) {
  const settings = await loadSettings();
  const accessToken = await getAccessToken();
  if (!accessToken) return;

  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(settings.calendarId || "primary")}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok && response.status !== 410 && response.status !== 404) {
    throw new Error(await googleErrorMessage(response));
  }
}

async function getGoogleCalendarEvents() {
  const settings = await loadSettings();
  const accessToken = await getAccessToken();

  if (!accessToken) {
    return { connected: false, events: [] };
  }

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

  if (!response.ok) {
    const message = await googleErrorMessage(response);
    return { connected: true, events: [], error: message };
  }

  const payload = await response.json();
  const events = (payload.items || []).map((event) => ({
    id: event.id,
    title: event.summary || "Busy",
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    location: event.location || "",
    htmlLink: event.htmlLink || ""
  }));

  return { connected: true, events };
}

async function getGoogleBusy(settings, start, end) {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    const error = new Error("Google Calendar is not connected. Please connect Google Calendar before accepting bookings.");
    error.status = 503;
    throw error;
  }

  const calendarIds = await getGoogleBusyCalendarIds(accessToken, settings);
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone: settings.timezone,
      items: calendarIds.map((id) => ({ id }))
    })
  });

  if (!response.ok) throw new Error(await googleErrorMessage(response));

  const payload = await response.json();
  const calendars = Object.values(payload.calendars || {});
  const readableCalendars = [];

  for (const calendar of calendars) {
    const calendarError = calendar?.errors?.[0];
    if (calendarError) {
      console.warn("Skipping Google Calendar during availability check:", calendarError.reason || "unknown");
      continue;
    }
    readableCalendars.push(calendar);
  }

  if (!readableCalendars.length) {
    throw new Error("Google Calendar availability could not be checked.");
  }

  const busy = readableCalendars.flatMap((calendar) => calendar?.busy || []);
  return busy.map((item) => ({ start: new Date(item.start), end: new Date(item.end) }));
}

async function getGoogleBusyCalendarIds(accessToken, settings) {
  const response = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) throw new Error(await googleErrorMessage(response));

  const payload = await response.json();
  const ids = (payload.items || [])
    .filter((calendar) => !calendar.deleted && !calendar.hidden)
    .map((calendar) => calendar.id)
    .filter(Boolean);

  return ids.length ? ids : [settings.calendarId || "primary"];
}

async function googleErrorMessage(response) {
  const payload = await response.json().catch(() => ({}));
  const reason = payload.error?.errors?.[0]?.reason;
  const message = payload.error?.message || `Google Calendar returned ${response.status}`;

  if (reason === "notACalendarUser") {
    return "This Google account has not activated Google Calendar yet. Open Google Calendar once with this account, or ask your Workspace admin to enable Calendar.";
  }

  return message;
}

async function postForm(url, form) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form)
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return response.json();
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  };
  const cacheControl = [".html", ".css", ".js"].includes(ext)
    ? "no-store, no-cache, must-revalidate, proxy-revalidate"
    : "public, max-age=300";

  createReadStream(filePath)
    .on("error", () => {
      res.writeHead(404);
      res.end("Not found");
    })
    .on("open", () => {
      res.writeHead(200, {
        "Content-Type": types[ext] || "application/octet-stream",
        "Cache-Control": cacheControl
      });
    })
    .pipe(res);
}

function atTime(day, hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const date = new Date(day);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function zonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day)
  };
}

function parseLocalDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function addDays(dateParts, days) {
  const date = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function weekdayForDate(dateParts) {
  return new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day)).getUTCDay();
}

function zonedTimeToUtc(dateParts, hhmm, timeZone) {
  const [hour, minute] = hhmm.split(":").map(Number);
  const guess = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, hour, minute, 0));
  const offset = timeZoneOffset(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

function timeZoneOffset(date, timeZone) {
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
  const zonedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return zonedAsUtc - date.getTime();
}

function clean(value) {
  return String(value || "").trim().slice(0, 500);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function loadSettings() {
  const saved = await readJson(settingsFile, {});
  return {
    ...defaultSettings,
    ...saved,
    workingHours: saved.workingHours || defaultSettings.workingHours,
    visitTypes: saved.visitTypes || defaultSettings.visitTypes
  };
}

async function listAppointments() {
  if (!env.databaseUrl) return readJson(appointmentsFile, []);
  const result = await query("select data from appointments order by (data->>'start') asc");
  return result.rows.map((row) => row.data);
}

async function saveAppointment(appointment) {
  if (!env.databaseUrl) {
    const appointments = await readJson(appointmentsFile, []);
    appointments.push(appointment);
    await writeJson(appointmentsFile, appointments);
    return;
  }

  await query("insert into appointments (id, data) values ($1, $2::jsonb)", [appointment.id, JSON.stringify(appointment)]);
}

async function updateAppointmentRecord(appointment) {
  if (!env.databaseUrl) {
    const appointments = await readJson(appointmentsFile, []);
    await writeJson(appointmentsFile, appointments.map((item) => item.id === appointment.id ? appointment : item));
    return;
  }

  await query("update appointments set data = $1::jsonb, updated_at = now() where id = $2", [JSON.stringify(appointment), appointment.id]);
}

async function removeAppointment(id) {
  if (!env.databaseUrl) {
    const appointments = await readJson(appointmentsFile, []);
    await writeJson(appointmentsFile, appointments.filter((item) => item.id !== id));
    return;
  }

  await query("delete from appointments where id = $1", [id]);
}

async function ensureDatabase() {
  await query(`
    create table if not exists appointments (
      id text primary key,
      data jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await query(`
    create table if not exists app_state (
      key text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
}

async function readGoogleToken() {
  if (!env.databaseUrl) return readJson(tokenFile, null);

  const result = await query("select data from app_state where key = $1", ["google_token"]);
  return result.rows[0]?.data || null;
}

async function saveGoogleToken(token) {
  if (!env.databaseUrl) {
    await writeJson(tokenFile, token);
    return;
  }

  await query(`
    insert into app_state (key, data)
    values ($1, $2::jsonb)
    on conflict (key)
    do update set data = excluded.data, updated_at = now()
  `, ["google_token", JSON.stringify(token)]);
}

async function query(text, params = []) {
  if (!dbPool) {
    const { Pool } = await import("pg");
    dbPool = new Pool({
      connectionString: env.databaseUrl,
      ssl: { rejectUnauthorized: false }
    });
  }

  return dbPool.query(text, params);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, message) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Scheduler</title><body style="font-family:system-ui;padding:40px;line-height:1.5">${message}</body>`);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}
