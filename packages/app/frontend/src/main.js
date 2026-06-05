import "./styles.css";
import {
  KIND_CAPS,
  MAX_BYTES_PER_ATTACHMENT,
  attachmentSignature,
  captionPatchFromAttachments,
  classifyAttachmentChange,
  humanSize,
  kindFromMime,
} from "./attachments.js";
import {
  backendSwitchConfirmation,
  connectionStatus,
  migrationStatus,
  remoteOptionLabel,
  shouldConfirmBackendSwitch,
} from "./settings.js";

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
  setupSettingsBtn: document.querySelector("#setup-settings-btn"),
  setupError: document.querySelector("#setup-error"),
  status: document.querySelector("#status"),
  backendBadge: document.querySelector("#backend-badge"),
  list: document.querySelector("#memory-list"),
  empty: document.querySelector("#empty"),
  filter: document.querySelector("#filter"),
  recoveryPanel: document.querySelector("#recovery-panel"),
  recoveryTitle: document.querySelector("#recovery-title"),
  recoveryMessage: document.querySelector("#recovery-message"),
  recoveryBootstrap: document.querySelector("#recovery-bootstrap"),
  recoverySettings: document.querySelector("#recovery-settings"),
  recoveryLocal: document.querySelector("#recovery-local"),
  recoveryRetry: document.querySelector("#recovery-retry"),
  recoveryProgress: document.querySelector("#recovery-progress"),
  recoveryProgressText: document.querySelector("#recovery-progress-text"),
  placeholder: document.querySelector("#placeholder"),
  editor: document.querySelector("#editor"),
  title: document.querySelector("#title-input"),
  content: document.querySelector("#content-input"),
  meta: document.querySelector("#meta"),
  saveBtn: document.querySelector("#save-btn"),
  deleteBtn: document.querySelector("#delete-btn"),
  newBtn: document.querySelector("#new-btn"),
  settingsBtn: document.querySelector("#settings-btn"),
  exportBtn: document.querySelector("#export-btn"),
  importBtn: document.querySelector("#import-btn"),
  importFile: document.querySelector("#import-file"),
  attachBtn: document.querySelector("#attach-btn"),
  attachInput: document.querySelector("#attach-input"),
  attachList: document.querySelector("#attachment-list"),
  attachProgress: document.querySelector("#attach-progress"),
  attachError: document.querySelector("#attach-error"),
  dropzone: document.querySelector("#dropzone"),
  dropzoneHint: document.querySelector("#dropzone-hint"),
  similarPanel: document.querySelector("#similar-panel"),
  similarTitle: document.querySelector("#similar-title"),
  similarList: document.querySelector("#similar-list"),
  similarError: document.querySelector("#similar-error"),
  similarEmpty: document.querySelector("#similar-empty"),
  similarClose: document.querySelector("#similar-close"),
  settingsModal: document.querySelector("#settings-modal"),
  settingsClose: document.querySelector("#settings-close"),
  settingsError: document.querySelector("#settings-error"),
  modeLocal: document.querySelector("#mode-local"),
  modeRemote: document.querySelector("#mode-remote"),
  remoteSelect: document.querySelector("#remote-select"),
  remoteUse: document.querySelector("#remote-use"),
  remoteTest: document.querySelector("#remote-test"),
  remoteImport: document.querySelector("#remote-import"),
  remoteRemove: document.querySelector("#remote-remove"),
  remoteStatus: document.querySelector("#remote-status"),
  remoteForm: document.querySelector("#remote-form"),
  remoteName: document.querySelector("#remote-name"),
  remoteUrl: document.querySelector("#remote-url"),
  remoteToken: document.querySelector("#remote-token"),
  remoteSave: document.querySelector("#remote-save"),
  confirmModal: document.querySelector("#confirm-modal"),
  confirmTitle: document.querySelector("#confirm-title"),
  confirmMessage: document.querySelector("#confirm-message"),
  confirmCancel: document.querySelector("#confirm-cancel"),
  confirmOk: document.querySelector("#confirm-ok"),
};

let apiBase = "";
// Per-launch auth token received from the Zig shell via the getApiBase bridge.
// Empty string when running without the desktop shell (dev / standalone).
let apiToken = "";
let memories = [];
let selectedId = null; // null while editing/creating a brand-new memory
let settingsState = null;
let configState = null;

// Working set of attachments for the open editor. Each item is either:
//   { source: "existing", id, kind, mimeType, byteLength, caption, url }
//   { source: "new", file, kind, mimeType, byteLength, caption, url }
// `url` is a renderable source: the sidecar blob route for existing items, an
// object URL for freshly added files (revoked on reset to avoid leaks).
let editorAttachments = [];
// Signature of the attachments as loaded for the current memory, used to decide
// whether an update must re-send the full set (the PUT replaces all media).
let loadedAttachmentSig = "";
let listThumbnailRenderId = 0;
const listThumbnailObjectUrls = new Set();
let settingsOpener = null;
let confirmOpener = null;
let confirmResolver = null;
// Handle for the sidecar status poll loop (null when not polling).
let pollHandle = null;
const POLL_INTERVAL_MS = 700;

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableWithin(root) {
  return Array.from(root.querySelectorAll(focusableSelector))
    .filter((el) => !el.hidden && !el.closest("[hidden]"));
}

function focusFirstIn(root, fallback = root) {
  (focusableWithin(root)[0] ?? fallback).focus();
}

