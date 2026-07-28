const state = {
  settings: null,
  appointments: [],
  slots: [],
  selectedSlot: null,
  rescheduleAppointment: null,
  weekOffset: 0,
  language: safeStorageGet("schedulerLanguage") || "es"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const availableDaysPerPage = 7;
const maxNextClicks = 2;
const translations = {
  en: {
    bookingTitle: "Choose a time that works for your visit.",
    bookingIntro: "Select an available time and share the details needed to confirm your appointment.",
    detailsTitle: "Your details",
    detailsIntro: "The clinic will use this information to confirm your appointment.",
    visitType: "Visit type",
    fullName: "Full name",
    partnerName: "Partner's name",
    email: "Email",
    phone: "WhatsApp number",
    whatsappContact: "Message me on WhatsApp",
    reason: "Reason for visit",
    bookButton: "Book appointment",
    availableTimes: "Available times",
    previousWeek: "Previous",
    nextWeek: "Next",
    loadingTimes: "Loading available times...",
    available: "Available",
    unavailable: "Unavailable",
    selectTime: "Select one appointment time before booking.",
    noTimes: "No available times are open right now.",
    timesError: "Google Calendar could not be checked right now. Please refresh the page or message me on WhatsApp to schedule.",
    chooseTime: "Choose an appointment time first.",
    bookingError: "Could not book that appointment.",
    thanks: "Thank you.",
    thanksNamed: "Thank you, {name}.",
    thanksIntro: "Your appointment has been booked. Please save the date and contact the office if you need to make a change.",
    dateTime: "Date and time",
    officeLocation: "Office location",
    openMap: "Open in Google Maps",
    selectedTime: "Your selected time",
    appointment: "Appointment",
    bookAnother: "Book another appointment",
    visitNames: {
      individual: "Individual Therapy",
      couples: "Couples Therapy",
      family: "Family Therapy"
    }
  },
  es: {
    bookingTitle: "Elige el horario que mejor funcione para tu cita.",
    bookingIntro: "Selecciona un horario disponible y comparte los datos necesarios para confirmar tu cita.",
    detailsTitle: "Tus datos",
    detailsIntro: "El consultorio usará esta información para confirmar tu cita.",
    visitType: "Tipo de terapia",
    fullName: "Nombre completo",
    partnerName: "Nombre de tu pareja",
    email: "Correo electrónico",
    phone: "Número de WhatsApp",
    whatsappContact: "Envíame un mensaje por WhatsApp",
    reason: "Motivo de la cita",
    bookButton: "Reservar cita",
    availableTimes: "Horarios disponibles",
    previousWeek: "Anterior",
    nextWeek: "Siguiente",
    loadingTimes: "Cargando horarios disponibles...",
    available: "Disponible",
    unavailable: "No disponible",
    selectTime: "Selecciona un horario antes de reservar.",
    noTimes: "No hay horarios disponibles por ahora.",
    timesError: "No se pudo revisar Google Calendar en este momento. Por favor actualiza la página o escríbeme por WhatsApp para agendar.",
    chooseTime: "Elige un horario primero.",
    bookingError: "No se pudo reservar esa cita.",
    thanks: "Gracias.",
    thanksNamed: "Gracias, {name}.",
    thanksIntro: "Tu cita ha sido reservada. Guarda la fecha y contacta al consultorio si necesitas hacer un cambio.",
    dateTime: "Fecha y hora",
    officeLocation: "Ubicación del consultorio",
    openMap: "Abrir en Google Maps",
    selectedTime: "Tu horario seleccionado",
    appointment: "Cita",
    bookAnother: "Reservar otra cita",
    visitNames: {
      individual: "Terapia individual",
      couples: "Terapia de pareja",
      family: "Terapia familiar"
    }
  }
};

document.addEventListener("DOMContentLoaded", async () => {
  const page = document.body.dataset.page;
  if (page === "dashboard") await loadDashboard();
  if (page === "booking") await loadBooking();
  if (page === "thanks") await loadThanks();
});

async function loadDashboard() {
  state.settings = await api("/api/settings");
  state.appointments = await api("/api/appointments");

  $("#clinicName").textContent = state.settings.clinicName;
  $("#patientLink").textContent = state.settings.patientLink;
  $("#openBooking").href = state.settings.patientLink;
  $("#googleStatus").textContent = state.settings.googleConnected ? "Connected" : "Not connected";
  $("#googleStatus").className = state.settings.googleConnected ? "pill" : "pill warning";

  const upcoming = state.appointments
    .filter((item) => new Date(item.start) >= new Date())
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  $("#activeCount").textContent = upcoming.length;
  $("#upcomingCount").textContent = upcoming.length;
  $("#todayCount").textContent = upcoming.filter(isToday).length;

  const list = $("#appointmentList");
  list.innerHTML = "";
  if (!upcoming.length) {
    list.innerHTML = `<p class="empty">No upcoming appointments yet.</p>`;
  }

  for (const appointment of upcoming) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="card-header">
        <div>
          <h3>${escapeHtml(appointment.patientName)}</h3>
          <p class="meta">${formatDate(appointment.start)} · ${escapeHtml(appointment.visitName)}</p>
        </div>
        <span class="pill">${appointment.status}</span>
      </div>
      ${appointment.partnerName ? `<p class="meta">Partner: ${escapeHtml(appointment.partnerName)}</p>` : ""}
      <p>${escapeHtml(appointment.reason || "No visit note added.")}</p>
      <p class="meta">${escapeHtml(appointment.phone)} · ${escapeHtml(appointment.email)}</p>
      <div class="actions appointment-actions">
        <button class="secondary" type="button" data-action="reschedule">Reschedule</button>
        <button class="secondary danger" type="button" data-action="delete">Delete</button>
      </div>
    `;
    card.querySelector('[data-action="reschedule"]').addEventListener("click", () => openRescheduleModal(appointment));
    card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteAppointment(appointment));
    list.append(card);
  }

  $("#copyLink").onclick = async () => {
    await navigator.clipboard.writeText(state.settings.patientLink);
    toast("Booking link copied.");
  };
  setupRescheduleModal();

  await loadCalendarEvents();
}

function setupRescheduleModal() {
  $("#closeReschedule").onclick = closeRescheduleModal;
  $("#cancelReschedule").onclick = closeRescheduleModal;
  $("#saveReschedule").onclick = saveReschedule;
}

async function openRescheduleModal(appointment) {
  state.rescheduleAppointment = appointment;
  $("#reschedulePatient").textContent = `${appointment.patientName} · ${appointment.visitName}`;
  const select = $("#rescheduleSlot");
  select.innerHTML = `<option>Loading available times...</option>`;
  $("#rescheduleModal").hidden = false;

  try {
    const slots = await api(`/api/slots?visitType=${encodeURIComponent(appointment.visitType)}`);
    select.innerHTML = "";

    if (!slots.length) {
      select.innerHTML = `<option value="">No available times</option>`;
      return;
    }

    for (const slot of slots) {
      const option = document.createElement("option");
      option.value = slot.start;
      option.textContent = formatDate(slot.start);
      select.append(option);
    }
  } catch (error) {
    select.innerHTML = `<option value="">Could not load times</option>`;
  }
}

function closeRescheduleModal() {
  $("#rescheduleModal").hidden = true;
  state.rescheduleAppointment = null;
}

async function saveReschedule() {
  const appointment = state.rescheduleAppointment;
  const start = $("#rescheduleSlot").value;

  if (!appointment || !start) {
    toast("Choose a new appointment time.");
    return;
  }

  try {
    await api(`/api/appointments/${encodeURIComponent(appointment.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ start })
    });
    closeRescheduleModal();
    toast("Appointment rescheduled.");
    await loadDashboard();
  } catch (error) {
    toast(error.message || "Could not reschedule that appointment.");
  }
}

