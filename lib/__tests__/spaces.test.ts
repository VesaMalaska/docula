import { describe, it } from "node:test";
import assert from "node:assert";
import { validateSpaceName } from "../space-validation.ts";

describe("Space name validation and trimming policy", () => {
  it("accepts a normal valid space name", () => {
    const result = validateSpaceName("Product Notes");
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.trimmedName, "Product Notes");
    assert.strictEqual(result.error, undefined);
  });

  it("trims leading and trailing whitespace from space name", () => {
    const result = validateSpaceName("   Product Notes   ");
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.trimmedName, "Product Notes");
  });

  it("preserves internal whitespace inside the space name", () => {
    const result = validateSpaceName("  Engineering &  Product  ");
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.trimmedName, "Engineering &  Product");
  });

  it("rejects an empty string", () => {
    const result = validateSpaceName("");
    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.trimmedName, "");
    assert.strictEqual(typeof result.error, "string");
    assert.match(result.error || "", /cannot be empty/i);
  });

  it("rejects whitespace-only names", () => {
    const result1 = validateSpaceName("   ");
    assert.strictEqual(result1.isValid, false);
    assert.strictEqual(result1.trimmedName, "");
    assert.match(result1.error || "", /cannot be empty/i);

    const result2 = validateSpaceName(" \t \n \r ");
    assert.strictEqual(result2.isValid, false);
    assert.strictEqual(result2.trimmedName, "");
    assert.match(result2.error || "", /cannot be empty/i);
  });

  it("identifies unchanged names accurately after trimming", () => {
    const currentName = "Project Notes";
    const sameInput = "   Project Notes   ";
    const validation = validateSpaceName(sameInput);
    assert.strictEqual(validation.isValid, true);
    assert.strictEqual(validation.trimmedName === currentName, true);

    const differentInput = "   Product Notes   ";
    const diffValidation = validateSpaceName(differentInput);
    assert.strictEqual(diffValidation.isValid, true);
    assert.strictEqual(diffValidation.trimmedName === currentName, false);
  });
});
