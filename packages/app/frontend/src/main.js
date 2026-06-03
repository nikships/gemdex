import "./styles.css";

/**
 * Gemdex Memory — management UI.
 *
 * Talks to the Node sidecar (`gemdex serve`) over localhost HTTP. The Zig shell
 * spawns the sidecar and exposes its base URL through the `gemdex.getApiBase`
 * bridge command. In a browser/dev context without the bridge, we fall back to
 * same-origin (the Vite dev proxy) or a dev default.
 */

const els = {
  app: document.querySelector("#app"),
  setup: document.querySelector("#setup"),
  setupForm: document.querySelector("#setup-form"),
  apiKeyInput: document.querySelector("#api-key-input"),
  apiKeySave: document.querySelector("#api-key-save"),
  setupError: document.querySelector("#setup-error"),
  status: document.querySelector("#status"),
  list: document.querySelector("#memory-list"),
  empty: document.querySelector("#empty"),
  filter: document.querySelector("#filter"),
  placeholder: document.querySelector("#placeholder"),
  editor: document.querySelector("#editor"),
  title: document.querySelector("#title-input"),
  content: document.querySelector("#content-input"),
  meta: document.querySelector("#meta"),
  saveBtn: document.querySelector("#save-btn"),
  deleteBtn: document.querySelector("#delete-btn"),
  newBtn: document.querySelector("#new-btn"),
  exportBtn: document.querySelector("#export-btn"),
  importBtn: document.querySelector("#import-btn"),
  importFile: document.querySelector("#import-file"),
  attachBtn: document.querySelector("#attach-btn"),
  attachInput: document.querySelector("#attach-input"),
  attachList: document.querySelector("#attachment-list"),
  attachError: document.querySelector("#attach-error"),
  dropzone: document.querySelector("#dropzone"),
  dropzoneHint: document.querySelector("#dropzone-hint"),
  similarPanel: document.querySelector("#similar-panel"),
  similarTitle: document.querySelector("#similar-title"),
  similarList: document.querySelector("#similar-list"),
  similarEmpty: document.querySelector("#similar-empty"),
  similarClose: document.querySelector("#similar-close"),
};

// Mirror of packages/core/src/memory/attachment-validator.ts so the UI gives
// instant feedback; the sidecar remains the source of truth on save.
const MIME_TO_KIND = {
  "image/png": "image",
  "image/jpeg": "image",
  "audio/mp3": "audio",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/wave": "audio",
  "video/mp4": "video",
  "video/quicktime": "video",
  "application/pdf": "pdf",
};
const KIND_CAPS = { image: 6, audio: 1, video: 1, pdf: 1 };
const MAX_BYTES_PER_ATTACHMENT = 20 * 1024 * 1024;

let apiBase = "";
let memories = [];
let selectedId = null; // null while editing/creating a brand-new memory

// Working set of attachments for the open editor. Each item is either:
//   { source: "existing", id, kind, mimeType, byteLength, caption, url }
//   { source: "new", file, kind, mimeType, byteLength, caption, url }
// `url` is a renderable source: the sidecar blob route for existing items, an
// object URL for freshly added files (revoked on reset to avoid leaks).
let editorAttachments = [];
// Signature of the attachments as loaded for the current memory, used to decide
// whether an update must re-send the full set (the PUT replaces all media).
let loadedAttachmentSig = "";

async function resolveApiBase() {
  // Prefer the base URL handed to us by the native shell.
  if (window.zero && typeof window.zero.invoke === "function") {
    try {
      const res = await window.zero.invoke("gemdex.getApiBase", {});
      if (res && typeof res.base === "string" && res.base.length > 0) {
        return res.base;
      }
    } catch (err) {
      console.warn("getApiBase bridge failed:", err);
    }
  }
  // Dev / browser fallback: assume a sidecar on the conventional dev port,
  // else same origin.
  return "";
}