async function deleteAppointment(appointment) {
  const confirmed = window.confirm(`Delete appointment for ${appointment.patientName} on ${formatDate(appointment.start)}?`);
  if (!confirmed) return;

  try {
    await api(`/api/appointments/${encodeURIComponent(appointment.id)}`, { method: "DELETE" });
    toast("Appointment deleted.");
    await loadDashboard();
  } catch (error) {
    toast(error.message || "Could not delete that appointment.");
  }
}

async function loadCalendarEvents() {
  const list = $("#calendarList");
  if (!list) return;

  try {
    const calendar = await api("/api/calendar-events");
    list.innerHTML = "";

    if (!calendar.connected) {
      list.innerHTML = `<p class="empty">Connect Google Calendar to see your upcoming calendar events here.</p>`;
      return;
    }

    if (calendar.error) {
      list.innerHTML = `<p class="empty">${escapeHtml(calendar.error)}</p>`;
      return;
    }

    if (!calendar.events.length) {
      list.innerHTML = `<p class="empty">No upcoming Google Calendar events in the next two weeks.</p>`;
      return;
    }

    for (const event of calendar.events) {
      const item = document.createElement("article");
      item.className = "calendar-event";
      item.innerHTML = `
        <div>
          <strong>${escapeHtml(event.title)}</strong>
          <span>${escapeHtml(formatDate(event.start))}${event.location ? ` · ${escapeHtml(event.location)}` : ""}</span>
        </div>
        ${event.htmlLink ? `<a href="${escapeHtml(event.htmlLink)}" target="_blank" rel="noreferrer">Open</a>` : ""}
      `;
      list.append(item);
    }
  } catch (error) {
    list.innerHTML = `<p class="empty">Google Calendar events could not be loaded.</p>`;
  }
}

