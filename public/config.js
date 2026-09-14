const schedulerFunctionPath = "/functions/v1/scheduler";
const schedulerIsFunctionUrl = window.location.pathname.startsWith(schedulerFunctionPath);
const schedulerIsGithubPages = window.location.hostname.endsWith("github.io") && window.location.pathname.startsWith("/patient-scheduler");

window.SCHEDULER_APP_BASE = schedulerIsFunctionUrl
  ? schedulerFunctionPath
  : schedulerIsGithubPages
    ? "/patient-scheduler"
    : "";
window.SCHEDULER_API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? ""
  : schedulerIsFunctionUrl
    ? `${window.location.origin}${schedulerFunctionPath}`
    : "https://jqhvndttyqailhxmxfbq.supabase.co/functions/v1/scheduler";
