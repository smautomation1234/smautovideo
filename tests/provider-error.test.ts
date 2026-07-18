import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProviderError,
  ProviderHttpError,
} from "../src/lib/provider-error";

test("classifies Google safety messages and support codes as policy errors", () => {
  const result = classifyProviderError(
    new ProviderHttpError(
      400,
      "The prompt couldn't be submitted; it might violate our policies. Support codes: 42237218"
    )
  );
  assert.equal(result.category, "policy");
  assert.equal(result.retryable, false);
  assert.deepEqual(result.supportCodes, ["42237218"]);
});

test("quota and temporary provider failures remain retryable", () => {
  assert.equal(
    classifyProviderError(new ProviderHttpError(429, "RESOURCE_EXHAUSTED")).category,
    "quota"
  );
  assert.equal(
    classifyProviderError(new ProviderHttpError(503, "Unavailable")).retryable,
    true
  );
});