async function loadBooking() {
  try {
    state.settings = await api(noCacheUrl("/api/settings"));
  } catch (error) {
    state.settings = fallbackSettings();
    toast("Could not load live settings. Showing default options.");
  }

  state.language = getLanguageFromUrl();
  $("#clinicNameInline").textContent = state.settings.clinicName;

  const visitType = $("#visitType");
  renderVisitTypes(visitType);
  setupLanguageButtons();
  applyLanguage();
  visitType.addEventListener("change", loadSlots);
  visitType.addEventListener("change", updatePartnerField);
  $("#previousWeek").addEventListener("click", () => changeWeek(-1));
  $("#nextWeek").addEventListener("click", () => changeWeek(1));
  $("#previousWeekBottom").addEventListener("click", () => changeWeek(-1));
  $("#nextWeekBottom").addEventListener("click", () => changeWeek(1));
  $("#bookingForm").addEventListener("submit", submitBooking);
  updatePartnerField();
  await loadSlots();
}

async function loadSlots() {
  state.selectedSlot = null;
  state.weekOffset = 0;
  updateBookingSubmitState();
  await loadWeekSlots();
}

async function loadWeekSlots() {
  const visitType = $("#visitType").value;
  const today = zonedDate(new Date());
  const daysToCheck = Number(state.settings.bookingWindowDays || 60);
  $("#slotGrid").innerHTML = `<p class="empty">${escapeHtml(t("loadingTimes"))}</p>`;
  try {
    state.slots = await api(noCacheUrl(`/api/slots?visitType=${encodeURIComponent(visitType)}&from=${encodeURIComponent(localDateKey(today))}&days=${encodeURIComponent(daysToCheck)}&includeUnavailable=1`));
    renderSlotCalendar();
  } catch (error) {
    console.error(error);
    state.slots = [];
    $("#slotGrid").innerHTML = `<p class="empty">${escapeHtml(t("timesError"))}</p>`;
  }
}

