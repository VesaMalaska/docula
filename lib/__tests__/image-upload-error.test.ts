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

const {
    classifyUploadError,
    handleClientUploadError,
    GENERIC_UPLOAD_ERROR_MESSAGE,
    INVALID_IMAGE_ERROR_MESSAGE,
    FILE_TOO_LARGE_ERROR_MESSAGE,
} = await import("../image-upload-error");

test.describe("classifyUploadError", () => {
    test.describe("safe validation failures preserve friendly messages", () => {
        test("maps UNSUPPORTED_IMAGE_TYPE code to friendly message", () => {
            const result = classifyUploadError("UNSUPPORTED_IMAGE_TYPE");
            assert.deepStrictEqual(result, {
                title: "Invalid Image",
                message: INVALID_IMAGE_ERROR_MESSAGE,
            });
            assert.strictEqual(result.message, "Please upload a valid image file (JPEG, PNG, GIF, WebP).");
        });

        test("maps NOT_AN_IMAGE code to friendly message", () => {
            const result = classifyUploadError("NOT_AN_IMAGE");
            assert.deepStrictEqual(result, {
                title: "Invalid Image",
                message: INVALID_IMAGE_ERROR_MESSAGE,
            });
        });

        test("maps Failed to load image code to friendly message", () => {
            const result = classifyUploadError("Failed to load image");
            assert.deepStrictEqual(result, {
                title: "Invalid Image",
                message: INVALID_IMAGE_ERROR_MESSAGE,
            });
        });

        test("maps Unsupported file type and Unsupported source file type", () => {
            assert.deepStrictEqual(classifyUploadError("Unsupported file type"), {
                title: "Invalid Image",
                message: INVALID_IMAGE_ERROR_MESSAGE,
            });
            assert.deepStrictEqual(classifyUploadError("Unsupported source file type"), {
                title: "Invalid Image",
                message: INVALID_IMAGE_ERROR_MESSAGE,
            });
        });

        test("maps Error instance wrapping validation failure", () => {
            const result = classifyUploadError(new Error("UNSUPPORTED_IMAGE_TYPE"));
            assert.deepStrictEqual(result, {
                title: "Invalid Image",
                message: INVALID_IMAGE_ERROR_MESSAGE,
            });
        });

        test("maps FILE_TOO_LARGE code and Error to friendly size message", () => {
            const fromString = classifyUploadError("FILE_TOO_LARGE");
            assert.deepStrictEqual(fromString, {
                title: "File too large",
                message: FILE_TOO_LARGE_ERROR_MESSAGE,
            });
            assert.strictEqual(fromString.message, "Image must be under 5MB.");

            const fromError = classifyUploadError(new Error("FILE_TOO_LARGE"));
            assert.deepStrictEqual(fromError, {
                title: "File too large",
                message: FILE_TOO_LARGE_ERROR_MESSAGE,
            });

            const fromText = classifyUploadError(new Error("File too large"));
            assert.deepStrictEqual(fromText, {
                title: "File too large",
                message: FILE_TOO_LARGE_ERROR_MESSAGE,
            });
        });
    });

    test.describe("internal configuration and environment errors are suppressed", () => {
        test("suppresses AWS_BUCKET_NAME is not configured", () => {
            const result = classifyUploadError(new Error("AWS_BUCKET_NAME is not configured"));
            assert.deepStrictEqual(result, {
                title: "Upload Failed",
                message: GENERIC_UPLOAD_ERROR_MESSAGE,
            });
            assert.strictEqual(result.message, "Image upload failed. Please try again.");
            assert.doesNotMatch(result.message, /AWS_BUCKET_NAME/);
            assert.doesNotMatch(result.title, /AWS_BUCKET_NAME/);
        });

        test("suppresses missing AWS credential environment variables", () => {
            const errors = [
                new Error("AWS_ACCESS_KEY_ID is missing"),
                new Error("AWS_SECRET_ACCESS_KEY is undefined"),
                new Error("AWS_REGION is not configured"),
            ];
            for (const err of errors) {
                const result = classifyUploadError(err);
                assert.deepStrictEqual(result, {
                    title: "Upload Failed",
                    message: GENERIC_UPLOAD_ERROR_MESSAGE,
                });
                assert.doesNotMatch(result.message, /AWS/);
            }
        });
    });

    test.describe("AWS SDK, Firebase, authorization, and network errors are suppressed", () => {
        test("suppresses S3 permission and access errors containing bucket and ARN names", () => {
            const sensitiveError = new Error(
                "AccessDenied: User arn:aws:iam::123456789012:user/deploy is not authorized to perform: s3:PutObject on resource: arn:aws:s3:::company-secret-bucket/temp/space-123/doc-456/uuid.png"
            );
            const result = classifyUploadError(sensitiveError);
            assert.deepStrictEqual(result, {
                title: "Upload Failed",
                message: GENERIC_UPLOAD_ERROR_MESSAGE,
            });
            assert.strictEqual(result.message.includes("company-secret-bucket"), false);
            assert.strictEqual(result.message.includes("arn:aws"), false);
            assert.strictEqual(result.message.includes("AccessDenied"), false);
        });

        test("suppresses AWS signature and credential leakage", () => {
            const signatureError = new Error(
                "SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided. Check your key AKIAIOSFODNN7EXAMPLE and signing method. Signature=d6c35c2250..."
            );
            const result = classifyUploadError(signatureError);
            assert.deepStrictEqual(result, {
                title: "Upload Failed",
                message: GENERIC_UPLOAD_ERROR_MESSAGE,
            });
            assert.strictEqual(result.message.includes("AKIAIOSFODNN7EXAMPLE"), false);
            assert.strictEqual(result.message.includes("Signature"), false);
        });

        test("suppresses presigned URL and query parameter leakage", () => {
            const urlError = new Error(
                "Failed to fetch https://my-bucket.s3.us-east-1.amazonaws.com/?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=abcd1234efgh"
            );
            const result = classifyUploadError(urlError);
            assert.deepStrictEqual(result, {
                title: "Upload Failed",
                message: GENERIC_UPLOAD_ERROR_MESSAGE,
            });
            assert.strictEqual(result.message.includes("X-Amz"), false);
            assert.strictEqual(result.message.includes("amazonaws.com"), false);
        });

        test("suppresses Firebase token and authorization details", () => {
            const authErrors = [
                new Error("Token verification failed: Firebase ID token has expired"),
                new Error("Must be an active member of the space to perform this action"),
                new Error("Permission denied: unowned temporary key"),
                new Error("Permission denied: key does not belong to this document"),
                new Error("Document not found or does not belong to space"),
            ];
            for (const err of authErrors) {
                const result = classifyUploadError(err);
                assert.deepStrictEqual(result, {
                    title: "Upload Failed",
                    message: GENERIC_UPLOAD_ERROR_MESSAGE,
                });
                assert.strictEqual(result.message, GENERIC_UPLOAD_ERROR_MESSAGE);
            }
        });

        test("suppresses network and HTTP error details", () => {
            const networkErrors = [
                new TypeError("Failed to fetch"),
                new Error("NetworkError when attempting to fetch resource."),
                new Error("Upload failed with status: 403"),
                new Error("Upload failed with status: 500"),
                new Error("CORS request did not succeed"),
            ];
            for (const err of networkErrors) {
                const result = classifyUploadError(err);
                assert.deepStrictEqual(result, {
                    title: "Upload Failed",
                    message: GENERIC_UPLOAD_ERROR_MESSAGE,
                });
            }
        });

        test("safely handles non-Error objects and primitives without crashing", () => {
            assert.deepStrictEqual(classifyUploadError(null), {
                title: "Upload Failed",
                message: GENERIC_UPLOAD_ERROR_MESSAGE,
            });
            assert.deepStrictEqual(classifyUploadError(undefined), {
                title: "Upload Failed",
                message: GENERIC_UPLOAD_ERROR_MESSAGE,
            });
            assert.deepStrictEqual(classifyUploadError({ status: 500, detail: "secret" }), {
                title: "Upload Failed",
                message: GENERIC_UPLOAD_ERROR_MESSAGE,
            });
            assert.deepStrictEqual(classifyUploadError(404), {
                title: "Upload Failed",
                message: GENERIC_UPLOAD_ERROR_MESSAGE,
            });
        });
    });

    test.describe("client-side error handling and console output suppression", () => {
        let alertCalls: Array<{ title: string; message: string }>;
        let consoleCalls: Array<{ method: string; args: unknown[] }>;
        let origConsoleError: typeof console.error;
        let origConsoleWarn: typeof console.warn;
        let origConsoleLog: typeof console.log;

        const captureAlert = (title: string, message: string) => {
            alertCalls.push({ title, message });
        };

        test.beforeEach(() => {
            alertCalls = [];
            consoleCalls = [];
            origConsoleError = console.error;
            origConsoleWarn = console.warn;
            origConsoleLog = console.log;

            console.error = (...args: unknown[]) => {
                consoleCalls.push({ method: "error", args });
            };
            console.warn = (...args: unknown[]) => {
                consoleCalls.push({ method: "warn", args });
            };
            console.log = (...args: unknown[]) => {
                consoleCalls.push({ method: "log", args });
            };
        });

        test.afterEach(() => {
            console.error = origConsoleError;
            console.warn = origConsoleWarn;
            console.log = origConsoleLog;
        });

        test("proves 'AWS_BUCKET_NAME is not configured' appears in neither alert nor console", () => {
            const err = new Error("AWS_BUCKET_NAME is not configured");
            handleClientUploadError(err, captureAlert);

            // User-facing alert verification
            assert.strictEqual(alertCalls.length, 1);
            assert.deepStrictEqual(alertCalls[0], {
                title: "Upload Failed",
                message: GENERIC_UPLOAD_ERROR_MESSAGE,
            });
            assert.strictEqual(alertCalls[0].message.includes("AWS_BUCKET_NAME"), false);
            assert.strictEqual(alertCalls[0].title.includes("AWS_BUCKET_NAME"), false);

            // Console output verification
            const allConsoleOutput = consoleCalls
                .map((c) => c.args.map((a) => String(a)).join(" "))
                .join("\n");
            assert.strictEqual(allConsoleOutput.includes("AWS_BUCKET_NAME"), false);
            assert.strictEqual(allConsoleOutput.includes("configured"), false);
            assert.strictEqual(consoleCalls.length, 0);
        });

        test("proves sensitive error with bucket URL and X-Amz-Signature appears in neither alert nor console", () => {
            const sensitiveMockError = new Error(
                "Failed to upload to https://my-production-bucket.s3.us-east-1.amazonaws.com/uploads/doc1/image.png?X-Amz-Signature=d6c35c22501234567890abcdef&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE"
            );
            handleClientUploadError(sensitiveMockError, captureAlert);

            // User-facing alert verification
            assert.strictEqual(alertCalls.length, 1);
            assert.deepStrictEqual(alertCalls[0], {
                title: "Upload Failed",
                message: GENERIC_UPLOAD_ERROR_MESSAGE,
            });

            const alertText = `${alertCalls[0].title} ${alertCalls[0].message}`;
            assert.strictEqual(alertText.includes("my-production-bucket"), false);
            assert.strictEqual(alertText.includes("s3.us-east-1.amazonaws.com"), false);
            assert.strictEqual(alertText.includes("X-Amz-Signature"), false);
            assert.strictEqual(alertText.includes("X-Amz-Credential"), false);
            assert.strictEqual(alertText.includes("AKIAIOSFODNN7EXAMPLE"), false);
            assert.strictEqual(alertText.includes("d6c35c22501234567890abcdef"), false);

            // Console output verification
            const allConsoleOutput = consoleCalls
                .map((c) => c.args.map((a) => String(a)).join(" "))
                .join("\n");
            assert.strictEqual(allConsoleOutput.includes("my-production-bucket"), false);
            assert.strictEqual(allConsoleOutput.includes("amazonaws.com"), false);
            assert.strictEqual(allConsoleOutput.includes("X-Amz-Signature"), false);
            assert.strictEqual(allConsoleOutput.includes("X-Amz-Credential"), false);
            assert.strictEqual(allConsoleOutput.includes("AKIAIOSFODNN7EXAMPLE"), false);
            assert.strictEqual(allConsoleOutput.includes("d6c35c22501234567890abcdef"), false);
            assert.strictEqual(consoleCalls.length, 0);
        });
    });
});
