import { describe, it, expect } from "vitest";
import { createVisualQaProviderFromCredential } from "../providers/factory";
import type { ResolvedCredential } from "@/lib/llm/credentials";

// The factory itself is a pure dispatcher — this suite pins the
// apiShape → provider mapping so a future refactor that
// accidentally routes a shape to the wrong constructor gets
// caught fast. Each provider construction validates its own
// inputs (rejects empty apiKey, rejects wrong apiShape, etc.),
// so we exercise via the factory to check both routing + prop
// passthrough.

function cred(overrides: Partial<ResolvedCredential> = {}): ResolvedCredential {
  return {
    mode: "user_key",
    provider: "openai",
    endpoint: "https://api.example.test/v1/foo",
    authHeader: "Bearer sk-test-abc",
    extraHeaders: {},
    apiShape: "chat_completions",
    ...overrides,
  };
}

describe("createVisualQaProviderFromCredential — dispatch", () => {
  it("routes apiShape=chat_completions to the OpenAI Chat Completions provider", () => {
    const p = createVisualQaProviderFromCredential({ cred: cred() });
    expect(p.identifier).toMatch(/^openai-chat:/);
  });

  it("routes apiShape=responses to the Codex Responses provider", () => {
    const p = createVisualQaProviderFromCredential({
      cred: cred({
        mode: "user_oauth",
        apiShape: "responses",
        endpoint: "https://chatgpt.example.test/backend-api/codex/responses",
        extraHeaders: { "chatgpt-account-id": "acct-1" },
      }),
    });
    expect(p.identifier).toMatch(/^openai-responses:/);
  });

  it("routes apiShape=anthropic_messages to the Anthropic provider", () => {
    const p = createVisualQaProviderFromCredential({
      cred: cred({
        provider: "anthropic",
        apiShape: "anthropic_messages",
        authHeader: "Bearer sk-ant-test",
        endpoint: "https://api.anthropic.example.test/v1/messages",
        extraHeaders: { "anthropic-version": "2023-06-01", "x-api-key": "sk-ant-test" },
      }),
    });
    expect(p.identifier).toMatch(/^anthropic:/);
  });

  it("passes through an explicit model override to the provider identifier", () => {
    const p = createVisualQaProviderFromCredential({
      cred: cred(),
      model: "custom-vision-1",
    });
    expect(p.identifier).toBe("openai-chat:custom-vision-1");
  });

  it("throws when authHeader doesn't start with 'Bearer '", () => {
    expect(() =>
      createVisualQaProviderFromCredential({
        cred: cred({ authHeader: "Token sk-test" }),
      }),
    ).toThrow(/Bearer/);
  });

  it("Anthropic path also validates the Bearer prefix", () => {
    expect(() =>
      createVisualQaProviderFromCredential({
        cred: cred({
          provider: "anthropic",
          apiShape: "anthropic_messages",
          authHeader: "Basic sk-ant-test",
        }),
      }),
    ).toThrow(/Bearer/);
  });
});