function renderSlotCalendar() {
  const grid = $("#slotGrid");
  try {
    grid.innerHTML = "";
    $("#previousWeek").textContent = t("previousWeek");
    $("#nextWeek").textContent = t("nextWeek");
    $("#previousWeekBottom").textContent = t("previousWeek");
    $("#nextWeekBottom").textContent = t("nextWeek");

    const availableDays = availableDayKeys(state.slots);
    const pageCount = Math.max(Math.ceil(availableDays.length / availableDaysPerPage), 1);
    const lastVisiblePage = Math.min(pageCount - 1, maxNextClicks);
    state.weekOffset = Math.min(state.weekOffset, lastVisiblePage);
    const pageDayKeys = availableDays.slice(
      state.weekOffset * availableDaysPerPage,
      (state.weekOffset + 1) * availableDaysPerPage
    );
    const days = pageDayKeys.map((key) => ({ date: dateFromLocalKey(key), key }));

    $("#previousWeek").disabled = state.weekOffset === 0;
    $("#previousWeekBottom").disabled = state.weekOffset === 0;
    $("#nextWeek").disabled = state.weekOffset >= lastVisiblePage;
    $("#nextWeekBottom").disabled = state.weekOffset >= lastVisiblePage;

    if (!days.length) {
      grid.innerHTML = `<p class="empty">${escapeHtml(t("noTimes"))}</p>`;
      $("#weekLabel").textContent = "";
      return;
    }

    $("#weekLabel").textContent = `${formatDayHeading(days[0].date)} - ${formatDayHeading(days[days.length - 1].date)}`;

    for (const day of days) {
      const column = document.createElement("section");
      column.className = "calendar-day";
      column.innerHTML = `
        <div class="calendar-day-header">
          <strong>${escapeHtml(formatWeekday(day.date))}</strong>
          <span>${escapeHtml(formatMonthDay(day.date))}</span>
        </div>
        <div class="calendar-day-slots"></div>
      `;
      const slotList = column.querySelector(".calendar-day-slots");
      const daySlots = state.slots.filter((slot) => dayKey(slot.start) === day.key);

      for (const slot of daySlots) {
        if (slot.available === false) {
          const unavailable = document.createElement("div");
          unavailable.className = "slot slot-unavailable";
          unavailable.innerHTML = `<span>${escapeHtml(formatTime(slot.start))}</span><strong>${escapeHtml(t("unavailable"))}</strong>`;
          slotList.append(unavailable);
        } else {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "slot secondary";
          button.classList.toggle("selected", slot.start === state.selectedSlot);
          button.innerHTML = `<span>${escapeHtml(formatTime(slot.start))}</span><strong>${escapeHtml(t("available"))}</strong>`;
          button.addEventListener("click", () => {
            state.selectedSlot = slot.start;
            $$(".slot").forEach((item) => item.classList.remove("selected"));
            button.classList.add("selected");
            updateBookingSubmitState();
          });
          slotList.append(button);
        }
      }

      grid.append(column);
    }
  } catch (error) {
    console.error(error);
    grid.innerHTML = `<p class="empty">${escapeHtml(t("timesError"))}</p>`;
  }
}

async function changeWeek(direction) {
  const pageCount = Math.max(Math.ceil(availableDayKeys(state.slots).length / availableDaysPerPage), 1);
  const lastVisiblePage = Math.min(pageCount - 1, maxNextClicks);
  state.weekOffset = Math.min(lastVisiblePage, Math.max(0, state.weekOffset + direction));
  state.selectedSlot = null;
  updateBookingSubmitState();
  renderSlotCalendar();
}

function updateBookingSubmitState() {
  const button = $("#bookingSubmit");
  if (button) button.disabled = !state.selectedSlot;
}

