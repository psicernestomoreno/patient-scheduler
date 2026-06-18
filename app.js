const state = {
  settings: null,
  appointments: [],
  slots: [],
  selectedSlot: null,
  rescheduleAppointment: null,
  language: safeStorageGet("schedulerLanguage") || "en"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
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
    phone: "Phone",
    reason: "Reason for visit",
    bookButton: "Book appointment",
    availableTimes: "Available times",
    selectTime: "Select one appointment time before booking.",
    noTimes: "No available times are open right now.",
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
    phone: "Teléfono",
    reason: "Motivo de la cita",
    bookButton: "Reservar cita",
    availableTimes: "Horarios disponibles",
    selectTime: "Selecciona un horario antes de reservar.",
    noTimes: "No hay horarios disponibles por ahora.",
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
    state.settings = await api("/api/settings");
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
  $("#bookingForm").addEventListener("submit", submitBooking);
  updatePartnerField();
  await loadSlots();
}

async function loadSlots() {
  state.selectedSlot = null;
  const visitType = $("#visitType").value;
  state.slots = await api(`/api/slots?visitType=${encodeURIComponent(visitType)}`);
  const grid = $("#slotGrid");
  grid.innerHTML = "";

  if (!state.slots.length) {
    grid.innerHTML = `<p class="empty">${escapeHtml(t("noTimes"))}</p>`;
    return;
  }

  for (const slot of state.slots) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slot secondary";
    button.textContent = formatDate(slot.start);
    button.addEventListener("click", () => {
      state.selectedSlot = slot.start;
      $$(".slot").forEach((item) => item.classList.remove("selected"));
      button.classList.add("selected");
    });
    grid.append(button);
  }
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
  payload.phone = `${payload.phoneCountry || ""} ${payload.phone || ""}`.trim();
  delete payload.phoneCountry;

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
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function formatDate(value) {
  return new Date(value).toLocaleString(state.language === "es" ? "es-MX" : "en-US", {
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
  loadSlots();
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
  const language = params.get("lang") || state.language;
  return language === "es" ? "es" : "en";
}

function t(key) {
  return translations[state.language][key] || translations.en[key] || key;
}

function visitName(id) {
  return translations[state.language].visitNames[id] || translations.en.visitNames[id] || id;
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