function trapFocus(event, root) {
  if (event.key !== "Tab") return;
  const focusable = focusableWithin(root);
  if (focusable.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!root.contains(document.activeElement)) {
    event.preventDefault();
    if (event.shiftKey) {
      last.focus();
    } else {
      first.focus();
    }
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Whether the native Zig shell's bridge is available (false in dev/browser/tests). */
function hasBridge() {
  return Boolean(window.zero && typeof window.zero.invoke === "function");
}

async function resolveApiBase() {
  // Prefer the base URL handed to us by the native shell.
  if (hasBridge()) {
    try {
      const res = await window.zero.invoke("gemdex.getApiBase", {});
      if (res && typeof res.base === "string" && res.base.length > 0) {
        // Also capture the per-launch auth token if the shell provided one.
        if (typeof res.token === "string" && res.token.length > 0) {
          apiToken = res.token;
        }
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

/**
 * Ask the native shell for the current sidecar lifecycle phase. Returns null
 * when the bridge is unavailable (dev / browser / tests) so callers fall back
 * to the legacy health-poll path.
 */
async function fetchStatus() {
  if (!hasBridge()) return null;
  try {
    const res = await window.zero.invoke("gemdex.getStatus", {});
    if (res && typeof res.phase === "string") return res;
  } catch (err) {
    console.warn("getStatus bridge failed:", err);
  }
  return null;
}

/**
 * Request a UI-approved bootstrap. `install` true permits the one-time network
 * install; false is a cache-only retry. The shell starts the work on a
 * background thread and returns immediately — we then poll fetchStatus().
 */
async function requestBootstrap(install) {
  if (!hasBridge()) return false;
  try {
    const res = await window.zero.invoke("gemdex.bootstrap", { install });
    return Boolean(res?.accepted);
  } catch (err) {
    console.warn("bootstrap bridge failed:", err);
    return false;
  }
}

// Per-launch auth token header for every request. The sidecar requires it on
// all data routes to prevent any other page the user visits from making
// cross-origin requests to the memory store. Empty in dev / standalone mode.
function authHeaders() {
  return apiToken ? { "X-Gemdex-Token": apiToken } : {};
}

async function api(path, options = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers ?? {}) },
    ...options,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
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
      if (body?.ok) return true;
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

/** Absolute URL the WebView can use to fetch one attachment's raw bytes. */
function attachmentUrl(memoryId, attachmentId) {
  return `${apiBase}/memories/${encodeURIComponent(memoryId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** Read a File/Blob into base64 (no data: prefix), for create/update payloads. */
function fileToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result ?? "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(blob);
  });
}

/** Fetch an existing attachment's bytes and base64-encode them. */
async function fetchAttachmentBase64(memoryId, attachmentId) {
  const res = await fetch(attachmentUrl(memoryId, attachmentId), { headers: authHeaders() });
  if (!res.ok) throw new Error(`Could not read attachment ${attachmentId}`);
  // FileReader.readAsDataURL is native + async, so multi-MB blobs don't block
  // the UI thread (a manual String.fromCharCode loop would).
  return fileToBase64(await res.blob());
}

/**
 * Fetch an existing attachment's bytes via an authenticated request and return
 * a blob: object URL. This is used instead of the raw sidecar URL when a token
 * is configured, because the browser cannot add custom headers to media src=
 * attributes; a cross-origin request without the token would be rejected.
 * The caller is responsible for revoking the returned URL when done.
 */
async function fetchAttachmentObjectUrl(memoryId, attachmentId) {
  const res = await fetch(attachmentUrl(memoryId, attachmentId), { headers: authHeaders() });
  if (!res.ok) throw new Error(`Could not read attachment ${attachmentId}`);
  return URL.createObjectURL(await res.blob());
}


/** Revoke object URLs for freshly-added files so the WebView doesn't leak. */
function releaseNewObjectUrls() {
  for (const a of editorAttachments) {
    if (a.source === "new" && a.url) URL.revokeObjectURL(a.url);
    // Also release pre-fetched blob URLs created for existing attachments when
    // a token is active (see fetchAttachmentObjectUrl).
    if (a._blobUrl) URL.revokeObjectURL(a._blobUrl);
  }
}

function releaseListThumbnailObjectUrls() {
  for (const url of listThumbnailObjectUrls) URL.revokeObjectURL(url);
  listThumbnailObjectUrls.clear();
}

function renderList() {
  const filter = els.filter.value.trim().toLowerCase();
  const visible = memories.filter(
    (m) => !filter || (m.title ?? "").toLowerCase().includes(filter),
  );
  listThumbnailRenderId += 1;
  const renderId = listThumbnailRenderId;
  releaseListThumbnailObjectUrls();
  els.list.innerHTML = "";
  els.empty.hidden = memories.length !== 0;

  for (const m of visible) {
    const li = document.createElement("li");
    li.className = "memory-item" + (m.id === selectedId ? " active" : "");
    li.dataset.id = m.id;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "memory-row";
    button.innerHTML = `
      <div class="item-body">
        <div class="item-title"></div>
        <div class="item-preview"></div>
        <div class="item-date"></div>
      </div>
    `;
    button.querySelector(".item-title").textContent = m.title || "Untitled memory";
    button.querySelector(".item-preview").textContent = m.preview ?? "";
    const dateEl = button.querySelector(".item-date");
    dateEl.textContent = fmtDate(m.updatedAt);
    const attachments = m.attachments ?? [];
    if (attachments.length > 0) {
      const chip = document.createElement("span");
      chip.className = "item-chip";
      chip.textContent = `📎 ${attachments.length}`;
      dateEl.appendChild(chip);
    }
    // Show a real thumbnail when the memory has at least one image attachment.
    const image = attachments.find((a) => (a.kind ?? kindFromMime(a.mimeType)) === "image");
    if (image) {
      const thumb = document.createElement("img");
      thumb.className = "item-thumb";
      thumb.loading = "lazy";
      thumb.alt = image.caption || "image attachment";
      thumb.onerror = () => {
        if (thumb.dataset.objectUrl) {
          URL.revokeObjectURL(thumb.dataset.objectUrl);
          listThumbnailObjectUrls.delete(thumb.dataset.objectUrl);
        }
        thumb.remove();
        li.classList.remove("has-thumb");
        button.classList.remove("has-thumb");
      };
      if (apiToken) {
        fetchAttachmentObjectUrl(m.id, image.id).then((url) => {
          if (renderId !== listThumbnailRenderId || !thumb.isConnected) {
            URL.revokeObjectURL(url);
            return;
          }
          listThumbnailObjectUrls.add(url);
          thumb.dataset.objectUrl = url;
          thumb.src = url;
        }).catch(() => {
          thumb.remove();
          li.classList.remove("has-thumb");
          button.classList.remove("has-thumb");
        });
      } else {
        thumb.src = attachmentUrl(m.id, image.id);
      }
      li.classList.add("has-thumb");
      button.classList.add("has-thumb");
      button.insertBefore(thumb, button.firstChild);
    }
    button.addEventListener("click", () => openMemory(m.id));
    li.appendChild(button);
    els.list.appendChild(li);
  }
}

async function refreshList() {
  const body = await api("/memories");
  memories = body.memories ?? [];
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
    els.title.value = m.title ?? "";
    els.content.value = m.content ?? "";
    els.meta.textContent = `Created ${fmtDate(m.createdAt)} · Updated ${fmtDate(m.updatedAt)}`;
    els.deleteBtn.hidden = false;
    // When a token is configured the browser cannot add custom headers to media
    // src= attributes, so we pre-fetch each attachment via an authenticated
    // request and create a blob: object URL for rendering. Without a token we
    // use the sidecar URL directly (dev / standalone mode).
    const existing = await Promise.all(
      (m.attachments ?? []).map(async (a) => {
        const mediaUrl = apiToken
          ? await fetchAttachmentObjectUrl(m.id, a.id)
          : attachmentUrl(m.id, a.id);
        return {
          source: "existing",
          id: a.id,
          kind: a.kind ?? kindFromMime(a.mimeType),
          mimeType: a.mimeType,
          byteLength: a.byteLength,
          caption: a.caption ?? "",
          url: mediaUrl,
          // Track whether this is a blob URL we own so we revoke it correctly.
          _blobUrl: apiToken ? mediaUrl : null,
        };
      }),
    );
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

function setAttachProgress(message = "") {
  els.attachProgress.textContent = message;
  els.attachProgress.hidden = message.length === 0;
}

/** Validate + add picked/dropped files to the editor set (client pre-check). */
function addFiles(fileList) {
  clearAttachError();
  const counts = { image: 0, audio: 0, video: 0, pdf: 0 };
  for (const a of editorAttachments) counts[a.kind] = (counts[a.kind] ?? 0) + 1;

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
    if ((counts[kind] ?? 0) + 1 > KIND_CAPS[kind]) {
      showAttachError(`Too many ${kind} attachments (max ${KIND_CAPS[kind]}).`);
      continue;
    }
    counts[kind] = (counts[kind] ?? 0) + 1;
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
  // Revoke both new-file object URLs and pre-fetched blob URLs for existing
  // attachments (the latter are created by fetchAttachmentObjectUrl when a
  // token is active).
  if (item) {
    if (item.source === "new" && item.url) URL.revokeObjectURL(item.url);
    if (item._blobUrl) URL.revokeObjectURL(item._blobUrl);
  }
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
  // pdf — WKWebView renders PDF natively in an iframe, but some WebKitGTK
  // builds ship without a PDF viewer and render a blank frame. iframe.onload
  // doesn't reliably fire for that case, so we always pair the inline preview
  // with an explicit "open / download" affordance that works regardless of
  // native PDF support.
  const wrap = document.createElement("div");
  wrap.className = "att-pdf-wrap";

  const frame = document.createElement("iframe");
  frame.className = "att-media att-pdf";
  frame.src = item.url;
  frame.title = item.caption || "PDF attachment";
  wrap.appendChild(frame);

  const fallback = document.createElement("div");
  fallback.className = "att-pdf-fallback";

  const label = document.createElement("span");
  label.className = "att-pdf-label";
  label.textContent = "PDF preview not supported here?";
  fallback.appendChild(label);

  const link = document.createElement("a");
  link.className = "att-pdf-open";
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Open / download PDF";
  // Freshly-added files are object URLs, but existing attachments resolve to a
  // stable blob route we can offer as a download.
  if (item.source === "existing") link.download = "";
  fallback.appendChild(link);

  wrap.appendChild(fallback);
  return wrap;
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
 *
 * The caption-only fast path (PATCH /memories/:id/attachments) is handled by
 * `saveCurrent` before this runs; here we only see "none" (→ undefined) and
 * structural changes (→ full re-embed).
 */
async function buildAttachmentsPayload(isUpdate) {
  if (isUpdate && classifyAttachmentChange(editorAttachments, loadedAttachmentSig) === "none") {
    return undefined;
  }
  if (editorAttachments.length === 0) {
    // On update, an explicit empty array clears media; on create, send nothing.
    return isUpdate ? [] : undefined;
  }
  let completed = 0;
  const total = editorAttachments.length;
  setAttachProgress(`Preparing ${total} ${total === 1 ? "attachment" : "attachments"}…`);
  const payload = await mapWithConcurrency(editorAttachments, 2, async (item) => {
    const caption = (item.caption || "").trim() || undefined;
    let entry;
    if (item.source === "new") {
      entry = { mimeType: item.mimeType, data: await fileToBase64(item.file), ...(caption && { caption }) };
    } else {
      entry = {
        mimeType: item.mimeType,
        data: await fetchAttachmentBase64(selectedId, item.id),
        ...(caption && { caption }),
      };
    }
    completed += 1;
    setAttachProgress(`Prepared ${completed} of ${total} ${total === 1 ? "attachment" : "attachments"}…`);
    return entry;
  });
  return payload;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failed) {
      const index = next;
      next += 1;
      try {
        results[index] = await mapper(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  await Promise.all(workers);
  return results;
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
    if (isUpdate && classifyAttachmentChange(editorAttachments, loadedAttachmentSig) === "caption-only") {
      // Only captions on existing attachments changed: update content/title via
      // PUT *without* attachments (so the media isn't re-fetched and re-embedded)
      // and patch the captions in place. openMemory() below refreshes
      // loadedAttachmentSig from the reloaded memory.
      await api(`/memories/${encodeURIComponent(selectedId)}`, {
        method: "PUT",
        body: JSON.stringify({ content, title: title || undefined }),
      });
      await api(`/memories/${encodeURIComponent(selectedId)}/attachments`, {
        method: "PATCH",
        body: JSON.stringify({ captions: captionPatchFromAttachments(editorAttachments) }),
      });
    } else if (isUpdate) {
      const attachments = await buildAttachmentsPayload(true);
      await api(`/memories/${encodeURIComponent(selectedId)}`, {
        method: "PUT",
        body: JSON.stringify({ content, title: title || undefined, ...(attachments !== undefined && { attachments }) }),
      });
    } else {
      const attachments = await buildAttachmentsPayload(false);
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
    setAttachProgress();
  }
}

/** Recall-by-example: find memories similar to an existing attachment's bytes. */
async function findSimilar(item) {
  if (item.source !== "existing" || !selectedId) return;
  els.similarPanel.hidden = false;
  els.similarList.innerHTML = "";
  els.similarError.hidden = true;
  els.similarError.innerHTML = "";
  els.similarEmpty.hidden = true;
  els.similarTitle.textContent = "Finding similar memories…";
  try {
    const data = await fetchAttachmentBase64(selectedId, item.id);
    const body = await api("/recall", {
      method: "POST",
      body: JSON.stringify({ attachments: [{ mimeType: item.mimeType, data }], limit: 10 }),
    });
    const results = (body.results ?? []).filter((r) => r.id !== selectedId);
    els.similarTitle.textContent = "Similar memories";
    els.similarEmpty.hidden = results.length > 0;
    for (const r of results) {
      const li = document.createElement("li");
      li.className = "similar-item";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "similar-row";
      const titleEl = document.createElement("div");
      titleEl.className = "similar-item-title";
      titleEl.textContent = r.title || "Untitled memory";
      const scoreEl = document.createElement("span");
      scoreEl.className = "similar-item-score";
      scoreEl.textContent = typeof r.score === "number" ? r.score.toFixed(3) : "";
      titleEl.appendChild(scoreEl);
      button.appendChild(titleEl);
      button.addEventListener("click", () => {
        hideSimilar();
        openMemory(r.id);
      });
      li.appendChild(button);
      els.similarList.appendChild(li);
    }
  } catch (err) {
    renderSimilarError(err, item);
    setStatus(`Find similar failed: ${err.message}`, true);
  }
}

function renderSimilarError(err, item) {
  const message = err?.message || "Unknown error";
  const likelyRemote = settingsState?.mode === "remote" || /gemdex server|remote|bearer|unauthorized/i.test(message);
  const guidance = likelyRemote
    ? "The active remote could not complete recall. Open Storage settings to test the remote, update its URL or token, then retry."
    : "Recall by example could not complete. Check your storage settings, then retry.";

  els.similarTitle.textContent = "Find similar needs attention";
  els.similarList.innerHTML = "";
  els.similarEmpty.hidden = true;
  els.similarError.innerHTML = "";
  els.similarError.hidden = false;

  const summary = document.createElement("p");
  summary.className = "similar-error-summary";
  summary.textContent = guidance;

  const detail = document.createElement("p");
  detail.className = "similar-error-detail";
  detail.textContent = message;

  const actions = document.createElement("div");
  actions.className = "similar-error-actions";

  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "ghost";
  settingsBtn.textContent = "Open Storage settings";
  settingsBtn.addEventListener("click", openSettings);

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "primary";
  retryBtn.textContent = "Retry";
  retryBtn.addEventListener("click", () => findSimilar(item));

  actions.append(settingsBtn, retryBtn);
  els.similarError.append(summary, detail, actions);
}

function hideSimilar() {
  els.similarPanel.hidden = true;
  els.similarList.innerHTML = "";
  els.similarError.hidden = true;
  els.similarError.innerHTML = "";
}

function confirmAction({
  title = "Confirm action",
  message,
  confirmLabel = "Continue",
  destructive = false,
}) {
  if (confirmResolver) {
    confirmResolver(false);
    confirmResolver = null;
  }
  confirmOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  els.confirmTitle.textContent = title;
  els.confirmMessage.textContent = message;
  els.confirmOk.textContent = confirmLabel;
  els.confirmOk.classList.toggle("danger", destructive);
  els.confirmOk.classList.toggle("primary", !destructive);
  els.confirmModal.hidden = false;
  requestAnimationFrame(() => focusFirstIn(els.confirmModal.querySelector(".confirm-card")));
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function closeConfirm(accepted = false) {
  if (!confirmResolver) return;
  const resolve = confirmResolver;
  confirmResolver = null;
  els.confirmModal.hidden = true;
  resolve(accepted);
  if (confirmOpener?.isConnected) confirmOpener.focus();
  confirmOpener = null;
}

async function deleteCurrent() {
  if (!selectedId) return;
  if (!(await confirmAction({
    title: "Delete memory",
    message: "Delete this memory? This cannot be undone.",
    confirmLabel: "Delete",
    destructive: true,
  }))) return;
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
    const records = body.records ?? [];
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

function updateConfigState(config) {
  configState = config ?? null;
  renderBackendBadge();
  return configState;
}

async function refreshConfigState() {
  return updateConfigState(await api("/config"));
}

function activeBackend() {
  if (!configState) return null;
  return {
    mode: configState.mode,
    configured: Boolean(configState.configured),
    needsKey: Boolean(configState.needsKey),
    activeRemote: configState.activeRemote ?? null,
  };
}

function activeRemoteName() {
  return activeBackend()?.activeRemote?.name ?? "";
}

function renderBackendBadge() {
  const backend = activeBackend();
  if (!backend) {
    els.backendBadge.textContent = "Backend: loading…";
    els.backendBadge.title = "Loading active backend";
    els.backendBadge.classList.remove("local", "remote", "warning");
    return;
  }
  els.backendBadge.classList.toggle("local", backend.mode === "local");
  els.backendBadge.classList.toggle("remote", backend.mode === "remote");
  els.backendBadge.classList.toggle("warning", !backend.configured);
  if (backend.mode === "remote") {
    const remoteName = activeRemoteName() || "remote";
    els.backendBadge.textContent = `Remote: ${remoteName}`;
    els.backendBadge.title = backend.activeRemote?.url
      ? `Active remote backend: ${remoteName} (${backend.activeRemote.url})`
      : `Active remote backend: ${remoteName}`;
    return;
  }
  els.backendBadge.textContent = backend.needsKey ? "Local: needs API key" : "Local backend";
  els.backendBadge.title = backend.needsKey
    ? "Local backend selected; API key required"
    : "Active local backend";
}

function clearRecovery() {
  els.recoveryPanel.hidden = true;
  els.recoveryBootstrap.hidden = true;
  els.recoverySettings.hidden = false;
  els.recoveryLocal.hidden = false;
  els.recoveryRetry.hidden = true;
  els.recoveryProgress.hidden = true;
}

function setRecoveryProgress(message = "") {
  els.recoveryProgressText.textContent = message;
  els.recoveryProgress.hidden = message.length === 0;
}

/**
 * First-run bootstrap recovery. Shown when the native shell reports the sidecar
 * isn't installed yet (`needs_bootstrap`) or a previous install/start failed
 * (`error`). Offers a single approved install action; the actual install runs
 * natively in the Zig shell.
 */
function showBootstrapRecovery({ title, message, installLabel = "Install & start", progress = "" } = {}) {
  els.recoveryTitle.textContent = title;
  els.recoveryMessage.textContent = message;
  els.recoveryBootstrap.textContent = installLabel;
  els.recoveryBootstrap.hidden = false;
  els.recoverySettings.hidden = true;
  els.recoveryLocal.hidden = true;
  els.recoveryRetry.hidden = true;
  setRecoveryProgress(progress);
  els.recoveryPanel.hidden = false;
  els.placeholder.hidden = true;
  els.editor.hidden = true;
  els.recoveryBootstrap.disabled = false;
  showSetup(false);
  hideSimilar();
}

/**
 * `installing` phase: native install/start in progress. No actions — just a
 * spinner and message; the poller advances to ready/error.
 */
function showInstallingRecovery(message) {
  els.recoveryTitle.textContent = "Setting up Gemdex";
  els.recoveryMessage.textContent = "";
  els.recoveryBootstrap.hidden = true;
  els.recoverySettings.hidden = true;
  els.recoveryLocal.hidden = true;
  els.recoveryRetry.hidden = true;
  setRecoveryProgress(message || "Working…");
  els.recoveryPanel.hidden = false;
  els.placeholder.hidden = true;
  els.editor.hidden = true;
  showSetup(false);
  hideSimilar();
}

/**
 * `needs_node` phase: a prerequisite we can't install for the user. Show a
 * specific, actionable error with a retry (re-checks after they install Node).
 */
function showNodeMissingRecovery(message) {
  els.recoveryTitle.textContent = "Node.js is required";
  els.recoveryMessage.textContent = message
    || "Gemdex needs Node.js (node + npx) on your PATH. Install Node 20+ from nodejs.org, then retry.";
  els.recoveryBootstrap.hidden = true;
  els.recoverySettings.hidden = true;
  els.recoveryLocal.hidden = true;
  els.recoveryRetry.hidden = false;
  setRecoveryProgress();
  els.recoveryPanel.hidden = false;
  els.placeholder.hidden = true;
  els.editor.hidden = true;
  showSetup(false);
  hideSimilar();
}

function showRemoteRecovery(error) {
  const backend = activeBackend();
  if (backend?.mode !== "remote") return false;
  const remoteName = activeRemoteName() || "remote storage";
  els.recoveryTitle.textContent = `${remoteName} is unreachable`;
  els.recoveryMessage.textContent = `${error.message} Open Storage settings to test or edit the remote, or switch to local storage if it is configured.`;
  els.recoverySettings.hidden = false;
  els.recoveryLocal.hidden = !settingsState?.localConfigured;
  els.recoveryRetry.hidden = true;
  els.recoveryPanel.hidden = false;
  els.placeholder.hidden = true;
  els.editor.hidden = true;
  hideSimilar();
  selectedId = null;
  renderList();
  return true;
}

function showSidecarRecovery() {
  els.recoveryTitle.textContent = "Memory store did not start";
  els.recoveryMessage.textContent = "The desktop shell could not reach the local memory sidecar. Retry the connection; if it still fails, restart Gemdex and check the sidecar logs.";
  els.recoverySettings.hidden = true;
  els.recoveryLocal.hidden = true;
  els.recoveryRetry.hidden = false;
  els.recoveryPanel.hidden = false;
  els.placeholder.hidden = true;
  els.editor.hidden = true;
  hideSimilar();
}

function selectedRemoteName() {
  return els.remoteSelect.value || activeRemoteName() || "";
}

function showSettingsError(message = "") {
  els.settingsError.textContent = message;
  els.settingsError.hidden = !message;
}

function renderSettings() {
  if (!settingsState) return;
  els.modeLocal.classList.toggle("active", settingsState.mode === "local");
  els.modeRemote.classList.toggle("active", settingsState.mode === "remote");
  els.remoteSelect.innerHTML = "";
  for (const remote of settingsState.remotes ?? []) {
    const option = document.createElement("option");
    option.value = remote.name;
    option.textContent = remoteOptionLabel(remote);
    els.remoteSelect.appendChild(option);
  }
  const activeName = activeRemoteName();
  if (activeName) els.remoteSelect.value = activeName;
  updateRemoteControls();
  els.remoteStatus.textContent = settingsState.mode === "remote"
    ? `Using ${activeName || "remote storage"}.`
    : "Using the embedded local store.";
  els.remoteStatus.classList.remove("error", "success");
}

function updateRemoteControls() {
  const remotes = settingsState?.remotes ?? [];
  const hasRemote = remotes.length > 0;
  const selected = remotes.find((remote) => remote.name === selectedRemoteName());
  const usable = Boolean(selected?.hasToken);
  els.remoteSelect.disabled = !hasRemote;
  els.modeRemote.disabled = !usable;
  els.remoteUse.disabled = !usable;
  els.remoteTest.disabled = !usable;
  els.remoteImport.disabled = !usable || !settingsState?.localConfigured;
  els.remoteRemove.disabled = !hasRemote;
}

function populateRemoteForm() {
  const selected = (settingsState?.remotes ?? []).find(
    (remote) => remote.name === selectedRemoteName(),
  );
  if (!selected) return;
  els.remoteName.value = selected.name;
  els.remoteUrl.value = selected.url;
  els.remoteToken.value = "";
  updateRemoteControls();
}

async function refreshSettings() {
  settingsState = await api("/settings");
  renderSettings();
  return settingsState;
}

async function openSettings() {
  showSettingsError();
  els.remoteStatus.textContent = "Loading storage settings…";
  settingsOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  els.settingsModal.hidden = false;
  requestAnimationFrame(() => focusFirstIn(els.settingsModal.querySelector(".settings-card")));
  try {
    await Promise.all([refreshSettings(), refreshConfigState()]);
    renderSettings();
  } catch (err) {
    showSettingsError(err.message);
  }
}

async function openSetupRemote() {
  await openSettings();
  requestAnimationFrame(() => els.remoteName.focus());
}

function closeSettings() {
  els.settingsModal.hidden = true;
  showSettingsError();
  els.remoteToken.value = "";
  if (settingsOpener?.isConnected) settingsOpener.focus();
  settingsOpener = null;
}

async function applyMode(mode, name) {
  showSettingsError();
  const currentBackend = activeBackend();
  if (
    shouldConfirmBackendSwitch(currentBackend, mode, name)
    && !(await confirmAction({
      title: "Switch storage backend",
      message: backendSwitchConfirmation(currentBackend, mode, name),
      confirmLabel: "Switch",
    }))
  ) {
    return;
  }
  try {
    settingsState = await api("/settings/mode", {
      method: "POST",
      body: JSON.stringify({ mode, ...(name && { name }) }),
    });
    if (!(await syncConfigGate())) setStatus("API key required");
  } catch (err) {
    showSettingsError(err.message);
  }
}

async function saveRemote(event) {
  event.preventDefault();
  showSettingsError();
  const payload = {
    name: els.remoteName.value.trim(),
    url: els.remoteUrl.value.trim(),
    token: els.remoteToken.value.trim(),
  };
  els.remoteToken.value = "";
  els.remoteSave.disabled = true;
  try {
    settingsState = await api("/settings/remotes", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    els.remoteName.value = "";
    els.remoteUrl.value = "";
    renderSettings();
    if (payload.name) {
      els.remoteSelect.value = payload.name;
      updateRemoteControls();
    }
    await refreshConfigState();
    renderSettings();
    els.remoteStatus.textContent = `Saved ${payload.name}.`;
    els.remoteStatus.classList.add("success");
  } catch (err) {
    showSettingsError(err.message);
  } finally {
    payload.token = "";
    els.remoteSave.disabled = false;
  }
}

async function testSelectedRemote() {
  const name = selectedRemoteName();
  if (!name) return;
  showSettingsError();
  els.remoteStatus.textContent = `Testing ${name}…`;
  try {
    const result = await api("/settings/test", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    const status = connectionStatus(name, result);
    els.remoteStatus.textContent = status.text;
    els.remoteStatus.classList.toggle("error", status.isError);
    els.remoteStatus.classList.toggle("success", !status.isError);
  } catch (err) {
    els.remoteStatus.textContent = err.message;
    els.remoteStatus.classList.add("error");
  }
}

async function importLocalToSelectedRemote() {
  const name = selectedRemoteName();
  if (!name || !(await confirmAction({
    title: "Import local memories",
    message: `Import local memories to ${name}? Existing ids will be updated.`,
    confirmLabel: "Import",
  }))) return;
  showSettingsError();
  els.remoteImport.disabled = true;
  els.remoteStatus.textContent = `Importing local memories to ${name}…`;
  try {
    const result = await api("/settings/import-local", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    const status = migrationStatus(result);
    els.remoteStatus.textContent = status.text;
    els.remoteStatus.classList.toggle("error", status.isError);
    els.remoteStatus.classList.toggle("success", !status.isError);
    if (activeBackend()?.mode === "remote" && activeRemoteName() === name) {
      await loadMemories();
    }
  } catch (err) {
    els.remoteStatus.textContent = err.message;
    els.remoteStatus.classList.add("error");
  } finally {
    els.remoteImport.disabled = !settingsState?.localConfigured;
  }
}

async function removeSelectedRemote() {
  const name = selectedRemoteName();
  if (!name || !(await confirmAction({
    title: "Remove remote",
    message: `Remove the ${name} remote configuration?`,
    confirmLabel: "Remove",
    destructive: true,
  }))) return;
  showSettingsError();
  try {
    settingsState = await api(`/settings/remotes/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    await syncConfigGate();
  } catch (err) {
    showSettingsError(err.message);
  }
}

function wireEvents() {
  els.newBtn.addEventListener("click", openNew);
  els.settingsBtn.addEventListener("click", openSettings);
  els.setupSettingsBtn.addEventListener("click", openSetupRemote);
  els.recoverySettings.addEventListener("click", openSettings);
  els.recoveryLocal.addEventListener("click", () => applyMode("local"));
  els.recoveryRetry.addEventListener("click", initAfterEvents);
  els.recoveryBootstrap.addEventListener("click", startBootstrap);
  els.settingsClose.addEventListener("click", closeSettings);
  els.settingsModal.addEventListener("click", (event) => {
    if (event.target === els.settingsModal) closeSettings();
  });
  els.settingsModal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSettings();
    } else {
      trapFocus(event, els.settingsModal.querySelector(".settings-card"));
    }
  });
  els.confirmCancel.addEventListener("click", () => closeConfirm(false));
  els.confirmOk.addEventListener("click", () => closeConfirm(true));
  els.confirmModal.addEventListener("click", (event) => {
    if (event.target === els.confirmModal) closeConfirm(false);
  });
  els.confirmModal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeConfirm(false);
    } else {
      trapFocus(event, els.confirmModal.querySelector(".confirm-card"));
    }
  });
  els.modeLocal.addEventListener("click", () => applyMode("local"));
  els.modeRemote.addEventListener("click", () => applyMode("remote", selectedRemoteName()));
  els.remoteUse.addEventListener("click", () => applyMode("remote", selectedRemoteName()));
  els.remoteSelect.addEventListener("change", populateRemoteForm);
  els.remoteTest.addEventListener("click", testSelectedRemote);
  els.remoteImport.addEventListener("click", importLocalToSelectedRemote);
  els.remoteRemove.addEventListener("click", removeSelectedRemote);
  els.remoteForm.addEventListener("submit", saveRemote);
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
  window.addEventListener("beforeunload", releaseListThumbnailObjectUrls);

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
}