async function submitBooking(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  if (!state.selectedSlot) {
    toast(t("chooseTime"));
    return;
  }

  const form = new FormData(formElement);
  const payload = Object.fromEntries(form.entries());
  payload.start = state.selectedSlot;
  payload.language = state.language;
  payload.phone = `${payload.phoneCountry || ""} ${payload.phone || ""}`.trim();
  delete payload.phoneCountry;
  const submitButton = $("#bookingSubmit");
  submitButton.disabled = true;

  try {
    const booking = await api("/api/bookings", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const params = new URLSearchParams({
      time: booking.start,
      visitType: booking.visitType,
      name: booking.patientName,
      lang: state.language
    });
    window.location.href = `/thanks.html?${params}`;
  } catch (error) {
    updateBookingSubmitState();
    toast(error.message || t("bookingError"));
  }
}

async function loadThanks() {
  state.settings = await api("/api/settings");
  const params = new URLSearchParams(window.location.search);
  state.language = getLanguageFromUrl();
  const time = params.get("time");
  const visitType = params.get("visitType");
  const name = params.get("name") || "";

  applyLanguage();
  $("#thanksClinicName").textContent = state.settings.clinicName;
  $("#thanksTitle").textContent = name ? t("thanksNamed").replace("{name}", name) : t("thanks");
  $("#thanksVisit").textContent = visitType ? visitName(visitType) : t("appointment");
  $("#thanksTime").textContent = time ? formatDate(time) : t("selectedTime");
  $("#bookAnother").href = `/book.html?lang=${state.language}`;
  renderOfficeMap();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function noCacheUrl(path) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}_=${Date.now()}`;
}

function formatDate(value) {
  if (!hasDateFormatting()) return fallbackDateTime(value);
  return new Date(value).toLocaleString(state.language === "es" ? "es-MX" : "en-US", {
    timeZone: appTimeZone(),
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function setupLanguageButtons() {
  $("#englishButton").addEventListener("click", () => setLanguage("en"));
  $("#spanishButton").addEventListener("click", () => setLanguage("es"));
}

function setLanguage(language) {
  state.language = language;
  safeStorageSet("schedulerLanguage", language);
  const url = new URL(window.location.href);
  url.searchParams.set("lang", language);
  window.history.replaceState({}, "", url);
  renderVisitTypes($("#visitType"));
  applyLanguage();
  updatePartnerField();
  renderSlotCalendar();
}

function applyLanguage() {
  document.documentElement.lang = state.language;
  $$("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });

  const englishButton = $("#englishButton");
  const spanishButton = $("#spanishButton");
  if (englishButton && spanishButton) {
    englishButton.classList.toggle("active", state.language === "en");
    spanishButton.classList.toggle("active", state.language === "es");
  }

  const whatsappContact = $("#whatsappContact");
  if (whatsappContact) {
    const message = state.language === "es"
      ? "Hola, tengo una pregunta sobre cómo agendar una cita."
      : "Hello, I have a question about scheduling an appointment.";
    whatsappContact.href = `https://wa.me/16195122735?text=${encodeURIComponent(message)}`;
  }
}

function renderVisitTypes(select) {
  const selected = select.value;
  select.innerHTML = state.settings.visitTypes.map((type) => (
    `<option value="${type.id}">${escapeHtml(visitName(type.id))} · ${type.minutes} min</option>`
  )).join("");
  if (selected) select.value = selected;
}

function getLanguageFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const language = params.get("lang") || "es";
  return language === "es" ? "es" : "en";
}

function t(key) {
  return translations[state.language][key] || translations.en[key] || key;
}

function visitName(id) {
  return translations[state.language].visitNames[id] || translations.en.visitNames[id] || id;
}

function weekDays(offset) {
  const base = zonedDate(new Date());
  const currentWeekStart = addCalendarDays(base, -base.getUTCDay());
  const start = offset === 0 ? base : addCalendarDays(currentWeekStart, offset * 7);
  const dayCount = offset === 0 ? 7 - base.getUTCDay() : 7;
  return Array.from({ length: dayCount }, (_, index) => {
    const date = addCalendarDays(start, index);
    return { date, key: localDateKey(date) };
  });
}

