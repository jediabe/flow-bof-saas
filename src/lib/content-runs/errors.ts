export type ContentRunCreationErrorCode =
  | "INVALID_REQUEST"
  | "PRODUCT_NOT_FOUND"
  | "PRODUCT_DELETED"
  | "PRODUCT_NOT_APPROVED"
  | "PRIMARY_REFERENCE_REQUIRED"
  | "FLOW_ACCOUNT_REQUIRED"
  | "INVALID_FLOW_MODEL"
  | "INVALID_PRODUCT_CONTEXT"
  | "IDEMPOTENCY_CONFLICT";

/** Stable, non-provider-facing failures returned by ContentRun creation. */
export class ContentRunCreationError extends Error {
  readonly name = "ContentRunCreationError";

  constructor(
    readonly code: ContentRunCreationErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, string>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
