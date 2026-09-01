import { describe, expect, it, vi } from "vitest";

import { ApexFlowAdapterError } from "../apex-flow-adapter";
import { executeWithTechnicalRetries } from "../technical-retry";

function retryable(acceptedProviderIdentity = false): ApexFlowAdapterError {
  return new ApexFlowAdapterError(
    "temporary network failure",
    "technical-retryable",
    "transport_failure",
    acceptedProviderIdentity,
  );
}

function terminal(): ApexFlowAdapterError {
  return new ApexFlowAdapterError(
    "provider rejected content",
    "terminal-nontechnical",
    "provider_failure",
    false,
  );
}

describe("executeWithTechnicalRetries", () => {
  it("performs the initial call plus at most two safe retries", async () => {
    const execute = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(retryable())
      .mockRejectedValueOnce(retryable())
      .mockResolvedValueOnce("ok");
    const attempts: number[] = [];

    await expect(
      executeWithTechnicalRetries({
        operation: { providerJobId: null, technicalAttemptCount: 0 },
        execute,
        onAttempt: async (attemptNumber) => {
          attempts.push(attemptNumber);
        },
      }),
    ).resolves.toBe("ok");

    expect(execute).toHaveBeenCalledTimes(3);
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("stops after three failed transport attempts", async () => {
    const failure = retryable();
    const execute = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(
      executeWithTechnicalRetries({
        operation: { providerJobId: null, technicalAttemptCount: 0 },
        execute,
      }),
    ).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("does not retry terminal provider errors", async () => {
    const failure = terminal();
    const execute = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(
      executeWithTechnicalRetries({
        operation: { providerJobId: null, technicalAttemptCount: 0 },
        execute,
      }),
    ).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the failed call accepted a provider identity", async () => {
    const failure = retryable(true);
    const execute = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(
      executeWithTechnicalRetries({
        operation: { providerJobId: null, technicalAttemptCount: 0 },
        execute,
      }),
    ).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("disables provider start when a job ID is already known", async () => {
    const execute = vi.fn<() => Promise<string>>().mockResolvedValue("unsafe");

    await expect(
      executeWithTechnicalRetries({
        operation: { providerJobId: "job-accepted", technicalAttemptCount: 1 },
        execute,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_JOB_ALREADY_ACCEPTED",
      details: { providerJobId: "job-accepted" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("continues a retry budget from the persisted attempt count", async () => {
    const failure = retryable();
    const execute = vi.fn<() => Promise<never>>().mockRejectedValue(failure);
    const attempts: number[] = [];

    await expect(
      executeWithTechnicalRetries({
        operation: { providerJobId: null, technicalAttemptCount: 2 },
        execute,
        onAttempt: async (attemptNumber) => {
          attempts.push(attemptNumber);
        },
      }),
    ).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual([3]);
  });
});
