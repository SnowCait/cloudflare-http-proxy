import { describe, expect, it } from "vitest";
import { wantsJson } from "./utils";

describe("wantsJson", () => {
  it("returns true for application/json", () => {
    expect(wantsJson("application/json")).toBe(true);
  });

  it("returns false for text/html", () => {
    expect(wantsJson("text/html")).toBe(false);
  });

  it("returns true when application/json is among multiple types", () => {
    expect(wantsJson("text/html, application/json")).toBe(true);
  });

  it("returns true when application/json has quality parameter", () => {
    expect(wantsJson("application/json;q=0.9, text/html")).toBe(true);
  });

  it("returns false for undefined", () => {
    expect(wantsJson(undefined)).toBe(false);
  });

  it("returns false for application/json as substring only", () => {
    expect(wantsJson("application/json-patch+json")).toBe(false);
  });
});