/**
 * Reconcile the UI with the sidecar's current config: load memories when an API
 * key is configured, otherwise reveal the setup screen. Returns whether the
 * store is configured so callers can add their own not-configured messaging.
 */
async function syncConfigGate() {
  const config = await refreshConfigState();
  if (settingsState) renderSettings();
  if (config.configured) {
    showSetup(false);
    clearRecovery();
    await loadMemories();
    return true;
  }
  showSetup(true);
  return false;
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
    updateConfigState(body);
    if (!body?.configured) throw new Error("Key was not accepted.");
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
    clearRecovery();
    setStatus(`${memories.length} ${memories.length === 1 ? "memory" : "memories"}`);
  } catch (err) {
    if (showRemoteRecovery(err)) {
      setStatus(`Remote unavailable: ${err.message}`, true);
      return;
    }
    setStatus(`Error: ${err.message}`, true);
  }
}

async function init() {
  wireEvents();
  els.setupForm.addEventListener("submit", submitApiKey);
  await initAfterEvents();
}

async function initAfterEvents() {
  renderBackendBadge();
  setStatus("waiting for memory store…");
  // With the native shell we drive off its lifecycle phase (which knows about
  // bootstrap/install). Without it (dev / browser / tests) we keep the legacy
  // health-poll path so nothing else has to change.
  const status = await fetchStatus();
  if (!status) {
    await legacyConnect();
    return;
  }
  await handlePhase(status);
}

