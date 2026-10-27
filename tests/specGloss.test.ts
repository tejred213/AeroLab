/** Converting specular / glossiness materials, and reading the credit a model file carries. */
import { describe, expect, it } from "vitest";
import { creditFromAsset, linearToSrgbByte, specGlossToMetalRough, SRGB_TO_LINEAR } from "@/lib/import/specGloss";

describe("specular / glossiness to metallic / roughness", () => {
  it("keeps a non-metal non-metallic, with its diffuse colour", () => {
    const { metalness, baseColor } = specGlossToMetalRough([0.5, 0.2, 0.1], [0.04, 0.04, 0.04]);
    expect(metalness).toBeLessThan(0.01);
    expect(baseColor[0]).toBeCloseTo(0.5, 2);
    expect(baseColor[1]).toBeCloseTo(0.2, 2);
    expect(baseColor[2]).toBeCloseTo(0.1, 2);
  });

  it("turns a black diffuse with a coloured specular into a metal of that colour", () => {
    const { metalness, baseColor } = specGlossToMetalRough([0, 0, 0], [0.9, 0.6, 0.2]);
    expect(metalness).toBeGreaterThan(0.95);
    expect(baseColor[0]).toBeCloseTo(0.9, 1);
    expect(baseColor[1]).toBeCloseTo(0.6, 1);
    expect(baseColor[2]).toBeCloseTo(0.2, 1);
  });

  it("treats no specular at all as a non-metal and never leaves the unit range", () => {
    expect(specGlossToMetalRough([0, 0, 0], [0, 0, 0])).toEqual({ metalness: 0, baseColor: [0, 0, 0] });
    for (const value of specGlossToMetalRough([1, 1, 1], [1, 1, 1]).baseColor) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("converts between sRGB bytes and linear values consistently", () => {
    for (const byte of [0, 1, 20, 128, 200, 255]) expect(linearToSrgbByte(SRGB_TO_LINEAR[byte])).toBe(byte);
  });
});

describe("credit carried by a model file", () => {
  it("reads title, author, page and licence as model sites write them", () => {
    expect(
      creditFromAsset({
        version: "2.0",
        extras: {
          author: "@SomeArtist (https://example.com/someartist)",
          license: "CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)",
          source: "https://example.com/3d-models/some-car-0123",
          title: "Some Car",
        },
      }),
    ).toEqual({ title: "Some Car", author: "@SomeArtist", url: "https://example.com/3d-models/some-car-0123", licence: "CC-BY-4.0" });
  });

  it("ignores a missing credit and a link that is not a web address", () => {
    expect(creditFromAsset({ version: "2.0" })).toBeNull();
    expect(creditFromAsset(null)).toBeNull();
    expect(creditFromAsset({ extras: { title: "X", source: "javascript:alert(1)" } })).toEqual({ title: "X", author: "", url: "", licence: "" });
  });
});
