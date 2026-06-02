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
};

let apiBase = "";
let memories = [];
let selectedId = null; // null while editing/creating a brand-new memory

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
    li.querySelector(".item-date").textContent = fmtDate(m.updatedAt);
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
    showEditor();
    renderList();
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
}

async function saveCurrent(event) {
  event.preventDefault();
  const content = els.content.value;
  const title = els.title.value.trim();
  if (content.trim().length === 0) {
    setStatus("Content cannot be empty.", true);
    return;
  }
  els.saveBtn.disabled = true;
  try {
    if (selectedId) {
      await api(`/memories/${encodeURIComponent(selectedId)}`, {
        method: "PUT",
        body: JSON.stringify({ content, title: title || undefined }),
      });
    } else {
      const body = await api("/memories", {
        method: "POST",
        body: JSON.stringify({ content, title: title || undefined }),
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
}

async function init() {
  wireEvents();
  apiBase = await resolveApiBase();
  setStatus("waiting for memory store…");
  const healthy = await waitForHealth();
  if (!healthy) {
    setStatus("Could not reach the memory store sidecar.", true);
    return;
  }
  try {
    await refreshList();
    setStatus(`${memories.length} ${memories.length === 1 ? "memory" : "memories"}`);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
}

init();
