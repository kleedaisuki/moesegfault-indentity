import { describe, expect, it } from "vitest";
import { detectInAppBrowser } from "./browser";

describe("detectInAppBrowser", () => {
  it("detects common mainland China app browsers", () => {
    expect(detectInAppBrowser("Mozilla/5.0 MicroMessenger/8.0")).toEqual({ inApp: true, name: "WeChat" });
    expect(detectInAppBrowser("Mozilla/5.0 QQ/9.1")).toEqual({ inApp: true, name: "QQ" });
  });

  it("does not label normal mobile Safari as an in-app browser", () => {
    expect(detectInAppBrowser("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1")).toEqual({ inApp: false });
  });
});