function availableDayKeys(slots) {
  return [...new Set(slots
    .filter((slot) => slot.available !== false)
    .map((slot) => dayKey(slot.start)))]
    .sort();
}

function dateFromLocalKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function zonedDate(value) {
  if (!hasDateFormatting()) return fallbackZonedDate(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: appTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
}

function addCalendarDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function localDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function dayKey(value) {
  return localDateKey(zonedDate(new Date(value)));
}

function formatWeekday(date) {
  if (!hasDateFormatting()) return fallbackWeekday(date);
  return date.toLocaleDateString(state.language === "es" ? "es-MX" : "en-US", {
    timeZone: "UTC",
    weekday: "short"
  });
}

function formatMonthDay(date) {
  if (!hasDateFormatting()) return fallbackMonthDay(date);
  return date.toLocaleDateString(state.language === "es" ? "es-MX" : "en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric"
  });
}

function formatDayHeading(date) {
  if (!hasDateFormatting()) return fallbackMonthDay(date);
  return date.toLocaleDateString(state.language === "es" ? "es-MX" : "en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric"
  });
}

function formatTime(value) {
  if (!hasDateFormatting()) return fallbackTime(value);
  return new Date(value).toLocaleTimeString(state.language === "es" ? "es-MX" : "en-US", {
    timeZone: appTimeZone(),
    hour: "numeric",
    minute: "2-digit"
  });
}

function appTimeZone() {
  const timezone = state.settings?.timezone || "America/Tijuana";
  if (!hasDateFormatting()) return "America/Los_Angeles";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return "America/Los_Angeles";
  }
}

function hasDateFormatting() {
  return typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function";
}

function fallbackLocalDate(value) {
  const date = new Date(value);
  return new Date(date.getTime() - 7 * 60 * 60 * 1000);
}

function fallbackZonedDate(value) {
  const date = fallbackLocalDate(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function fallbackTime(value) {
  const date = fallbackLocalDate(value);
  const hour = date.getUTCHours();
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${period}`;
}

function fallbackDateTime(value) {
  return `${fallbackWeekday(fallbackZonedDate(value))}, ${fallbackMonthDay(fallbackZonedDate(value))}, ${fallbackTime(value)}`;
}

function fallbackWeekday(date) {
  const names = state.language === "es"
    ? ["dom", "lun", "mar", "mie", "jue", "vie", "sab"]
    : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return names[date.getUTCDay()];
}

function fallbackMonthDay(date) {
  const months = state.language === "es"
    ? ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
    : ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return "";
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function fallbackSettings() {
  return {
    clinicName: "Psicólogo Ernesto Moreno",
    bookingWindowDays: 60,
    visitTypes: [
      { id: "individual", name: "Individual Therapy", minutes: 50 },
      { id: "couples", name: "Couples Therapy", minutes: 50 },
      { id: "family", name: "Family Therapy", minutes: 50 }
    ]
  };
}

function updatePartnerField() {
  const field = $("#partnerNameField");
  const input = $("#partnerNameInput");
  const visitType = $("#visitType");
  if (!field || !input || !visitType) return;

  const showPartner = visitType.value === "couples";
  field.hidden = !showPartner;
  input.required = showPartner;
  if (!showPartner) input.value = "";
}

function renderOfficeMap() {
  const address = state.settings.officeAddress || state.settings.clinicName;
  const mapQuery = state.settings.officeMapQuery || address;
  const query = encodeURIComponent(mapQuery);
  $("#officeAddress").textContent = address;
  $("#officeMap").src = `https://www.google.com/maps?q=${query}&output=embed`;
  $("#openMap").href = `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function isToday(item) {
  const date = new Date(item.start);
  const now = new Date();
  return date.toDateString() === now.toDateString();
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3200);
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
