(() => {
  "use strict";

  const CANVAS_SELECTOR = 'canvas[role="img"]';
  const DONE_ATTR       = "data-qr-replaced";

  const syncStore  = chrome?.storage?.sync;
  const localStore = chrome?.storage?.local;

  const DEFAULT_IMAGE_URL = CONFIG.defaultImageUrl;
  const DEFAULT_TOGGLE    = CONFIG.defaultToggleMode;

  const replacedCanvases = new Map();
  let enabled         = DEFAULT_TOGGLE;
  let currentImageUrl = DEFAULT_IMAGE_URL;
  let observer        = null;

  // Helper: Forces browser to fetch a fresh copy from the server
  function getFreshUrl(url) {
    if (!url || url.startsWith("data:")) return url;
    return url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
  }

  /* ---------- Replace / restore ---------- */
  function replaceCanvas(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) return;
    if (!canvas.isConnected) return;
    if (canvas.hasAttribute(DONE_ATTR)) return;
    canvas.setAttribute(DONE_ATTR, "1");

    const img = document.createElement("img");
    img.src = getFreshUrl(currentImageUrl); // <--- Uses fresh URL
    img.decoding = "async";
    img.alt = canvas.getAttribute("aria-label") || "";
    img.style.cssText = canvas.style.cssText;
    img.style.objectFit = "contain";

    for (const { name, value } of Array.from(canvas.attributes)) {
      if (["width", "height", "role", "style", DONE_ATTR].includes(name)) continue;
      img.setAttribute(name, value);
    }

    replacedCanvases.set(img, canvas);
    canvas.replaceWith(img);
  }

  function applyReplacement() {
    document.querySelectorAll(CANVAS_SELECTOR).forEach(replaceCanvas);
  }

  function restoreAll() {
    for (const [img, canvas] of replacedCanvases) {
      if (img.isConnected) img.replaceWith(canvas);
      canvas.removeAttribute(DONE_ATTR);
    }
    replacedCanvases.clear();
  }

  function updateAllImages(url) {
    currentImageUrl = url || DEFAULT_IMAGE_URL;
    for (const img of replacedCanvases.keys()) {
      if (img.isConnected) img.src = getFreshUrl(currentImageUrl); // <--- Uses fresh URL
    }
  }

  /* ---------- Capture ---------- */
  function findCanvas() {
    const canvases = Array.from(document.querySelectorAll(CANVAS_SELECTOR));
    if (!canvases.length) return null;
    canvases.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return canvases[0];
  }

  function captureCanvas() {
    if (enabled) throw new Error("Disable replacement first");
    const canvas = findCanvas();
    if (!canvas) throw new Error("No canvas[role='img'] found on page");

    const out = document.createElement("canvas");
    out.width  = canvas.width  || 512;
    out.height = canvas.height || 512;
    const ctx = out.getContext("2d");
    try {
      ctx.drawImage(canvas, 0, 0);
    } catch (e) {
      throw new Error("Canvas is tainted / cross-origin and cannot be read");
    }
    return out.toDataURL("image/png");
  }

  /* ---------- Observer ---------- */
  function scanSubtree(root) {
    if (!(root instanceof Element)) return;
    if (root instanceof HTMLCanvasElement && root.matches(CANVAS_SELECTOR)) {
      replaceCanvas(root);
    }
    root.querySelectorAll?.(CANVAS_SELECTOR).forEach(replaceCanvas);
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      for (const m of mutations) {
        if (m.type !== "childList") continue;
        for (const n of m.addedNodes) {
          if (n instanceof Element) scanSubtree(n);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  /* ---------- Enable / disable ---------- */
  function applyEnabled(state) {
    enabled = !!state;
    if (enabled) {
      applyReplacement();
      startObserver();
    } else {
      stopObserver();
      restoreAll();
    }
  }

  /* ---------- Init ---------- */
  function loadInitialState() {
    try {
      chrome.storage.sync.get({ qrEnabled: DEFAULT_TOGGLE }, ({ qrEnabled }) => {
        chrome.storage.local.get({ qrImageDataUrl: null }, ({ qrImageDataUrl }) => {
          currentImageUrl = qrImageDataUrl || DEFAULT_IMAGE_URL;
          applyEnabled(qrEnabled);
        });
      });
    } catch {
      applyEnabled(DEFAULT_TOGGLE);
    }
  }
  loadInitialState();

  /* ---------- Messages ---------- */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "qr:setEnabled") {
      applyEnabled(!!msg.enabled);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "qr:imageChanged") {
      updateAllImages(msg.url || DEFAULT_IMAGE_URL);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "qr:captureCanvas") {
      try {
        const dataUrl = captureCanvas();
        sendResponse({ ok: true, dataUrl });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }
  });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "sync" && "qrEnabled" in changes) {
      applyEnabled(!!changes.qrEnabled.newValue);
    }
    if (area === "local" && "qrImageDataUrl" in changes) {
      updateAllImages(changes.qrImageDataUrl.newValue || DEFAULT_IMAGE_URL);
    }
  });
})();