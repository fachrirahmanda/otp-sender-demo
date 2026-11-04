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

let authorization = "";

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
      authorization = "";
      dashboard.hidden = true;
      loginCard.hidden = false;
      showNotice(loginNotice, "Sesi berakhir atau kredensial tidak valid. Silakan masuk kembali.", "error");
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
    loginCard.hidden = true;
    dashboard.hidden = false;
    await loadHistory();
  } catch (error) {
    showNotice(loginNotice, error.message, "error");
  } finally {
    loginButton.disabled = false;
  }
});

refreshButton.addEventListener("click", loadHistory);

logoutButton.addEventListener("click", () => {
  authorization = "";
  historyRows.replaceChildren();
  dashboard.hidden = true;
  loginCard.hidden = false;
  loginForm.reset();
  loginNotice.hidden = true;
});
