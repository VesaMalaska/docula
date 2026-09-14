import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register custom resolver hook for Next.js path aliases and extensionless TS imports
const rootUrl = pathToFileURL(process.cwd() + "/").href;
const hookCode = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
        const target = new URL(specifier.slice(2), "${rootUrl}").href;
        try {
            return await nextResolve(target, context);
        } catch {
            return await nextResolve(target + ".ts", context);
        }
    }
    try {
        return await nextResolve(specifier, context);
    } catch (err) {
        if (specifier.startsWith(".") || specifier.startsWith("${rootUrl}")) {
            try {
                return await nextResolve(specifier + ".ts", context);
            } catch {}
        }
        throw err;
    }
}
`;
register("data:text/javascript," + encodeURIComponent(hookCode));

import test from "node:test";
import assert from "node:assert";

const { optimizeImage, ALLOWED_IMAGE_TYPES } = await import("../image-optimization");

test.describe("optimizeImage and image type policy", () => {
    test("defines exact allowed image types", () => {
        assert.deepStrictEqual(ALLOWED_IMAGE_TYPES, [
            "image/jpeg",
            "image/png",
            "image/gif",
            "image/webp",
        ]);
    });

    test("rejects non-image files with NOT_AN_IMAGE", async () => {
        const fakePdf = new File(["dummy content"], "doc.pdf", { type: "application/pdf" });
        await assert.rejects(
            optimizeImage(fakePdf),
            (err: Error) => err.message === "NOT_AN_IMAGE"
        );
    });

    test("rejects AVIF files even when file picker is bypassed", async () => {
        const fakeAvif = new File(["dummy avif content"], "image.avif", { type: "image/avif" });
        await assert.rejects(
            optimizeImage(fakeAvif),
            (err: Error) => err.message === "UNSUPPORTED_IMAGE_TYPE"
        );
    });

    test("rejects SVG files with UNSUPPORTED_IMAGE_TYPE", async () => {
        const fakeSvg = new File(["<svg></svg>"], "image.svg", { type: "image/svg+xml" });
        await assert.rejects(
            optimizeImage(fakeSvg),
            (err: Error) => err.message === "UNSUPPORTED_IMAGE_TYPE"
        );
    });
});
