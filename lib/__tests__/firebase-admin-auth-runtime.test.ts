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

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// Mock server-only so importing real server modules works in the test environment
mock.module("server-only", { exports: {} });

describe("Firebase Admin Auth Runtime Module Loading (Regression Check)", () => {
    it("loads firebase-admin/auth directly without ERR_REQUIRE_ESM", async () => {
        // This directly imports the real firebase-admin/auth module without mocks
        const authModule = await import("firebase-admin/auth");
        assert.ok(authModule, "firebase-admin/auth module must be defined");
        assert.equal(typeof authModule.getAuth, "function", "getAuth must be a function");
    });

    it("loads real lib/server/firebase-admin module and handles unconfigured environment safely", async () => {
        // Imports the production server module without mocking ../server/firebase-admin
        const serverAdmin = await import("../server/firebase-admin");
        assert.equal(typeof serverAdmin.getAdminAuth, "function");
        assert.equal(typeof serverAdmin.getAdminFirestore, "function");

        // When environment variables are not configured, it should fail closed cleanly,
        // never throwing ERR_REQUIRE_ESM
        assert.throws(
            () => serverAdmin.getAdminAuth(),
            (err: Error) => {
                assert.equal(err.message, "Firebase Admin is not configured");
                return true;
            }
        );
    });

    it("executes verifyIdToken from lib/server/document-authorization without module-load errors", async () => {
        const { verifyIdToken } = await import("../server/document-authorization");
        assert.equal(typeof verifyIdToken, "function");

        // Missing token check should reject with "Missing ID token"
        await assert.rejects(
            async () => {
                await verifyIdToken(undefined);
            },
            {
                name: "Error",
                message: "Missing ID token",
            }
        );

        // Invalid token with unconfigured admin should reject with "Invalid or expired ID token",
        // never crashing with ERR_REQUIRE_ESM during auth verification
        await assert.rejects(
            async () => {
                await verifyIdToken("mock-token-sample");
            },
            {
                name: "Error",
                message: "Invalid or expired ID token",
            }
        );
    });

    it("verifies jwks-rsa resolves to CommonJS jose rather than pure-ESM jose v6", async () => {
        // In pnpm, jwks-rsa is a transitive dependency of firebase-admin.
        // We require it from firebase-admin to replicate firebase-admin's exact runtime resolution.
        const { createRequire } = await import("node:module");
        const appRequire = createRequire(import.meta.url);
        const firebaseAdminRequire = createRequire(appRequire.resolve("firebase-admin"));

        let jwksClient: unknown;
        assert.doesNotThrow(() => {
            jwksClient = firebaseAdminRequire("jwks-rsa");
        }, "Requiring jwks-rsa from CommonJS must not throw ERR_REQUIRE_ESM");

        assert.equal(typeof jwksClient, "function", "jwks-rsa should export factory function");

        // Verify the resolved jose under jwks-rsa is CommonJS-compatible
        const jwksUtilsPath = firebaseAdminRequire.resolve("jwks-rsa");
        const jwksRequire = createRequire(jwksUtilsPath);
        const resolvedJose = jwksRequire("jose");
        assert.ok(resolvedJose, "jose resolved under jwks-rsa must be loadable via require()");
        assert.equal(typeof resolvedJose.importJWK, "function", "jose must export importJWK");
        assert.equal(typeof resolvedJose.exportSPKI, "function", "jose must export exportSPKI");
        assert.equal(typeof resolvedJose.decodeJwt, "function", "jose must export decodeJwt");
        assert.equal(typeof resolvedJose.decodeProtectedHeader, "function", "jose must export decodeProtectedHeader");

        // Verify jwksClient factory constructs a working client instance
        const client = (jwksClient as (options: { jwksUri: string }) => { getSigningKey: unknown })({
            jwksUri: "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
        });
        assert.ok(client, "jwks-rsa client instance should be instantiated");
        assert.equal(typeof client.getSigningKey, "function", "jwks client must provide getSigningKey function");
    });
});
