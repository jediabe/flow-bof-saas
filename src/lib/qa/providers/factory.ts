/**
 * Visual-QA provider factory.
 *
 * Takes a ResolvedCredential (from resolveLlmCredential — the
 * same chain the chat agent uses) and returns the appropriate
 * VisualQaProvider implementation:
 *
 *   apiShape             | provider
 *   ---------------------+---------------------------------
 *   "responses"          | createOpenAiResponsesVisualQaProvider
 *                        |   (Codex Responses / ChatGPT OAuth)
 *   "chat_completions"   | createOpenAiChatCompletionsVisualQaProvider
 *                        |   (OpenAI SDK, user_key or app_key)
 *   "anthropic_messages" | createAnthropicVisualQaProvider
 *                        |   (Anthropic SDK, user_key or app_key)
 *
 * Result: QA uses whichever LLM the workspace owner has
 * configured, without QA needing to duplicate the credential-
 * discovery logic.
 *
 * `authHeader` is a full HTTP header value ("Bearer <token>").
 * The two SDK-based providers need the raw token, so we split
 * "Bearer <token>" here rather than in each provider.
 */

import type { ResolvedCredential } from "@/lib/llm/credentials";
import type { VisualQaProvider } from "../visual-qa-provider";
import { createOpenAiResponsesVisualQaProvider } from "./openai-responses-visual-qa";
import { createOpenAiChatCompletionsVisualQaProvider } from "./openai-chat-completions-visual-qa";
import { createAnthropicVisualQaProvider } from "./anthropic-visual-qa";

export interface CreateVisualQaProviderInput {
  cred: ResolvedCredential;
  /** Optional model override. Falls back to provider-specific
   *  defaults (Codex → gpt-5.6-sol, OpenAI Chat → gpt-4o-mini,
   *  Anthropic → claude-3-5-sonnet-latest). */
  model?: string;
}

export function createVisualQaProviderFromCredential(
  input: CreateVisualQaProviderInput,
): VisualQaProvider {
  const { cred, model } = input;
  switch (cred.apiShape) {
    case "responses":
      return createOpenAiResponsesVisualQaProvider({
        cred,
        ...(model ? { model } : {}),
      });
    case "chat_completions": {
      const apiKey = extractBearerToken(cred.authHeader);
      return createOpenAiChatCompletionsVisualQaProvider({
        apiKey,
        ...(model ? { model } : {}),
      });
    }
    case "anthropic_messages": {
      const apiKey = extractBearerToken(cred.authHeader);
      return createAnthropicVisualQaProvider({
        apiKey,
        ...(model ? { model } : {}),
      });
    }
  }
}

/**
 * ResolvedCredential.authHeader is a full HTTP header value
 * ("Bearer <token>"). The SDK-based providers construct their
 * own Authorization header from the raw key. Split defensively —
 * if the shape ever changes we surface an obvious error rather
 * than silently sending a malformed key.
 */
function extractBearerToken(authHeader: string): string {
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) {
    throw new Error(
      `Expected ResolvedCredential.authHeader to start with "Bearer "; got "${authHeader.slice(0, 20)}…"`,
    );
  }
  return authHeader.slice(prefix.length).trim();
}
