import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

function oklchToRgb(L: number, C: number, h: number): [number, number, number] {
  const hRad = (h * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const rLinear = +4.0767439362 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLinear = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLinear = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  function gamma(c: number): number {
    const clamped = Math.max(0, Math.min(1, c));
    return clamped <= 0.0031308
      ? 12.92 * clamped
      : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  }

  const r = Math.round(gamma(rLinear) * 255);
  const g = Math.round(gamma(gLinear) * 255);
  const bVal = Math.round(gamma(bLinear) * 255);

  return [r, g, bVal];
}

function parseCssColor(str: string): [number, number, number, number] {
  const trimmed = str.trim();
  if (trimmed.startsWith("#")) {
    let hex = trimmed.slice(1);
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    if (hex.length === 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        1,
      ];
    }
  }

  const oklchMatch = trimmed.match(
    /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/
  );
  if (oklchMatch) {
    const L = parseFloat(oklchMatch[1]);
    const C = parseFloat(oklchMatch[2]);
    const h = parseFloat(oklchMatch[3]);
    let alpha = 1;
    if (oklchMatch[4]) {
      alpha = oklchMatch[4].endsWith("%")
        ? parseFloat(oklchMatch[4]) / 100
        : parseFloat(oklchMatch[4]);
    }
    const [r, g, b] = oklchToRgb(L, C, h);
    return [r, g, b, alpha];
  }

  const rgbMatch = trimmed.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+%?))?\s*\)/
  );
  if (rgbMatch) {
    const r = parseFloat(rgbMatch[1]);
    const g = parseFloat(rgbMatch[2]);
    const b = parseFloat(rgbMatch[3]);
    let alpha = 1;
    if (rgbMatch[4]) {
      alpha = rgbMatch[4].endsWith("%")
        ? parseFloat(rgbMatch[4]) / 100
        : parseFloat(rgbMatch[4]);
    }
    return [r, g, b, alpha];
  }

  throw new Error(`Unparseable color string: ${str}`);
}

function relativeLuminance([r, g, b]: [number, number, number, number]): number {
  const srgb = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(
  fg: [number, number, number, number],
  bg: [number, number, number, number]
): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function extractCssTokens(filePath: string) {
  const content = fs.readFileSync(filePath, "utf-8");

  const rootMatch = content.match(/:root\s*\{([^}]+)\}/);
  const darkMatch = content.match(/\.dark\s*\{([^}]+)\}/);

  assert.ok(rootMatch, "Could not find :root block in globals.css");
  assert.ok(darkMatch, "Could not find .dark block in globals.css");

  function parseBlock(blockText: string): Record<string, string> {
    const tokens: Record<string, string> = {};
    const lines = blockText.split("\n");
    for (const line of lines) {
      const match = line.match(/--([\w-]+):\s*([^;]+);/);
      if (match) {
        tokens[match[1]] = match[2].trim();
      }
    }
    return tokens;
  }

  return {
    root: parseBlock(rootMatch[1]),
    dark: parseBlock(darkMatch[1]),
  };
}

