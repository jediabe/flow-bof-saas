import { describe, expect, it } from "vitest";

import { ContentGenerationError } from "../types";

describe("ContentGenerationError", () => {
  it("preserves a stable machine code and structured non-secret details", () => {
    const error = new ContentGenerationError(
      "WORKSPACE_PROVIDER_BUSY",
      "Another provider operation is active",
      { operationId: "op-active", contentRunId: "run-active" },
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ContentGenerationError");
    expect(error.code).toBe("WORKSPACE_PROVIDER_BUSY");
    expect(error.details).toEqual({
      operationId: "op-active",
      contentRunId: "run-active",
    });
  });
});