/** Legacy connect path used when the native status bridge is unavailable. */
async function legacyConnect() {
  apiBase = await resolveApiBase();
  const healthy = await waitForHealth();
  if (!healthy) {
    showSetup(false);
    showSidecarRecovery();
    setStatus("Could not reach the memory store sidecar.", true);
    return;
  }
  if (!(await syncConfigGate())) setStatus("API key required");
}

/**
 * React to one sidecar lifecycle phase reported by the native shell. `ready`
 * connects normally; transient phases poll; the rest render targeted recovery.
 */
async function handlePhase(status) {
  switch (status.phase) {
    case "ready":
      apiBase = await resolveApiBase();
      clearRecovery();
      if (!(await syncConfigGate())) setStatus("API key required");
      return;
    case "needs_bootstrap":
      showBootstrapRecovery({
        title: status.previouslyInstalled ? "Reconnect the memory store" : "Finish setting up Gemdex",
        message: status.detail
          || "Gemdex needs to install its local memory sidecar before you can start. This downloads the Node package once.",
        installLabel: status.previouslyInstalled ? "Reinstall & start" : "Install & start",
      });
      setStatus("Setup required", true);
      return;
    case "installing":
      showInstallingRecovery(status.detail);
      setStatus("Setting up…");
      pollStatus();
      return;
    case "needs_node":
      showNodeMissingRecovery(status.detail);
      setStatus("Node.js is required", true);
      return;
    case "error":
      showBootstrapRecovery({
        title: "Setup didn’t finish",
        message: status.detail || "The memory sidecar could not start.",
        installLabel: "Try again",
      });
      setStatus("Setup failed", true);
      return;
    case "starting":
    default:
      setStatus("waiting for memory store…");
      pollStatus();
      return;
  }
}

