import { describe, expect, it } from "vitest";
import {
  connectionStatus,
  migrationStatus,
  remoteOptionLabel,
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
