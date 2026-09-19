import { describe, expect, it, vi } from "vitest";

import {
  AVATAR_MAX_INPUT_BYTES,
  AvatarImageError,
  planAvatarTransform,
  processAvatarImage,
  type AvatarDecodedImage,
  type AvatarImagePlatform,
  type AvatarTransformPlan,
} from "./avatar";

describe("planAvatarTransform", () => {
  it("center-crops landscape and portrait images", () => {
    expect(planAvatarTransform(1600, 900)).toEqual({
      sourceX: 350,
      sourceY: 0,
      sourceEdge: 900,
      outputEdge: 900,
    });
    expect(planAvatarTransform(900, 1601)).toEqual({
      sourceX: 0,
      sourceY: 350,
      sourceEdge: 900,
      outputEdge: 900,
    });
  });

  it("caps large images without upscaling small images", () => {
    expect(planAvatarTransform(4000, 3000).outputEdge).toBe(1024);
    expect(planAvatarTransform(320, 480, 1024).outputEdge).toBe(320);
    expect(planAvatarTransform(2048, 2048, 512).outputEdge).toBe(512);
  });

  it.each([
    [0, 100, 100],
    [100, Number.NaN, 100],
    [100.5, 100, 100],
    [100, 100, -1],
    [100, 100, 1025],
  ])("rejects invalid dimensions (%s, %s, %s)", (width, height, maxEdge) => {
    expect(() => planAvatarTransform(width, height, maxEdge)).toThrowError(
      expect.objectContaining({ code: "INVALID_DIMENSIONS" }),
    );
  });
});