async function api(path, options = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch (_) {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const body = await api("/health");
      if (body && body.ok) return true;
    } catch (_) {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function fmtDate(ms) {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString();
  } catch (_) {
    return "";
  }
}

function kindFromMime(mimeType) {
  return MIME_TO_KIND[(mimeType || "").toLowerCase()];
}

function humanSize(bytes) {
  if (!bytes || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/** Absolute URL the WebView can use to fetch one attachment's raw bytes. */
function attachmentUrl(memoryId, attachmentId) {
  return `${apiBase}/memories/${encodeURIComponent(memoryId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** Read a File into base64 (no data: prefix), for create/update payloads. */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** Fetch an existing attachment's bytes and base64-encode them. */
async function fetchAttachmentBase64(memoryId, attachmentId) {
  const res = await fetch(attachmentUrl(memoryId, attachmentId));
  if (!res.ok) throw new Error(`Could not read attachment ${attachmentId}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary);
}

/** A stable signature of the editor attachment set, to detect edits. */
function attachmentSignature(items) {
  return items
    .map((a) => `${a.source}:${a.source === "existing" ? a.id : a.file.name}:${a.caption || ""}`)
    .join("|");
}

/** Revoke object URLs for freshly-added files so the WebView doesn't leak. */
function releaseNewObjectUrls() {
  for (const a of editorAttachments) {
    if (a.source === "new" && a.url) URL.revokeObjectURL(a.url);
  }
}

function renderList() {
  const filter = els.filter.value.trim().toLowerCase();
  const visible = memories.filter(
    (m) => !filter || (m.title || "").toLowerCase().includes(filter),
  );
  els.list.innerHTML = "";
  els.empty.hidden = memories.length !== 0;

  for (const m of visible) {
    const li = document.createElement("li");
    li.className = "memory-item" + (m.id === selectedId ? " active" : "");
    li.dataset.id = m.id;
    li.innerHTML = `
      <div class="item-title"></div>
      <div class="item-preview"></div>
      <div class="item-date"></div>
    `;
    li.querySelector(".item-title").textContent = m.title || "Untitled memory";
    li.querySelector(".item-preview").textContent = m.preview || "";
    const dateEl = li.querySelector(".item-date");
    dateEl.textContent = fmtDate(m.updatedAt);
    const attachments = m.attachments || [];
    if (attachments.length > 0) {
      const chip = document.createElement("span");
      chip.className = "item-chip";
      chip.textContent = `📎 ${attachments.length}`;
      dateEl.appendChild(chip);
    }
    li.addEventListener("click", () => openMemory(m.id));
    els.list.appendChild(li);
  }
}

async function refreshList() {
  const body = await api("/memories");
  memories = body.memories || [];
  renderList();
}

function showEditor() {
  els.placeholder.hidden = true;
  els.editor.hidden = false;
}

function openNew() {
  selectedId = null;
  els.title.value = "";
  els.content.value = "";
  els.meta.textContent = "New memory";
  els.deleteBtn.hidden = true;
  setEditorAttachments([]);
  hideSimilar();
  showEditor();
  renderList();
  els.content.focus();
}

async function openMemory(id) {
  try {
    const body = await api(`/memories/${encodeURIComponent(id)}`);
    const m = body.memory;
    selectedId = m.id;
    els.title.value = m.title || "";
    els.content.value = m.content || "";
    els.meta.textContent = `Created ${fmtDate(m.createdAt)} · Updated ${fmtDate(m.updatedAt)}`;
    els.deleteBtn.hidden = false;
    const existing = (m.attachments || []).map((a) => ({
      source: "existing",
      id: a.id,
      kind: a.kind || kindFromMime(a.mimeType),
      mimeType: a.mimeType,
      byteLength: a.byteLength,
      caption: a.caption || "",
      url: attachmentUrl(m.id, a.id),
    }));
    setEditorAttachments(existing);
    loadedAttachmentSig = attachmentSignature(existing);
    hideSimilar();
    showEditor();
    renderList();
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
}

/** Replace the editor attachment set, releasing prior object URLs first. */
function setEditorAttachments(items) {
  releaseNewObjectUrls();
  editorAttachments = items;
  if (!selectedId) loadedAttachmentSig = "";
  clearAttachError();
  renderAttachments();
}

function clearAttachError() {
  els.attachError.hidden = true;
  els.attachError.textContent = "";
}

function showAttachError(message) {
  els.attachError.textContent = message;
  els.attachError.hidden = false;
}

/** Validate + add picked/dropped files to the editor set (client pre-check). */
function addFiles(fileList) {
  clearAttachError();
  const counts = { image: 0, audio: 0, video: 0, pdf: 0 };
  for (const a of editorAttachments) counts[a.kind] = (counts[a.kind] || 0) + 1;

  for (const file of Array.from(fileList)) {
    const kind = kindFromMime(file.type);
    if (!kind) {
      showAttachError(`Unsupported file type: ${file.name} (${file.type || "unknown"}).`);
      continue;
    }
    if (file.size > MAX_BYTES_PER_ATTACHMENT) {
      showAttachError(`${file.name} is ${humanSize(file.size)}; the limit is ${humanSize(MAX_BYTES_PER_ATTACHMENT)}.`);
      continue;
    }
    if ((counts[kind] || 0) + 1 > KIND_CAPS[kind]) {
      showAttachError(`Too many ${kind} attachments (max ${KIND_CAPS[kind]}).`);
      continue;
    }
    counts[kind] = (counts[kind] || 0) + 1;
    editorAttachments.push({
      source: "new",
      file,
      kind,
      mimeType: file.type,
      byteLength: file.size,
      caption: "",
      url: URL.createObjectURL(file),
    });
  }
  renderAttachments();
}

function removeAttachment(index) {
  const item = editorAttachments[index];
  if (item && item.source === "new" && item.url) URL.revokeObjectURL(item.url);
  editorAttachments.splice(index, 1);
  clearAttachError();
  renderAttachments();
}

/** Render one media preview node for a given kind + source URL. */
function renderMediaPreview(item) {
  if (item.kind === "image") {
    const img = document.createElement("img");
    img.className = "att-media att-image";
    img.src = item.url;
    img.alt = item.caption || "image attachment";
    return img;
  }
  if (item.kind === "audio") {
    const audio = document.createElement("audio");
    audio.className = "att-media att-audio";
    audio.controls = true;
    audio.src = item.url;
    return audio;
  }
  if (item.kind === "video") {
    const video = document.createElement("video");
    video.className = "att-media att-video";
    video.controls = true;
    video.src = item.url;
    return video;
  }
  // pdf — WKWebView renders PDF natively in an iframe (no extra dependency).
  const frame = document.createElement("iframe");
  frame.className = "att-media att-pdf";
  frame.src = item.url;
  frame.title = item.caption || "PDF attachment";
  return frame;
}

function renderAttachments() {
  els.attachList.innerHTML = "";
  els.dropzoneHint.hidden = editorAttachments.length > 0;

  editorAttachments.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "att-card";

    const preview = document.createElement("div");
    preview.className = "att-preview";
    preview.appendChild(renderMediaPreview(item));
    li.appendChild(preview);

    const body = document.createElement("div");
    body.className = "att-body";

    const meta = document.createElement("div");
    meta.className = "att-meta";
    const name = item.source === "new" ? item.file.name : `${item.kind} attachment`;
    meta.textContent = `${name} · ${humanSize(item.byteLength)}`;
    body.appendChild(meta);

    const caption = document.createElement("input");
    caption.className = "att-caption";
    caption.type = "text";
    caption.placeholder = "Caption (helps recall)";
    caption.value = item.caption || "";
    caption.addEventListener("input", () => {
      item.caption = caption.value;
    });
    body.appendChild(caption);

    const actions = document.createElement("div");
    actions.className = "att-actions";
    if (item.source === "existing") {
      const similarBtn = document.createElement("button");
      similarBtn.type = "button";
      similarBtn.className = "ghost";
      similarBtn.textContent = "Find similar";
      similarBtn.addEventListener("click", () => findSimilar(item));
      actions.appendChild(similarBtn);
    }
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ghost danger-text";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeAttachment(index));
    actions.appendChild(removeBtn);
    body.appendChild(actions);

    li.appendChild(body);
    els.attachList.appendChild(li);
  });
}

/**
 * Build the attachments payload for save. Returns undefined when the set is
 * unchanged on an update (the backend then preserves the existing media);
 * otherwise returns the full desired set as inline base64 — re-fetching kept
 * bytes, since PUT replaces all attachments.
 */
async function buildAttachmentsPayload(isUpdate) {
  if (isUpdate && attachmentSignature(editorAttachments) === loadedAttachmentSig) {
    return undefined;
  }
  if (editorAttachments.length === 0) {
    // On update, an explicit empty array clears media; on create, send nothing.
    return isUpdate ? [] : undefined;
  }
  const payload = [];
  for (const item of editorAttachments) {
    const caption = (item.caption || "").trim() || undefined;
    if (item.source === "new") {
      payload.push({ mimeType: item.mimeType, data: await fileToBase64(item.file), ...(caption && { caption }) });
    } else {
      payload.push({
        mimeType: item.mimeType,
        data: await fetchAttachmentBase64(selectedId, item.id),
        ...(caption && { caption }),
      });
    }
  }
  return payload;
}

async function saveCurrent(event) {
  event.preventDefault();
  const content = els.content.value;
  const title = els.title.value.trim();
  if (content.trim().length === 0 && editorAttachments.length === 0) {
    setStatus("Add content or at least one attachment.", true);
    return;
  }
  els.saveBtn.disabled = true;
  try {
    const isUpdate = Boolean(selectedId);
    const attachments = await buildAttachmentsPayload(isUpdate);
    if (isUpdate) {
      await api(`/memories/${encodeURIComponent(selectedId)}`, {
        method: "PUT",
        body: JSON.stringify({ content, title: title || undefined, ...(attachments !== undefined && { attachments }) }),
      });
    } else {
      const body = await api("/memories", {
        method: "POST",
        body: JSON.stringify({ content, title: title || undefined, ...(attachments !== undefined && { attachments }) }),
      });
      selectedId = body.memory.id;
    }
    await refreshList();
    await openMemory(selectedId);
    setStatus("Saved.");
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  } finally {
    els.saveBtn.disabled = false;
  }
}

/** Recall-by-example: find memories similar to an existing attachment's bytes. */
async function findSimilar(item) {
  if (item.source !== "existing" || !selectedId) return;
  els.similarPanel.hidden = false;
  els.similarList.innerHTML = "";
  els.similarEmpty.hidden = true;
  els.similarTitle.textContent = "Finding similar memories…";
  try {
    const data = await fetchAttachmentBase64(selectedId, item.id);
    const body = await api("/recall", {
      method: "POST",
      body: JSON.stringify({ attachments: [{ mimeType: item.mimeType, data }], limit: 10 }),
    });
    const results = (body.results || []).filter((r) => r.id !== selectedId);
    els.similarTitle.textContent = "Similar memories";
    els.similarEmpty.hidden = results.length > 0;
    for (const r of results) {
      const li = document.createElement("li");
      li.className = "similar-item";
      const titleEl = document.createElement("div");
      titleEl.className = "similar-item-title";
      titleEl.textContent = r.title || "Untitled memory";
      const scoreEl = document.createElement("span");
      scoreEl.className = "similar-item-score";
      scoreEl.textContent = typeof r.score === "number" ? r.score.toFixed(3) : "";
      titleEl.appendChild(scoreEl);
      li.appendChild(titleEl);
      li.addEventListener("click", () => {
        hideSimilar();
        openMemory(r.id);
      });
      els.similarList.appendChild(li);
    }
  } catch (err) {
    els.similarTitle.textContent = "Similar memories";
    setStatus(`Find similar failed: ${err.message}`, true);
  }
}

function hideSimilar() {
  els.similarPanel.hidden = true;
  els.similarList.innerHTML = "";
}

async function deleteCurrent() {
  if (!selectedId) return;
  if (!confirm("Delete this memory? This cannot be undone.")) return;
  try {
    await api(`/memories/${encodeURIComponent(selectedId)}`, { method: "DELETE" });
    selectedId = null;
    els.editor.hidden = true;
    els.placeholder.hidden = false;
    await refreshList();
    setStatus("Deleted.");
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
}

async function exportAll() {
  try {
    const body = await api("/export");
    const records = body.records || [];
    const jsonl = records.map((r) => JSON.stringify(r)).join("\n");
    const blob = new Blob([jsonl], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gemdex-memories-${new Date().toISOString().slice(0, 10)}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${records.length} memories.`);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
}

function parseImport(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  // Accept either a JSON array or JSONL (one record per line).
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function importFile(file) {
  try {
    const text = await file.text();
    const records = parseImport(text);
    const body = await api("/import", {
      method: "POST",
      body: JSON.stringify({ records }),
    });
    await refreshList();
    setStatus(`Imported ${body.imported} memories.`);
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, true);
  }
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

function wireEvents() {
  els.newBtn.addEventListener("click", openNew);
  els.editor.addEventListener("submit", saveCurrent);
  els.deleteBtn.addEventListener("click", deleteCurrent);
  els.exportBtn.addEventListener("click", exportAll);
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importFile(file);
    e.target.value = "";
  });
  els.filter.addEventListener("input", renderList);

  // Attachments: picker + drag-drop.
  els.attachBtn.addEventListener("click", () => els.attachInput.click());
  els.attachInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
    e.target.value = "";
  });
  els.dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragover");
  });
  els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("dragover"));
  els.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("dragover");
    if (e.dataTransfer && e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  });
  els.similarClose.addEventListener("click", hideSimilar);
}

function showSetup(show) {
  els.setup.hidden = !show;
  els.app.hidden = show;
  if (show) els.apiKeyInput.focus();
}

async function isConfigured() {
  const body = await api("/config");
  return Boolean(body && body.configured);
}

async function submitApiKey(event) {
  event.preventDefault();
  const apiKey = els.apiKeyInput.value.trim();
  if (apiKey.length === 0) return;
  els.apiKeySave.disabled = true;
  els.setupError.hidden = true;
  try {
    const body = await api("/config", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    });
    if (!body || !body.configured) throw new Error("Key was not accepted.");
    els.apiKeyInput.value = "";
    showSetup(false);
    await loadMemories();
  } catch (err) {
    els.setupError.textContent = err.message;
    els.setupError.hidden = false;
  } finally {
    els.apiKeySave.disabled = false;
  }
}

async function loadMemories() {
  try {
    await refreshList();
    setStatus(`${memories.length} ${memories.length === 1 ? "memory" : "memories"}`);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
}

async function init() {
  wireEvents();
  els.setupForm.addEventListener("submit", submitApiKey);
  apiBase = await resolveApiBase();
  setStatus("waiting for memory store…");
  const healthy = await waitForHealth();
  if (!healthy) {
    setStatus("Could not reach the memory store sidecar.", true);
    return;
  }
  if (await isConfigured()) {
    showSetup(false);
    await loadMemories();
  } else {
    setStatus("API key required");
    showSetup(true);
  }
}

init();
