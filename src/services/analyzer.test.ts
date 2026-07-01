import { describe, expect, it } from "vitest";
import { clampDuration, formatTime } from "./analyzer";

describe("highlight constraints", () => {
  it("enforces the three minute maximum", () => {
    expect(clampDuration(400)).toBe(180);
  });

  it("keeps useful minimum duration", () => {
    expect(clampDuration(2)).toBe(15);
  });

  it("formats timeline durations", () => {
    expect(formatTime(148)).toBe("02:28");
  });
});
