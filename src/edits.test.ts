import { describe, expect, it } from "vitest";
import { applyEdits, parseEdits } from "./edits";

describe("applyEdits", () => {
  it("applies edits in order, each to the previous result", () => {
    expect(applyEdits("one two", [{ old_text: "one", new_text: "1" }, { old_text: "two", new_text: "2" }])).toBe("1 2");
    expect(applyEdits("a", [{ old_text: "a", new_text: "b" }, { old_text: "b", new_text: "c" }])).toBe("c");
  });

  it("treats the replacement literally, including $ patterns", () => {
    expect(applyEdits("x", [{ old_text: "x", new_text: "$& $1" }])).toBe("$& $1");
  });

  it("fails on a missing, ambiguous or empty snippet, naming the edit", () => {
    const edit = (old_text: string) => ({ old_text, new_text: "" });
    expect(() => applyEdits("abc", [edit("a"), edit("z")])).toThrow("Edit 2 of 2: old_text was not found");
    expect(() => applyEdits("aa", [edit("a")])).toThrow("old_text appears 2 times");
    expect(() => applyEdits("aa", [edit("a")])).not.toThrow("Edit 1 of 1");
    expect(() => applyEdits("aa", [edit("")])).toThrow("must not be empty");
  });
});

describe("parseEdits", () => {
  it("accepts a list of old/new pairs", () => {
    expect(parseEdits([{ old_text: "a", new_text: "b", extra: 1 }])).toEqual([{ old_text: "a", new_text: "b" }]);
    expect(parseEdits([{ old_text: "a", new_text: "" }])).toHaveLength(1);
  });

  it("rejects everything else", () => {
    expect(() => parseEdits(undefined)).toThrow("non-empty list");
    expect(() => parseEdits([])).toThrow("non-empty list");
    expect(() => parseEdits("x")).toThrow("non-empty list");
    expect(() => parseEdits([null])).toThrow("Edit 1 of 1");
    expect(() => parseEdits([{ old_text: 1, new_text: "" }])).toThrow("old_text and new_text");
    expect(() => parseEdits(Array.from({ length: 101 }, () => ({ old_text: "a", new_text: "b" })))).toThrow("At most 100");
  });
});
