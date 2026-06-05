// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html = `
  <div id="setup" hidden>
    <form id="setup-form"></form>
    <input id="api-key-input" />
    <button id="api-key-save"></button>
    <button id="setup-settings-btn"></button>
    <p id="setup-error" hidden></p>
  </div>
  <div id="app" hidden>
    <p id="status"></p>
    <span id="backend-badge"></span>
    <button id="settings-btn">Storage</button>
    <button id="new-btn"></button>
    <button id="export-btn"></button>
    <button id="import-btn"></button>
    <input id="import-file" />
    <input id="filter" />
    <ul id="memory-list"></ul>
    <p id="empty" hidden></p>
    <div id="recovery-panel" hidden>
      <h2 id="recovery-title"></h2>
      <p id="recovery-message"></p>
      <button id="recovery-bootstrap" hidden></button>
      <button id="recovery-settings"></button>
      <button id="recovery-local"></button>
      <button id="recovery-retry"></button>
      <p id="recovery-progress" hidden><span id="recovery-progress-text"></span></p>
    </div>
    <div id="placeholder"></div>
    <form id="editor" hidden>
      <input id="title-input" />
      <textarea id="content-input"></textarea>
      <p id="meta"></p>
      <button id="save-btn"></button>
      <button id="delete-btn"></button>
      <button id="attach-btn"></button>
      <input id="attach-input" />
      <ul id="attachment-list"></ul>
      <div id="dropzone"></div>
      <p id="dropzone-hint"></p>
      <p id="attach-progress" hidden></p>
      <p id="attach-error" hidden></p>
    </form>
    <div id="similar-panel" hidden>
      <span id="similar-title"></span>
      <button id="similar-close"></button>
      <ul id="similar-list"></ul>
      <div id="similar-error" hidden></div>
      <p id="similar-empty" hidden></p>
    </div>
  </div>
  <div id="settings-modal" hidden>
    <section class="settings-card" role="dialog" aria-modal="true">
      <button id="settings-close">Close</button>
      <button id="mode-local"></button>
      <button id="mode-remote"></button>
      <select id="remote-select"></select>
      <button id="remote-use"></button>
      <button id="remote-test"></button>
      <button id="remote-import"></button>
      <button id="remote-remove"></button>
      <p id="remote-status"></p>
      <form id="remote-form">
        <input id="remote-name" />
        <input id="remote-url" />
        <input id="remote-token" />
        <button id="remote-save"></button>
      </form>
      <p id="settings-error" hidden></p>
    </section>
  </div>
  <div id="confirm-modal" hidden>
    <section class="confirm-card" role="dialog" aria-modal="true">
      <h2 id="confirm-title"></h2>
      <p id="confirm-message"></p>
      <button id="confirm-cancel">Cancel</button>
      <button id="confirm-ok">Continue</button>
    </section>
  </div>
