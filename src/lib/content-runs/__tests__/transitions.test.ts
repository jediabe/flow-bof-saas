import { describe, expect, it, vi } from "vitest";
import {
  ConcurrentContentRunTransitionError,
  IllegalContentRunTransitionError,
  isContentRunTransitionAllowed,
  transitionContentRun,
} from "../transitions";

describe("content run transitions", () => {
  it("accepts every frozen V1 transition", () => {
    const allowed = [
      ["created", "generating"],
      ["created", "cancelled"],
      ["generating", "qa_running"],
      ["generating", "failed"],
      ["generating", "cancelled"],
      ["qa_running", "generating"],
      ["qa_running", "human_review"],
      ["qa_running", "ready"],
      ["qa_running", "failed"],
      ["qa_running", "cancelled"],
    ] as const;

    for (const [from, to] of allowed) {
      expect(isContentRunTransitionAllowed(from, to)).toBe(true);
    }
  });

  it("rejects illegal and terminal-state transitions before writing", async () => {
    const updateMany = vi.fn();

    await expect(
      transitionContentRun(
        { runId: "run-1", from: "created", to: "ready" },
        { updateMany },
      ),
    ).rejects.toBeInstanceOf(IllegalContentRunTransitionError);
    await expect(
      transitionContentRun(
        { runId: "run-1", from: "ready", to: "generating" },
        { updateMany },
      ),
    ).rejects.toMatchObject({
      code: "ILLEGAL_CONTENT_RUN_TRANSITION",
      from: "ready",
      to: "generating",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("persists an allowed transition with a compare-and-set write", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await transitionContentRun(
      { runId: "run-1", from: "generating", to: "qa_running" },
      { updateMany },
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", status: "generating" },
      data: { status: "qa_running" },
    });
  });

  it("reports a concurrent state change when compare-and-set writes nothing", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });

    await expect(
      transitionContentRun(
        { runId: "run-1", from: "generating", to: "failed" },
        { updateMany },
      ),
    ).rejects.toBeInstanceOf(ConcurrentContentRunTransitionError);
  });

  it("sets completedAt only when entering ready", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await transitionContentRun(
      { runId: "run-1", from: "qa_running", to: "ready" },
      { updateMany },
    );

    const write = updateMany.mock.calls[0][0];
    expect(write.data.status).toBe("ready");
    expect(write.data.completedAt).toBeInstanceOf(Date);
  });
});