describe("Theme Semantic Token Contrast Verification", () => {
  const globalsCssPath = path.resolve(process.cwd(), "app/globals.css");
  const { root: light, dark } = extractCssTokens(globalsCssPath);

  describe("Light Theme Contrast (WCAG 2.1 AA Compliance)", () => {
    it("guarantees body foreground meets normal text contrast (>= 4.5:1) against background", () => {
      const ratio = contrastRatio(
        parseCssColor(light["foreground"]),
        parseCssColor(light["background"])
      );
      assert.ok(
        ratio >= 4.5,
        `Foreground contrast ratio ${ratio.toFixed(2)} is less than 4.5:1`
      );
    });

    it("guarantees muted-foreground meets normal text contrast (>= 4.5:1) on white background", () => {
      const ratio = contrastRatio(
        parseCssColor(light["muted-foreground"]),
        parseCssColor(light["background"])
      );
      assert.ok(
        ratio >= 4.5,
        `Muted foreground on background contrast ratio ${ratio.toFixed(2)} is less than 4.5:1`
      );
    });

    it("guarantees muted-foreground meets normal text contrast (>= 4.5:1) on muted background", () => {
      const ratio = contrastRatio(
        parseCssColor(light["muted-foreground"]),
        parseCssColor(light["muted"])
      );
      assert.ok(
        ratio >= 4.5,
        `Muted foreground on muted background contrast ratio ${ratio.toFixed(2)} is less than 4.5:1`
      );
    });

    it("guarantees primary button text meets contrast (>= 4.5:1)", () => {
      const ratio = contrastRatio(
        parseCssColor(light["primary-foreground"]),
        parseCssColor(light["primary"])
      );
      assert.ok(
        ratio >= 4.5,
        `Primary button text contrast ratio ${ratio.toFixed(2)} is less than 4.5:1`
      );
    });

    it("guarantees secondary button text meets contrast (>= 4.5:1)", () => {
      const ratio = contrastRatio(
        parseCssColor(light["secondary-foreground"]),
        parseCssColor(light["secondary"])
      );
      assert.ok(
        ratio >= 4.5,
        `Secondary button text contrast ratio ${ratio.toFixed(2)} is less than 4.5:1`
      );
    });

    it("guarantees destructive action text meets contrast (>= 4.5:1) against background", () => {
      const ratio = contrastRatio(
        parseCssColor(light["destructive"]),
        parseCssColor(light["background"])
      );
      assert.ok(
        ratio >= 4.5,
        `Destructive text contrast ratio ${ratio.toFixed(2)} is less than 4.5:1`
      );
    });

    it("guarantees destructive button text meets contrast (>= 4.5:1) against destructive background", () => {
      const ratio = contrastRatio(
        parseCssColor(light["destructive-foreground"]),
        parseCssColor(light["destructive"])
      );
      assert.ok(
        ratio >= 4.5,
        `Destructive button text contrast ratio ${ratio.toFixed(2)} is less than 4.5:1`
      );
    });

    it("guarantees input boundary meets non-text contrast (>= 3:1) against white background", () => {
      const ratio = contrastRatio(
        parseCssColor(light["input"]),
        parseCssColor(light["background"])
      );
      assert.ok(
        ratio >= 3.0,
        `Input border contrast ratio ${ratio.toFixed(2)} is less than 3.0:1`
      );
    });

    it("guarantees solid focus ring meets non-text contrast (>= 3:1) against white background", () => {
      const ratio = contrastRatio(
        parseCssColor(light["ring"]),
        parseCssColor(light["background"])
      );
      assert.ok(
        ratio >= 3.0,
        `Focus ring contrast ratio ${ratio.toFixed(2)} is less than 3.0:1`
      );
    });
  });

  describe("Dark Theme Contrast Verification", () => {
    it("verifies dark foreground contrast (>= 4.5:1) against dark background", () => {
      const ratio = contrastRatio(
        parseCssColor(dark["foreground"]),
        parseCssColor(dark["background"])
      );
      assert.ok(
        ratio >= 4.5,
        `Dark foreground contrast ratio ${ratio.toFixed(2)} is less than 4.5:1`
      );
    });

    it("verifies dark muted-foreground contrast (>= 4.5:1) against dark background", () => {
      const ratio = contrastRatio(
        parseCssColor(dark["muted-foreground"]),
        parseCssColor(dark["background"])
      );
      assert.ok(
        ratio >= 4.5,
        `Dark muted foreground contrast ratio ${ratio.toFixed(2)} is less than 4.5:1`
      );
    });

    it("verifies dark primary button text contrast (>= 4.5:1)", () => {
      const ratio = contrastRatio(
        parseCssColor(dark["primary-foreground"]),
        parseCssColor(dark["primary"])
      );
      assert.ok(
        ratio >= 4.5,
        `Dark primary button text contrast ratio ${ratio.toFixed(2)} is less than 4.5:1`
      );
    });

    it("verifies dark destructive contrast (>= 4.5:1) against dark background", () => {
      const ratio = contrastRatio(
        parseCssColor(dark["destructive"]),
        parseCssColor(dark["background"])
      );
      assert.ok(
        ratio >= 4.5,
        `Dark destructive text contrast ratio ${ratio.toFixed(2)} is less than 4.5:1`
      );
    });

    it("verifies dark focus ring contrast (>= 3:1) against dark background", () => {
      const ratio = contrastRatio(
        parseCssColor(dark["ring"]),
        parseCssColor(dark["background"])
      );
      assert.ok(
        ratio >= 3.0,
        `Dark focus ring contrast ratio ${ratio.toFixed(2)} is less than 3.0:1`
      );
    });
  });
});