`;

async function loadMain() {
  vi.resetModules();
  document.body.innerHTML = html;
  globalThis.requestAnimationFrame = (callback) => callback();
  globalThis.URL.createObjectURL = vi.fn(() => "blob:preview");
  globalThis.URL.revokeObjectURL = vi.fn();
  return import("./main.js");
}

function jsonResponse(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob(["bytes"], { type: "image/png" })),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("app-level UI flows", () => {
  it("syncConfigGate shows the app and loads memories when configured", async () => {
    const { __private } = await loadMain();
    vi.stubGlobal("fetch", vi.fn((url) => {
      if (String(url).endsWith("/config")) return jsonResponse({ configured: true, mode: "local" });
      if (String(url).endsWith("/memories")) {
        return jsonResponse({ memories: [{ id: "m1", title: "Pinned fact", preview: "preview" }] });
      }
      return jsonResponse({});
    }));

    await expect(__private.syncConfigGate()).resolves.toBe(true);

    expect(__private.els.setup.hidden).toBe(true);
    expect(__private.els.app.hidden).toBe(false);
    expect(document.querySelector(".memory-row")?.textContent).toContain("Pinned fact");
  });

  it("renders remote recovery with settings and local fallback controls", async () => {
    const { __private } = await loadMain();
    __private.setTestState({
      configState: { configured: true, mode: "remote", activeRemote: { name: "prod" } },
      settingsState: { mode: "remote", localConfigured: true },
    });

    expect(__private.showRemoteRecovery(new Error("connection refused"))).toBe(true);

    expect(__private.els.recoveryPanel.hidden).toBe(false);
    expect(__private.els.recoveryTitle.textContent).toBe("prod is unreachable");
    expect(__private.els.recoverySettings.hidden).toBe(false);
    expect(__private.els.recoveryLocal.hidden).toBe(false);
  });

  it("uses real buttons for memory rows and similar result rows", async () => {
    const { __private } = await loadMain();
    __private.setTestState({
      memories: [{ id: "m1", title: "Keyboard memory", updatedAt: 1 }],
      selectedId: "m1",
    });

    __private.renderList();
    const memoryButton = document.querySelector(".memory-item button");
    expect(memoryButton?.className).toBe("memory-row");

    __private.setTestState({ selectedId: "m1" });
    vi.stubGlobal("fetch", vi.fn((url) => {
      if (String(url).endsWith("/recall")) {
        return jsonResponse({ results: [{ id: "m2", title: "Related", score: 0.1234 }] });
      }
      return jsonResponse({});
    }));
    await __private.findSimilar({
      source: "existing",
      id: "att1",
      mimeType: "image/png",
    });

    const similarButton = document.querySelector(".similar-item button");
    expect(similarButton?.className).toBe("similar-row");
    expect(similarButton?.textContent).toContain("Related");
  });

  it("restores focus and closes settings on Escape", async () => {
    const { __private } = await loadMain();
    vi.stubGlobal("fetch", vi.fn((url) => {
      if (String(url).endsWith("/settings")) {
        return jsonResponse({ mode: "local", remotes: [], localConfigured: true });
      }
      if (String(url).endsWith("/config")) return jsonResponse({ configured: true, mode: "local" });
      return jsonResponse({});
    }));
    const opener = __private.els.settingsBtn;
    opener.focus();

    await __private.openSettings();
    expect(__private.els.settingsModal.hidden).toBe(false);

    __private.els.settingsModal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(__private.els.settingsModal.hidden).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it("resolves app-native confirmations without calling native confirm", async () => {
    const { __private } = await loadMain();
    const nativeConfirm = vi.spyOn(window, "confirm");

    const decision = __private.confirmAction({
      title: "Delete memory",
      message: "Delete this memory?",
      confirmLabel: "Delete",
      destructive: true,
    });
    __private.els.confirmOk.click();

    await expect(decision).resolves.toBe(true);
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(__private.els.confirmModal.hidden).toBe(true);
  });

  it("fetches authenticated attachment previews as blob URLs", async () => {
    const { __private } = await loadMain();
    __private.setTestState({ apiBase: "http://127.0.0.1:9999", apiToken: "token" });
    vi.stubGlobal("fetch", vi.fn((url) => {
      if (String(url).endsWith("/memories/m1")) {
        return jsonResponse({
          memory: {
            id: "m1",
            title: "Has image",
            content: "body",
            createdAt: 1,
            updatedAt: 2,
            attachments: [{
              id: "att1",
              kind: "image",
              mimeType: "image/png",
              byteLength: 5,
              caption: "preview",
            }],
          },
        });
      }
      return jsonResponse({});
    }));

    await __private.openMemory("m1");

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/memories/m1/attachments/att1",
      { headers: { "X-Gemdex-Token": "token" } },
    );
    expect(document.querySelector(".att-image")?.getAttribute("src")).toBe("blob:preview");
  });

  it("shows sidecar startup recovery with retry only", async () => {
    const { __private } = await loadMain();

    __private.showSidecarRecovery();

    expect(__private.els.recoveryPanel.hidden).toBe(false);
    expect(__private.els.recoveryTitle.textContent).toBe("Memory store did not start");
    expect(__private.els.recoverySettings.hidden).toBe(true);
    expect(__private.els.recoveryLocal.hidden).toBe(true);
    expect(__private.els.recoveryRetry.hidden).toBe(false);
  });

  it("needs_bootstrap renders an install action, hiding settings/local/retry", async () => {
    const { __private } = await loadMain();

    await __private.handlePhase({
      phase: "needs_bootstrap",
      detail: "Gemdex needs to install its memory sidecar.",
      previouslyInstalled: false,
    });

    expect(__private.els.recoveryPanel.hidden).toBe(false);
    expect(__private.els.recoveryBootstrap.hidden).toBe(false);
    expect(__private.els.recoveryBootstrap.textContent).toBe("Install & start");
    expect(__private.els.recoveryMessage.textContent).toContain("install its memory sidecar");
    expect(__private.els.recoverySettings.hidden).toBe(true);
    expect(__private.els.recoveryLocal.hidden).toBe(true);
    expect(__private.els.recoveryRetry.hidden).toBe(true);
  });

  it("needs_node shows a specific actionable error with no install button", async () => {
    const { __private } = await loadMain();

    await __private.handlePhase({
      phase: "needs_node",
      detail: "Node.js (node + npx) was not found.",
      previouslyInstalled: false,
    });

    expect(__private.els.recoveryPanel.hidden).toBe(false);
    expect(__private.els.recoveryTitle.textContent).toBe("Node.js is required");
    expect(__private.els.recoveryMessage.textContent).toContain("not found");
    expect(__private.els.recoveryBootstrap.hidden).toBe(true);
    expect(__private.els.recoveryRetry.hidden).toBe(false);
  });

  it("approves bootstrap and loads the app once the sidecar is ready", async () => {
    vi.useFakeTimers();
    try {
      const { __private } = await loadMain();

      // The native bridge: bootstrap is accepted, status walks installing→ready,
      // then getApiBase hands over the localhost base + token.
      const statuses = [
        { phase: "installing", detail: "Installing…" },
        { phase: "ready", base: "http://127.0.0.1:7777", token: "tok", previouslyInstalled: true },
      ];
      const invoke = vi.fn((command) => {
        if (command === "gemdex.bootstrap") return Promise.resolve({ accepted: true });
        if (command === "gemdex.getStatus") return Promise.resolve(statuses.shift() ?? { phase: "ready", base: "http://127.0.0.1:7777", token: "tok" });
        if (command === "gemdex.getApiBase") return Promise.resolve({ base: "http://127.0.0.1:7777", token: "tok" });
        return Promise.resolve({});
      });
      vi.stubGlobal("zero", { invoke });
      vi.stubGlobal("fetch", vi.fn((url) => {
        if (String(url).endsWith("/config")) return jsonResponse({ configured: true, mode: "local" });
        if (String(url).endsWith("/memories")) return jsonResponse({ memories: [{ id: "m1", title: "Bootstrapped", preview: "ok" }] });
        return jsonResponse({});
      }));

      // Render the first-run prompt, then approve the install.
      await __private.handlePhase({ phase: "needs_bootstrap", previouslyInstalled: false });
      expect(__private.els.recoveryBootstrap.hidden).toBe(false);

      const bootstrapPromise = __private.startBootstrap();
      expect(invoke).toHaveBeenCalledWith("gemdex.bootstrap", { install: true });
      await bootstrapPromise;

      // Drive the poll loop: installing → ready.
      await vi.advanceTimersByTimeAsync(2000);

      expect(__private.els.app.hidden).toBe(false);
      expect(__private.els.recoveryPanel.hidden).toBe(true);
      expect(document.querySelector(".memory-row")?.textContent).toContain("Bootstrapped");
    } finally {
      vi.useRealTimers();
    }
  });
});