describe("processAvatarImage validation", () => {
  it.each(["image/gif", "image/svg+xml", "", "IMAGE/UNKNOWN"]) (
    "rejects unsupported type %s before decoding",
    async (type) => {
      const platform = fakePlatform();
      await expect(processAvatarImage(new Blob(["x"], { type }), { platform })).rejects.toMatchObject({
        code: "UNSUPPORTED_TYPE",
      });
      expect(platform.decode).not.toHaveBeenCalled();
    },
  );

  it("rejects empty and over-limit inputs before decoding", async () => {
    const platform = fakePlatform();
    await expect(processAvatarImage(new Blob([], { type: "image/png" }), { platform })).rejects.toMatchObject({
      code: "EMPTY_INPUT",
    });
    await expect(
      processAvatarImage(new Blob([new Uint8Array(AVATAR_MAX_INPUT_BYTES + 1)], { type: "image/png" }), {
        platform,
      }),
    ).rejects.toMatchObject({ code: "INPUT_TOO_LARGE" });
    expect(platform.decode).not.toHaveBeenCalled();
  });

  it("rejects invalid quality before decoding", async () => {
    const platform = fakePlatform();
    await expect(
      processAvatarImage(new Blob(["x"], { type: "image/png" }), { platform, quality: 1.1 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(platform.decode).not.toHaveBeenCalled();
  });

  it.each([0, 1025, 100.5])("rejects an unsafe output edge %s before decoding", async (maxEdge) => {
    const platform = fakePlatform();
    await expect(
      processAvatarImage(new Blob(["x"], { type: "image/png" }), { platform, maxEdge }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(platform.decode).not.toHaveBeenCalled();
  });
});

describe("processAvatarImage resource ownership", () => {
  it("closes decoded pixels and exposes an idempotently disposable preview", async () => {
    const close = vi.fn();
    const platform = fakePlatform({ width: 1600, height: 900, close });
    const input = new File(["original"], "klee.photo.png", { type: "image/png" });

    const result = await processAvatarImage(input, { platform });

    expect(platform.decode).toHaveBeenCalledWith(input);
    expect(platform.renderWebp).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1600, height: 900 }),
      { sourceX: 350, sourceY: 0, sourceEdge: 900, outputEdge: 900 },
      0.86,
    );
    expect(close).toHaveBeenCalledOnce();
    expect(result.file).toBeInstanceOf(File);
    expect(result.file.name).toBe("klee.photo.webp");
    expect(result.file.type).toBe("image/webp");
    expect(result.blob).toBe(result.file);
    expect(result.previewUrl).toBe("blob:avatar-preview");
    expect(result.metadata).toEqual({
      inputBytes: input.size,
      outputBytes: result.file.size,
      sourceWidth: 1600,
      sourceHeight: 900,
      edge: 900,
      mediaType: "image/webp",
    });

    result.dispose();
    result.dispose();
    expect(platform.revokeObjectURL).toHaveBeenCalledOnce();
    expect(platform.revokeObjectURL).toHaveBeenCalledWith("blob:avatar-preview");
  });

  it("closes decoded pixels when encoding fails", async () => {
    const close = vi.fn();
    const platform = fakePlatform({ close });
    vi.mocked(platform.renderWebp).mockRejectedValueOnce(new Error("encoder broke"));

    await expect(
      processAvatarImage(new Blob(["x"], { type: "image/jpeg" }), { platform }),
    ).rejects.toMatchObject({ code: "ENCODE_FAILED", cause: expect.any(Error) });
    expect(close).toHaveBeenCalledOnce();
    expect(platform.createObjectURL).not.toHaveBeenCalled();
  });

  it("closes decoded pixels and rejects a silent non-WebP fallback", async () => {
    const close = vi.fn();
    const platform = fakePlatform({ close });
    vi.mocked(platform.renderWebp).mockResolvedValueOnce(new Blob(["png"], { type: "image/png" }));

    await expect(
      processAvatarImage(new Blob(["x"], { type: "image/avif" }), { platform }),
    ).rejects.toMatchObject({ code: "ENCODE_FAILED" });
    expect(close).toHaveBeenCalledOnce();
    expect(platform.createObjectURL).not.toHaveBeenCalled();
  });

  it("preserves typed platform failures while still closing decoded pixels", async () => {
    const close = vi.fn();
    const platform = fakePlatform({ close });
    vi.mocked(platform.renderWebp).mockRejectedValueOnce(
      new AvatarImageError("UNSUPPORTED_BROWSER", "canvas unavailable"),
    );

    await expect(
      processAvatarImage(new Blob(["x"], { type: "image/webp" }), { platform }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_BROWSER" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not leak or discard a result when a custom decoder close hook misbehaves", async () => {
    const platform = fakePlatform({ close: vi.fn(() => { throw new Error("bad close hook"); }) });

    const result = await processAvatarImage(new Blob(["x"], { type: "image/png" }), { platform });

    expect(result.previewUrl).toBe("blob:avatar-preview");
    result.dispose();
    expect(platform.revokeObjectURL).toHaveBeenCalledOnce();
  });
});

/** 创建不依赖 Canvas 的确定性平台替身。Creates a deterministic platform double without Canvas. */
function fakePlatform(
  overrides: Partial<Pick<AvatarDecodedImage, "width" | "height" | "close">> = {},
): AvatarImagePlatform & {
  decode: ReturnType<typeof vi.fn<(blob: Blob) => Promise<AvatarDecodedImage>>>;
  renderWebp: ReturnType<
    typeof vi.fn<(image: AvatarDecodedImage, plan: AvatarTransformPlan, quality: number) => Promise<Blob>>
  >;
  createObjectURL: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
  revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>;
} {
  const decoded: AvatarDecodedImage = {
    width: overrides.width ?? 640,
    height: overrides.height ?? 480,
    source: { pixels: true },
    close: overrides.close ?? vi.fn(),
  };
  return {
    decode: vi.fn(async () => decoded),
    renderWebp: vi.fn(async () => new Blob(["webp"], { type: "image/webp" })),
    createObjectURL: vi.fn(() => "blob:avatar-preview"),
    revokeObjectURL: vi.fn(),
  };
}
