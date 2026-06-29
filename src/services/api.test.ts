import { describe, expect, it } from "vitest";
import { issueFromError } from "./api";

describe("api error handling", () => {
  it("hides raw backend renderer output from user-facing messages", () => {
    const raw = new Error("ffmpeg exited 3752568763: [libx264 @ 00000139352a3ac0] malloc of size 11619264 failed\nConversion failed!");

    const issue = issueFromError(raw);

    expect(issue.title).toBe("Processing stopped");
    expect(issue.message).toBe("HighlightAI could not finish that step.");
    expect(issue.action).toMatch(/try again/i);
    expect(`${issue.title} ${issue.message} ${issue.action}`).not.toMatch(/ffmpeg|libx264|malloc|Conversion failed|000001/i);
  });

  it("sanitizes structured issues before display", () => {
    const raw = new Error("ignored") as Error & {
      issue: {
        title: string;
        message: string;
        action: string;
        recoverable: boolean;
      };
    };
    raw.issue = {
      title: "Rendering stopped",
      message: "[vost#0:0/libx264] Error while opening encoder - maybe incorrect parameters",
      action: "Check D:\\Projects\\VideoGen\\data\\exports\\failed.mp4",
      recoverable: true
    };

    const issue = issueFromError(raw);

    expect(issue.title).toBe("Rendering stopped");
    expect(issue.message).toBe("HighlightAI could not finish that step.");
    expect(issue.action).toMatch(/try again/i);
    expect(`${issue.message} ${issue.action}`).not.toMatch(/libx264|D:\\|encoder/i);
  });

  it("hides provider secrets and endpoints from user-facing messages", () => {
    const raw = new Error("Authorization failed for https://127.0.0.1:11434/v1 with api key sk-test123");

    const issue = issueFromError(raw);

    expect(issue.message).toBe("HighlightAI could not finish that step.");
    expect(`${issue.message} ${issue.action}`).not.toMatch(/https?:\/\/|api key|sk-test/i);
  });
});
