const sendForm = document.querySelector("#send-form");
const verifyForm = document.querySelector("#verify-form");
const phoneInput = document.querySelector("#phone-number");
const codeInput = document.querySelector("#otp-code");
const sendButton = document.querySelector("#send-button");
const verifyButton = document.querySelector("#verify-button");
const notice = document.querySelector("#notice");
const modeBanner = document.querySelector("#mode-banner");
const demoCodePanel = document.querySelector("#demo-code-panel");
const demoCode = document.querySelector("#demo-code");
const turnstileWidget = document.querySelector("#turnstile-widget");
const modeBadge = document.querySelector("#mode-badge");
const modeMessage = document.querySelector("#mode-message");
const sendStep = document.querySelector("#send-step");
const verifyStep = document.querySelector("#verify-step");

let demoMode = false;
let turnstileToken = "";
let widgetId;

function showNotice(message, type = "info") {
  notice.textContent = message;
  notice.className = `alert notice${type === "success" ? " alert-success" : type === "error" ? " alert-danger" : ""}`;
  notice.hidden = false;
}

function showVerifyStep() {
  sendStep.classList.remove("is-current");
  sendStep.classList.add("is-complete");
  sendStep.removeAttribute("aria-current");
  verifyStep.classList.add("is-current");
  verifyStep.setAttribute("aria-current", "step");
}

function normalizePhoneNumber(value) {
  const cleaned = value.replace(/[\s()-]/g, "");
  if (cleaned.startsWith("+62")) return cleaned;
  if (cleaned.startsWith("62")) return `+${cleaned}`;
  if (cleaned.startsWith("0")) return `+62${cleaned.slice(1)}`;
  return `+62${cleaned}`;
}

async function postJson(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Permintaan gagal.");
  return result;
}

function setupTurnstile(siteKey) {
  if (!siteKey) {
    sendButton.disabled = true;
    showNotice("Turnstile belum dikonfigurasi. Untuk mencoba tanpa SMS, jalankan mode demo lokal.", "error");
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
        showNotice("Turnstile gagal dimuat. Muat ulang halaman dan coba lagi.", "error");
      },
    });
  };
  script.onerror = () => {
    sendButton.disabled = true;
    showNotice("Turnstile gagal dimuat. Periksa koneksi lalu muat ulang halaman.", "error");
  };
  document.head.append(script);
}

async function initialize() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Konfigurasi halaman gagal dimuat.");
    const config = await response.json();
    demoMode = config.demoMode === true;

    if (demoMode) {
      modeBadge.textContent = "Demo";
      modeMessage.textContent = "SMS tidak dikirim. Kode uji tampil di halaman.";
      modeBanner.hidden = false;
      turnstileWidget.hidden = true;
      sendButton.disabled = false;
    } else {
      modeBadge.textContent = "SMS";
      modeBadge.className = "badge badge-warning";
      modeMessage.textContent = "Kode dikirim melalui SMS. Biaya provider dapat berlaku.";
      modeBanner.hidden = false;
      sendButton.disabled = true;
      setupTurnstile(config.turnstileSiteKey);
    }
  } catch (error) {
    sendButton.disabled = true;
    showNotice(error.message, "error");
  }
}

sendForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  sendButton.disabled = true;
  showNotice("Memproses permintaan OTP...");

  try {
    const payload = { phoneNumber: normalizePhoneNumber(phoneInput.value) };
    if (!demoMode) payload.turnstileToken = turnstileToken;
    const result = await postJson("/api/otp/send", payload);

    verifyForm.hidden = false;
    showVerifyStep();
    codeInput.focus();
    if (demoMode && result.demoCode) {
      demoCode.textContent = result.demoCode;
      demoCodePanel.hidden = false;
      sendButton.disabled = false;
      showNotice("Kode demo siap. Tidak ada SMS yang dikirim.", "success");
    } else {
      demoCodePanel.hidden = true;
      showNotice("Permintaan diterima. Periksa SMS di nomor tujuan.", "success");
      if (window.turnstile && widgetId !== undefined) {
        window.turnstile.reset(widgetId);
        turnstileToken = "";
        sendButton.disabled = true;
      }
    }
  } catch (error) {
    showNotice(error.message, "error");
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
  showNotice("Memeriksa kode...");

  try {
    const result = await postJson("/api/otp/verify", {
      phoneNumber: normalizePhoneNumber(phoneInput.value),
      code: codeInput.value.trim(),
    });
    if (result.verified) {
      showNotice("Nomor berhasil diverifikasi.", "success");
      verifyForm.hidden = true;
      demoCodePanel.hidden = true;
    }
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    verifyButton.disabled = false;
  }
});

initialize();
