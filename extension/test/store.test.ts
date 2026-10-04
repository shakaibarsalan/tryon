import { describe, expect, it } from "vitest";
import { clearArea, getItem, onItemChange, removeItem, setItem } from "../src/lib/store";

// No `chrome` global under vitest, so the in-memory fallback is used (as in a plain page).
describe("storage fallback without chrome.storage", () => {
  it("gets, sets, removes and notifies", async () => {
    const seen: unknown[] = [];
    const off = onItemChange("session", "currentGarment", (v) => seen.push(v));
    expect(await getItem("session", "currentGarment")).toBeUndefined();
    await setItem("session", "currentGarment", { id: "a" });
    expect(await getItem("session", "currentGarment")).toEqual({ id: "a" });
    await removeItem("session", "currentGarment");
    off();
    await setItem("session", "currentGarment", { id: "b" });
    expect(seen).toEqual([{ id: "a" }, undefined]);
  });

  it("keeps areas separate and clears one", async () => {
    await setItem("local", "consent", { version: "v" });
    await setItem("session", "x", 1);
    await clearArea("session");
    expect(await getItem("session", "x")).toBeUndefined();
    expect(await getItem("local", "consent")).toEqual({ version: "v" });
  });
});
