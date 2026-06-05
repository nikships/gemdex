import { describe, expect, it } from "vitest";
import {
  backendLabel,
  backendSwitchConfirmation,
  connectionStatus,
  migrationStatus,
  remoteOptionLabel,
  shouldConfirmBackendSwitch,
  targetBackendLabel,
} from "./settings.js";

describe("remoteOptionLabel", () => {
  it("shows URL and missing-token state without exposing a token value", () => {
    expect(remoteOptionLabel({
      name: "prod",
      url: "https://memory.example.com",
      hasToken: false,
    })).toBe("prod · https://memory.example.com · token missing");
  });
});

describe("backend switch labels", () => {
  it("uses the active remote name when describing the current backend", () => {
    expect(backendLabel({
      mode: "remote",
      activeRemote: { name: "prod" },
    })).toBe("remote backend “prod”");
  });

  it("uses the selected remote name when describing the switch target", () => {
    expect(targetBackendLabel("remote", "staging")).toBe("remote backend “staging”");
  });

  it("builds a confirmation message with active and selected remote names", () => {
    expect(backendSwitchConfirmation({
      mode: "remote",
      activeRemote: { name: "prod" },
    }, "remote", "staging")).toBe("Switch from remote backend “prod” to remote backend “staging”?");
  });
});

describe("shouldConfirmBackendSwitch", () => {
  it("confirms switching from local to a selected remote", () => {
    expect(shouldConfirmBackendSwitch({ mode: "local" }, "remote", "prod")).toBe(true);
  });

  it("confirms switching from an active remote to local", () => {
    expect(shouldConfirmBackendSwitch({
      mode: "remote",
      activeRemote: { name: "prod" },
    }, "local")).toBe(true);
  });

  it("confirms switching from one remote to another", () => {
    expect(shouldConfirmBackendSwitch({
      mode: "remote",
      activeRemote: { name: "prod" },
    }, "remote", "staging")).toBe(true);
  });

  it("does not confirm selecting the already-active remote", () => {
    expect(shouldConfirmBackendSwitch({
      mode: "remote",
      activeRemote: { name: "prod" },
    }, "remote", "prod")).toBe(false);
  });

  it("does not confirm selecting local when local is already active", () => {
    expect(shouldConfirmBackendSwitch({ mode: "local" }, "local")).toBe(false);
  });
});

describe("connectionStatus", () => {
  it("renders authenticated success", () => {
    expect(connectionStatus("prod", {
      reachable: true,
      authenticated: true,
    })).toEqual({
      text: "prod is reachable and authenticated.",
      isError: false,
    });
  });

  it("surfaces a remote failure detail", () => {
    expect(connectionStatus("prod", {
      reachable: true,
      authenticated: false,
      detail: "Unauthorized",
    })).toEqual({
      text: "Unauthorized",
      isError: true,
    });
  });
});

describe("migrationStatus", () => {
  it("summarizes counts and marks partial migrations as errors", () => {
    expect(migrationStatus({ created: 3, updated: 2, skipped: 1 })).toEqual({
      text: "Import complete: 3 created, 2 updated, 1 skipped.",
      isError: true,
    });
  });
});
