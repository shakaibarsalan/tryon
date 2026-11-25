// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { clearArea, getItem, onItemChange, removeItem, setItem } from "../src/lib/store";

// The web try page has no chrome.storage: "local" persists in localStorage, "session" in sessionStorage.
describe("storage on a web page", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("persists the local area in localStorage under a prefix", async () => {
    expect(location.protocol).toMatch(/^https?:$/);
    await setItem("local", "consent", { version: "v1" });
    expect(localStorage.getItem("tryon:consent")).toBe('{"version":"v1"}');
    expect(await getItem("local", "consent")).toEqual({ version: "v1" });
    await removeItem("local", "consent");
    expect(localStorage.getItem("tryon:consent")).toBeNull();
  });

  it("keeps the session area in sessionStorage and notifies listeners", async () => {
    const seen: unknown[] = [];
    const off = onItemChange("session", "currentGarment", (v, old) => seen.push([v, old]));
    await setItem("session", "currentGarment", { id: "a" });
    await setItem("session", "currentGarment", { id: "b" });
    off();
    await removeItem("session", "currentGarment");
    expect(sessionStorage.getItem("tryon:currentGarment")).toBeNull();
    expect(seen).toEqual([
      [{ id: "a" }, undefined],
      [{ id: "b" }, { id: "a" }],
    ]);
  });

  it("clears only its own keys", async () => {
    localStorage.setItem("someone-else", "x");
    await setItem("local", "install", { token: "t" });
    await setItem("local", "prefs", { chipsEnabled: false });
    await clearArea("local");
    expect(await getItem("local", "install")).toBeUndefined();
    expect(localStorage.getItem("someone-else")).toBe("x");
  });

  it("ignores values it can't parse", async () => {
    localStorage.setItem("tryon:broken", "{not json");
    expect(await getItem("local", "broken")).toBeUndefined();
  });
});
