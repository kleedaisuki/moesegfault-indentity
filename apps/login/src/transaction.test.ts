import { describe, expect, it, vi } from "vitest";
import { captureAndScrubTransaction, currentTransaction } from "./transaction";

describe("in-memory transaction capture", () => {
  it("captures tx then scrubs it and the fragment using replaceState", () => {
    const location = {
      href: "https://login.moesegfault.dev/login?tx=opaque-123&theme=light#leaky",
      pathname: "/login",
      search: "?tx=opaque-123&theme=light",
      hash: "#leaky",
    } as Location;
    const replaceState = vi.fn();
    const history = { state: { preserved: true }, replaceState } as unknown as History;

    expect(captureAndScrubTransaction(location, history)).toBe("opaque-123");
    expect(currentTransaction()).toBe("opaque-123");
    expect(replaceState).toHaveBeenCalledWith({ preserved: true }, "", "/login?theme=light");
  });

  it("does not write any browser storage", () => {
    const source = captureAndScrubTransaction.toString();
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/u);
  });
});
