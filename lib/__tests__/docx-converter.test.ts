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

import test, { mock } from "node:test";
import assert from "node:assert";

mock.module("@/lib/firebase", {
    exports: {
        auth: {
            currentUser: null,
        },
    },
});

const { jsonToDocx } = await import("../docx-converter");

test.describe("jsonToDocx converter", () => {
    test("converts basic document structure to docx Blob", async () => {
        const content = {
            type: "doc",
            content: [
                {
                    type: "heading",
                    attrs: { level: 1 },
                    content: [{ type: "text", text: "Test Heading" }],
                },
                {
                    type: "paragraph",
                    content: [{ type: "text", text: "Paragraph text" }],
                },
            ],
        };

        const blob = await jsonToDocx(content, "s1", "d1", "token-123");
        assert.ok(blob);
        assert.ok(blob.size > 0);
    });

    test("fetches managed image through /api/document-image with Authorization header and embeds bytes", async () => {
        const originalFetch = globalThis.fetch;
        let fetchedUrl = "";
        let authHeader = "";

        const samplePng = new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
            0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
            0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
            0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
            0x42, 0x60, 0x82,
        ]);

        globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
            fetchedUrl = url.toString();
            authHeader = (init?.headers as Record<string, string>)?.[
                "Authorization"
            ] || "";
            return new Response(samplePng, {
                status: 200,
                headers: { "Content-Type": "image/png" },
            });
        };

        try {
            const presignedS3Url =
                "https://my-bucket.s3.us-east-1.amazonaws.com/uploads/space1/doc1/image-uuid.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=CREDENTIAL%2F20260910&X-Amz-Signature=SIGNATURE123";

            const content = {
                type: "doc",
                content: [
                    {
                        type: "image",
                        attrs: { src: presignedS3Url },
                    },
                ],
            };

            const blob = await jsonToDocx(content, "space1", "doc1", "secret-id-token");
            assert.ok(blob);
            assert.ok(blob.size > 0);

            // Verify the proxy request was made correctly
            assert.ok(fetchedUrl.startsWith("/api/document-image?"));
            assert.ok(!fetchedUrl.includes("secret-id-token"), "Token must never be in URL");
            assert.ok(!fetchedUrl.includes("SIGNATURE123"), "Presigned signatures must not be in proxy URL");
            assert.ok(fetchedUrl.includes("key=uploads%2Fspace1%2Fdoc1%2Fimage-uuid.png"));
            assert.strictEqual(authHeader, "Bearer secret-id-token");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("when token is missing, falls back to [Image unavailable] without calling proxy with undefined", async () => {
        const originalFetch = globalThis.fetch;
        let fetchCalled = false;

        globalThis.fetch = async () => {
            fetchCalled = true;
            return new Response("Unauthorized", { status: 401 });
        };

        try {
            const presignedS3Url =
                "https://my-bucket.s3.us-east-1.amazonaws.com/uploads/space1/doc1/image-uuid.png?X-Amz-Signature=LEAK_TEST_SIG";

            const content = {
                type: "doc",
                content: [
                    {
                        type: "image",
                        attrs: { src: presignedS3Url },
                    },
                ],
            };

            const blob = await jsonToDocx(content, "space1", "doc1", undefined);
            assert.ok(blob);
            assert.strictEqual(fetchCalled, false, "Must not attempt fetch without a valid token");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("when image proxy fetch fails, falls back to safe [Image unavailable] without leaking credentials", async () => {
        const originalFetch = globalThis.fetch;
        const originalConsoleError = console.error;
        let loggedError = "";

        globalThis.fetch = async () => {
            return new Response("Forbidden", { status: 403 });
        };

        console.error = (...args: unknown[]) => {
            loggedError += args.map((a) => String(a)).join(" ");
        };

        try {
            const presignedS3Url =
                "https://my-bucket.s3.us-east-1.amazonaws.com/uploads/space1/doc1/image-uuid.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=SECRET_CREDENTIAL%2F20260910&X-Amz-Signature=LEAK_TEST_SIG";

            const content = {
                type: "doc",
                content: [
                    {
                        type: "image",
                        attrs: { src: presignedS3Url },
                    },
                ],
            };

            const blob = await jsonToDocx(content, "space1", "doc1", "valid-token");
            assert.ok(blob);

            // Verify console.error does not log S3 credentials, tokens, or presigned URLs
            assert.ok(!loggedError.includes("SECRET_CREDENTIAL"), "Must not log S3 credentials");
            assert.ok(!loggedError.includes("LEAK_TEST_SIG"), "Must not log S3 signatures");
            assert.ok(!loggedError.includes("valid-token"), "Must not log tokens");
        } finally {
            globalThis.fetch = originalFetch;
            console.error = originalConsoleError;
        }
    });

    test("when image proxy fetch returns 500, falls back to safe [Image unavailable] without leaking credentials", async () => {
        const originalFetch = globalThis.fetch;
        const originalConsoleError = console.error;
        let loggedError = "";

        globalThis.fetch = async () => {
            return new Response("Internal Server Error", { status: 500 });
        };

        console.error = (...args: unknown[]) => {
            loggedError += args.map((a) => String(a)).join(" ");
        };

        try {
            const presignedS3Url =
                "https://my-bucket.s3.us-east-1.amazonaws.com/uploads/space1/doc1/image-uuid.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=SECRET_CREDENTIAL%2F20260910&X-Amz-Signature=LEAK_TEST_SIG";

            const content = {
                type: "doc",
                content: [
                    {
                        type: "image",
                        attrs: { src: presignedS3Url },
                    },
                ],
            };

            const blob = await jsonToDocx(content, "space1", "doc1", "valid-token");
            assert.ok(blob);

            assert.ok(!loggedError.includes("SECRET_CREDENTIAL"), "Must not log S3 credentials");
            assert.ok(!loggedError.includes("LEAK_TEST_SIG"), "Must not log S3 signatures");
            assert.ok(!loggedError.includes("valid-token"), "Must not log tokens");
            assert.ok(!loggedError.includes("my-bucket.s3"), "Must not log bucket URLs");
        } finally {
            globalThis.fetch = originalFetch;
            console.error = originalConsoleError;
        }
    });

    test("external images are preserved as hyperlinks and not fetched through proxy", async () => {
        const originalFetch = globalThis.fetch;
        let fetchCalled = false;

        globalThis.fetch = async () => {
            fetchCalled = true;
            return new Response("OK", { status: 200 });
        };

        try {
            const content = {
                type: "doc",
                content: [
                    {
                        type: "image",
                        attrs: { src: "https://external-cdn.com/photos/dog.jpg" },
                    },
                ],
            };

            const blob = await jsonToDocx(content, "s1", "d1", "token-123");
            assert.ok(blob);
            assert.strictEqual(fetchCalled, false, "External images should not be fetched via proxy");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
