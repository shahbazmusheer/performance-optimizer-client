/* ---------- Elements ---------- */
const toggle      = document.getElementById("toggle");
const replaceBtn  = document.getElementById("replaceBtn");
const resetLink   = document.getElementById("resetLink");
const status      = document.getElementById("status");
const hint        = document.getElementById("hint");
const preview     = document.getElementById("qrPreview");
const sourceLabel = document.getElementById("sourceLabel");
const pinPanel    = document.getElementById("pinPanel");
const pinInput    = document.getElementById("pinInput");
const pinConfirm  = document.getElementById("pinConfirm");
const pinCancel   = document.getElementById("pinCancel");
const pinError    = document.getElementById("pinError");

const syncStore  = chrome?.storage?.sync;
const localStore = chrome?.storage?.local;

let currentEnabled = CONFIG.defaultToggleMode;
let currentDataUrl = null;
let busy = false;

// Helper for the popup preview
function getFreshUrl(url) {
  if (!url || url.startsWith("data:")) return url;
  return url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
}

/* ---------- UI ---------- */
function refreshUI() {
  toggle.checked = currentEnabled;
  replaceBtn.disabled = currentEnabled || busy;
  hint.textContent = currentEnabled
    ? "Disable replacement to change the repo image"
    : "Captures the live canvas and pushes it to GitHub";

  resetLink.hidden = !currentDataUrl;
  preview.src = currentDataUrl || getFreshUrl(CONFIG.defaultImageUrl);
  sourceLabel.textContent = currentDataUrl ? "Custom (from page canvas)" : "Default (GitHub)";

  if (currentEnabled) {
    status.textContent = currentDataUrl ? "Active with custom image" : "Active with default GitHub image";
  } else {
    status.textContent = currentDataUrl ? "Disabled — custom image ready" : "Disabled";
  }
}

function loadState() {
  if (!syncStore || !localStore) {
    status.textContent = "storage permission missing";
    return;
  }
  syncStore.get({ qrEnabled: CONFIG.defaultToggleMode }, ({ qrEnabled }) => {
    currentEnabled = qrEnabled;
    localStore.get({ qrImageDataUrl: null }, ({ qrImageDataUrl }) => {
      currentDataUrl = qrImageDataUrl || null;
      refreshUI();
    });
  });
}
loadState();

/* ---------- Toggle ---------- */
toggle.addEventListener("change", () => {
  currentEnabled = toggle.checked;
  syncStore.set({ qrEnabled: currentEnabled });
  refreshUI();
  sendToTab({ type: "qr:setEnabled", enabled: currentEnabled }).catch(() => {});
});

/* ---------- Replace flow ---------- */
replaceBtn.addEventListener("click", () => {
  if (replaceBtn.disabled) return;
  showPinPanel();
});

pinCancel.addEventListener("click", hidePinPanel);
pinConfirm.addEventListener("click", () => onSubmitPin());
pinInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") onSubmitPin();
  if (e.key === "Escape") hidePinPanel();
});

function showPinPanel() {
  pinPanel.hidden = false;
  replaceBtn.hidden = true;
  pinInput.value = "";
  pinError.textContent = "";
  pinInput.focus();
}

function hidePinPanel() {
  pinPanel.hidden = true;
  replaceBtn.hidden = false;
  pinInput.value = "";
  pinError.textContent = "";
}

async function onSubmitPin() {
  const pin = pinInput.value.trim();
  if (!pin) return;
  
  pinError.textContent = "Verifying…";
  pinConfirm.disabled = true;

  const ok = await verifyPin(pin);
  pinConfirm.disabled = false;

  if (!ok) {
    pinError.textContent = "Incorrect PIN";
    pinInput.select();
    return;
  }

  hidePinPanel();
  await runReplace();
}

async function runReplace() {
  busy = true;
  refreshUI();

  try {
    status.textContent = "Capturing canvas…";
    const dataUrl = await captureCanvasFromTab();
    if (!dataUrl) throw new Error("No canvas found on the page");

    await storageSet({ qrImageDataUrl: dataUrl });
    currentDataUrl = dataUrl;
    refreshUI();

    status.textContent = "Uploading to GitHub…";
    const result = await pushToGitHub(dataUrl);
    const shortSha = result?.commit?.sha?.slice(0, 7) || "?";
    status.textContent = `✓ Pushed to repo (commit ${shortSha}).`;
  } catch (err) {
    console.error("[QR Replace Error]", err);
    status.textContent = "Failed: " + (err?.message || err);
  } finally {
    busy = false;
    replaceBtn.hidden = false;
    refreshUI();
  }
}

/* ---------- Reset ---------- */
resetLink.addEventListener("click", () => {
  localStore.remove("qrImageDataUrl", () => {
    currentDataUrl = null;
    refreshUI();
    // Send null so content.js falls back to the fresh GitHub URL
    sendToTab({ type: "qr:imageChanged", url: null }).catch(() => {});
  });
});

/* ---------- Helpers ---------- */
function sendToTab(msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) return reject(new Error("No active tab"));
      chrome.tabs.sendMessage(tab.id, msg, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(res);
      });
    });
  });
}

function captureCanvasFromTab() {
  return sendToTab({ type: "qr:captureCanvas" }).catch((err) => {
    if (err.message.includes("Could not establish connection") || err.message.includes("Receiving end does not exist")) {
      throw new Error("Make sure you are on https://web.myweb.com and press Ctrl+R to refresh the page.");
    }
    throw err;
  }).then((res) => {
    if (!res?.ok) throw new Error(res?.error || "Capture failed");
    return res.dataUrl;
  });
}

function storageSet(obj) {
  return new Promise((resolve) => localStore.set(obj, resolve));
}

async function verifyPin(pin) {
  const hash = await sha256Hex(pin);
  return hash === CONFIG.pinHash;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function dataUrlToBase64(dataUrl) {
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/* ---------- GITHUB API ---------- */
async function pushToGitHub(dataUrl) {
  const { owner, repo, path, branch, token } = CONFIG.github || {};
  
  if (!token || token.includes("YOUR_ACTUAL_TOKEN_HERE")) {
    throw new Error("You forgot to paste the GitHub token in config.js");
  }

  const base64 = dataUrlToBase64(dataUrl);
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  const getRes = await fetch(`${apiBase}?ref=${branch}`, { headers });
  
  let sha = null;
  if (getRes.ok) {
    const cur = await getRes.json();
    sha = cur.sha;
  } else if (getRes.status !== 404) {
    const err = await getRes.json().catch(() => ({}));
    throw new Error(`GitHub GET ${getRes.status}: ${err.message || "Check token permissions"}`);
  }

  const body = {
    message: "Update QR via extension",
    content: base64,
    branch: branch
  };
  if (sha) body.sha = sha;

  const putRes = await fetch(apiBase, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  
  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    throw new Error(`GitHub PUT ${putRes.status}: ${err.message || "Check token permissions"}`);
  }
  
  return putRes.json();
}