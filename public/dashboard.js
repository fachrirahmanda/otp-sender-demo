const authLayout = document.querySelector("#auth-layout");
const loginCard = document.querySelector("#login-card");
const loginForm = document.querySelector("#login-form");
const loginButton = document.querySelector("#login-button");
const loginNotice = document.querySelector("#login-notice");
const dashboard = document.querySelector("#dashboard");
const dashboardNotice = document.querySelector("#dashboard-notice");
const historyRows = document.querySelector("#history-rows");
const emptyState = document.querySelector("#empty-state");
const refreshButton = document.querySelector("#refresh-button");
const logoutButton = document.querySelector("#logout-button");
const sendForm = document.querySelector("#send-form");
const verifyForm = document.querySelector("#verify-form");
const phoneInput = document.querySelector("#phone-number");
const codeInput = document.querySelector("#otp-code");
const sendButton = document.querySelector("#send-button");
const verifyButton = document.querySelector("#verify-button");
const otpNotice = document.querySelector("#otp-notice");
const modeBanner = document.querySelector("#mode-banner");
const demoCodePanel = document.querySelector("#demo-code-panel");
const demoCode = document.querySelector("#demo-code");
const turnstileWidget = document.querySelector("#turnstile-widget");
const modeBadge = document.querySelector("#mode-badge");
const modeMessage = document.querySelector("#mode-message");
const sendStep = document.querySelector("#send-step");
const verifyStep = document.querySelector("#verify-step");

let authorization = "";
let demoMode = false;
let turnstileToken = "";
let widgetId;
let otpInitialized = false;

function showNotice(element, message, type = "info") {
  element.textContent = message;
  element.className = `alert notice${type === "success" ? " alert-success" : type === "error" ? " alert-danger" : ""}`;
  element.hidden = false;
}

