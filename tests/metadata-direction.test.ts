import { describe, expect, it } from "vitest";

import { resolvedMetadataDirection } from "../src/react/lib/metadata-direction.js";

describe("metadata direction", () => {
  it("lets an element decide before the package does", () => {
    expect(resolvedMetadataDirection("rtl", "ltr")).toBe("rtl");
    expect(resolvedMetadataDirection("ltr", "rtl")).toBe("ltr");
    expect(resolvedMetadataDirection("rtl", null)).toBe("rtl");
  });

  it("treats an explicit auto as a declaration that outranks the package", () => {
    expect(resolvedMetadataDirection("auto", "rtl")).toBe("auto");
  });

  it("inherits the package when the element says nothing", () => {
    expect(resolvedMetadataDirection(null, "rtl")).toBe("rtl");
    expect(resolvedMetadataDirection(undefined, "ltr")).toBe("ltr");
  });

  it("states no direction when neither declares one", () => {
    // Not `auto`: silence leaves the choice to the reading system, where `auto` asks for
    // the direction to be inferred from the text.
    expect(resolvedMetadataDirection(null, null)).toBeNull();
    expect(resolvedMetadataDirection(undefined, undefined)).toBeNull();
  });
});