/**
 * Poll the native status bridge while the sidecar is in a transient phase
 * (starting / installing). Stops as soon as a terminal phase is reached and
 * hands off to handlePhase().
 */
async function pollStatus() {
  if (pollHandle) return; // a poll loop is already running
  const tick = async () => {
    const status = await fetchStatus();
    if (!status) {
      pollHandle = null;
      await legacyConnect();
      return;
    }
    if (status.phase === "starting" || status.phase === "installing") {
      if (status.phase === "installing") setRecoveryProgress(status.detail || "Working…");
      pollHandle = setTimeout(tick, POLL_INTERVAL_MS);
      return;
    }
    pollHandle = null;
    await handlePhase(status);
  };
  pollHandle = setTimeout(tick, POLL_INTERVAL_MS);
}

/** Approve the native install/start, then poll until it resolves. */
async function startBootstrap() {
  // `error`/needs_bootstrap after a prior install means the package may already
  // be cached, but a fresh user-approved action should still permit a network
  // install — so always pass install:true from this button.
  els.recoveryBootstrap.disabled = true;
  showInstallingRecovery("Installing the Gemdex memory sidecar…");
  setStatus("Installing…");
  const accepted = await requestBootstrap(true);
  if (!accepted) {
    // Either the bridge is gone or a worker is already busy; reflect status.
    const status = await fetchStatus();
    if (status) {
      await handlePhase(status);
    } else {
      showSidecarRecovery();
      setStatus("Could not start setup.", true);
    }
    return;
  }
  pollStatus();
}

if (!import.meta.vitest) {
  init();
}

export const __private = {
  els,
  renderList,
  syncConfigGate,
  showRemoteRecovery,
  showSidecarRecovery,
  showBootstrapRecovery,
  showNodeMissingRecovery,
  showInstallingRecovery,
  handlePhase,
  startBootstrap,
  clearRecovery,
  openSettings,
  closeSettings,
  confirmAction,
  closeConfirm,
  buildAttachmentsPayload,
  findSimilar,
  openMemory,
  setTestState(state = {}) {
    if ("apiBase" in state) apiBase = state.apiBase;
    if ("apiToken" in state) apiToken = state.apiToken;
    if ("memories" in state) memories = state.memories;
    if ("selectedId" in state) selectedId = state.selectedId;
    if ("settingsState" in state) settingsState = state.settingsState;
    if ("configState" in state) configState = state.configState;
    if ("editorAttachments" in state) editorAttachments = state.editorAttachments;
    if ("loadedAttachmentSig" in state) loadedAttachmentSig = state.loadedAttachmentSig;
  },
};