function encodeCredentials(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function showOtpNotice(message, type = "info") {
  showNotice(otpNotice, message, type);
}

function showVerifyStep() {
  sendStep.classList.remove("is-current");
  sendStep.classList.add("is-complete");
  sendStep.removeAttribute("aria-current");
  verifyStep.classList.add("is-current");
  verifyStep.setAttribute("aria-current", "step");
}

function resetSteps() {
  sendStep.classList.remove("is-complete");
  sendStep.classList.add("is-current");
  sendStep.setAttribute("aria-current", "step");
  verifyStep.classList.remove("is-current");
  verifyStep.removeAttribute("aria-current");
}

function normalizePhoneNumber(value) {
  const cleaned = value.replace(/[\s()-]/g, "");
  if (cleaned.startsWith("+62")) return cleaned;
  if (cleaned.startsWith("62")) return `+${cleaned}`;
  if (cleaned.startsWith("0")) return `+62${cleaned.slice(1)}`;
  return `+62${cleaned}`;
}

function handleUnauthorized() {
  authorization = "";
  history.replaceState(null, "", "/login");
  dashboard.hidden = true;
  authLayout.hidden = false;
  loginCard.hidden = false;
  showNotice(loginNotice, "Sesi berakhir atau kredensial tidak valid. Silakan masuk kembali.", "error");
}

async function postAuthorizedJson(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (response.status === 401) {
    handleUnauthorized();
    return null;
  }
  if (!response.ok) throw new Error(result.error || "Permintaan gagal.");
  return result;
}

function setupTurnstile(siteKey) {
  if (!siteKey) {
    sendButton.disabled = true;
    showOtpNotice("Turnstile belum dikonfigurasi. Pengiriman OTP dinonaktifkan.", "error");
    return;
  }

  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.defer = true;
  script.onload = () => {
    widgetId = window.turnstile.render(turnstileWidget, {
      sitekey: siteKey,
      callback: (token) => {
        turnstileToken = token;
        sendButton.disabled = false;
      },
      "expired-callback": () => {
        turnstileToken = "";
        sendButton.disabled = true;
      },
      "error-callback": () => {
        turnstileToken = "";
        sendButton.disabled = true;
        showOtpNotice("Turnstile gagal dimuat. Muat ulang halaman dan coba lagi.", "error");
      },
    });
  };
  script.onerror = () => {
    sendButton.disabled = true;
    showOtpNotice("Turnstile gagal dimuat. Periksa koneksi lalu muat ulang halaman.", "error");
  };
  document.head.append(script);
}

async function initializeOtp() {
  if (otpInitialized) return;
  const response = await fetch("/api/config", { cache: "no-store" });
  if (!response.ok) throw new Error("Konfigurasi OTP gagal dimuat.");
  const config = await response.json();
  demoMode = config.demoMode === true;

  modeBadge.textContent = demoMode ? "Demo" : "SMS";
  modeBadge.className = `badge ${demoMode ? "badge-info" : "badge-warning"}`;
  modeMessage.textContent = demoMode
    ? "SMS tidak dikirim. Kode uji akan tampil di dashboard."
    : "Kode dikirim melalui SMS. Biaya provider dapat berlaku.";
  modeBanner.hidden = false;
  document.querySelector("#sidebar-mode-title").textContent = demoMode ? "Mode demo" : "Mode SMS";
  document.querySelector("#sidebar-mode-copy").textContent = demoMode ? "SMS tidak dikirim" : "Provider aktif";
  document.querySelector("#topbar-status-text").textContent = demoMode ? "Demo aktif" : "SMS aktif";

  if (demoMode) {
    turnstileWidget.hidden = true;
    sendButton.disabled = false;
  } else {
    sendButton.disabled = true;
    setupTurnstile(config.turnstileSiteKey);
  }
  otpInitialized = true;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function statusLabel(status) {
  const labels = {
    sending: ["Sedang diproses", "badge-warning"],
    accepted: ["Diterima provider", "badge-success"],
    failed: ["Gagal", "badge-danger"],
    demo: ["Demo (tanpa SMS)", "badge-info"],
  };
  return labels[status] || ["Tidak diketahui", "pending"];
}

async function loadHistory() {
  refreshButton.disabled = true;
  dashboardNotice.hidden = true;
  try {
    const response = await fetch("/api/dashboard/sends", {
      headers: { authorization: authorization },
      cache: "no-store",
    });
    const result = await response.json();
    if (response.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!response.ok) throw new Error(result.error || "Riwayat tidak dapat dimuat.");

    const sends = Array.isArray(result.sends) ? result.sends : [];
    document.querySelector("#total-count").textContent = String(sends.length);
    document.querySelector("#accepted-count").textContent = String(
      sends.filter((send) => send.status === "accepted").length,
    );
    document.querySelector("#failed-count").textContent = String(
      sends.filter((send) => send.status === "failed").length,
    );

    historyRows.replaceChildren();
    emptyState.hidden = sends.length > 0;
    for (const send of sends) {
      const row = document.createElement("tr");
      const phoneCell = document.createElement("td");
      const timeCell = document.createElement("td");
      const statusCell = document.createElement("td");
      const statusBadge = document.createElement("span");
      const [label, className] = statusLabel(send.status);

      phoneCell.dataset.label = "Nomor";
      timeCell.dataset.label = "Waktu";
      statusCell.dataset.label = "Status";
      phoneCell.textContent = send.phoneNumber;
      timeCell.textContent = formatTime(send.createdAt);
      statusBadge.className = `badge status-badge ${className}`;
      statusBadge.textContent = label;
      statusCell.append(statusBadge);
      row.append(phoneCell, timeCell, statusCell);
      historyRows.append(row);
    }
  } catch (error) {
    showNotice(dashboardNotice, error.message, "error");
  } finally {
    refreshButton.disabled = false;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  loginNotice.hidden = true;
  const formData = new FormData(loginForm);
  authorization = encodeCredentials(formData.get("username"), formData.get("password"));
  try {
    const response = await fetch("/api/dashboard/sends", {
      headers: { authorization },
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok) {
      authorization = "";
      throw new Error(result.error || "Login gagal.");
    }
    loginForm.reset();
    history.replaceState(null, "", "/dashboard");
    authLayout.hidden = true;
    loginCard.hidden = true;
    dashboard.hidden = false;
    try {
      await initializeOtp();
    } catch (error) {
      showNotice(dashboardNotice, error.message, "error");
    }
    await loadHistory();
  } catch (error) {
    showNotice(loginNotice, error.message, "error");
  } finally {
    loginButton.disabled = false;
  }
});

sendForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  sendButton.disabled = true;
  showOtpNotice("Memproses permintaan OTP...");

  try {
    const payload = { phoneNumber: normalizePhoneNumber(phoneInput.value) };
    if (!demoMode) payload.turnstileToken = turnstileToken;
    const result = await postAuthorizedJson("/api/otp/send", payload);
    if (!result) return;

    verifyForm.hidden = false;
    showVerifyStep();
    codeInput.focus();
    if (demoMode && result.demoCode) {
      demoCode.textContent = result.demoCode;
      demoCodePanel.hidden = false;
      sendButton.disabled = false;
      showOtpNotice("Kode demo siap. Tidak ada SMS yang dikirim.", "success");
    } else {
      demoCodePanel.hidden = true;
      showOtpNotice("Permintaan diterima. Periksa SMS di nomor tujuan.", "success");
      if (window.turnstile && widgetId !== undefined) {
        window.turnstile.reset(widgetId);
        turnstileToken = "";
        sendButton.disabled = true;
      }
    }
    await loadHistory();
  } catch (error) {
    showOtpNotice(error.message, "error");
    if (demoMode) {
      sendButton.disabled = false;
    } else if (window.turnstile && widgetId !== undefined) {
      window.turnstile.reset(widgetId);
      turnstileToken = "";
      sendButton.disabled = true;
    }
  }
});

verifyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  verifyButton.disabled = true;
  showOtpNotice("Memeriksa kode...");

  try {
    const result = await postAuthorizedJson("/api/otp/verify", {
      phoneNumber: normalizePhoneNumber(phoneInput.value),
      code: codeInput.value.trim(),
    });
    if (!result) return;
    if (result.verified) {
      showOtpNotice("Nomor berhasil diverifikasi.", "success");
      verifyForm.hidden = true;
      demoCodePanel.hidden = true;
      codeInput.value = "";
      resetSteps();
    }
  } catch (error) {
    showOtpNotice(error.message, "error");
  } finally {
    verifyButton.disabled = false;
  }
});

refreshButton.addEventListener("click", loadHistory);

logoutButton.addEventListener("click", () => {
  authorization = "";
  history.replaceState(null, "", "/login");
  historyRows.replaceChildren();
  dashboard.hidden = true;
  authLayout.hidden = false;
  loginCard.hidden = false;
  loginForm.reset();
  loginNotice.hidden = true;
  sendForm.reset();
  verifyForm.reset();
  verifyForm.hidden = true;
  demoCodePanel.hidden = true;
  otpNotice.hidden = true;
  resetSteps();
  if (!demoMode && window.turnstile && widgetId !== undefined) {
    window.turnstile.reset(widgetId);
    turnstileToken = "";
    sendButton.disabled = true;
  }
});
