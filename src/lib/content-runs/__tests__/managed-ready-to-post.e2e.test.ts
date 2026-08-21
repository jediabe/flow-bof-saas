import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  disposeReadyToPostHarness,
  persistReadyToPostSmokeEvidence,
  runReadyToPostFailureScenario,
  runReadyToPostScenario,
  type AcceptanceStyle,
} from "./fixtures/ready-to-post-harness";
import type { AssemblyManifest } from "@/lib/content-runs/types";

const HAPPY_PATHS: Array<{
  input: AcceptanceStyle;
  images: number;
  videos: number;
  durationSeconds: number;
  nativeAudioMode: "duck" | "mute";
}> = [
  { input: { styleId: "style1", variant: "store_discovery" }, images: 2, videos: 2, durationSeconds: 16, nativeAudioMode: "duck" },
  { input: { styleId: "style2", variant: "handheld" }, images: 3, videos: 4, durationSeconds: 22, nativeAudioMode: "mute" },
  { input: { styleId: "style2", variant: "large_countertop" }, images: 3, videos: 4, durationSeconds: 22, nativeAudioMode: "mute" },
  { input: { styleId: "style2", variant: "worn" }, images: 3, videos: 3, durationSeconds: 18, nativeAudioMode: "mute" },
];

describe.sequential("managed ready-to-post vertical acceptance", () => {
  afterAll(disposeReadyToPostHarness);

  it.each(HAPPY_PATHS)(
    "takes $input.styleId/$input.variant through the same managed run to a signed READY MP4",
    async ({ input, images, videos, durationSeconds, nativeAudioMode }) => {
      const evidence = await runReadyToPostScenario(input);
      const expectedSlots = evidence.frozenSnapshot.styleManifest.slots.map((slot: { id: string }) => slot.id);
      const expectedClips = evidence.frozenSnapshot.styleManifest.assembly.clips;

      expect(evidence.run.status).toBe("ready");
      expect(evidence.final).toMatchObject({
        contentRunId: evidence.run.id,
        status: "APPROVED",
        finalQaStatus: "APPROVED",
        mediaValidationPassed: true,
      });
      expect(evidence.signedUrl).toMatch(/^memory-private:\/\//);
      expect(evidence.counts).toEqual({
        images,
        videos,
        operations: images + videos + 2,
        sceneQaAttempts: images + videos,
        finalVideos: 1,
        finalQaAttempts: 1,
        audioObjects: 1,
        finalObjects: 1,
        locks: 0,
      });
      expect(evidence.providerCalls).toEqual({ images, videoStarts: videos, videoPolls: videos, visualFinal: 1 });
      expect(evidence.ttsCalls).toBe(1);
      expect(evidence.phases.map((phase) => phase.phase)).toEqual(["GENERATE_VOICEOVER", "ASSEMBLE_FINAL", "RUN_FINAL_QA"]);
      expect(evidence.concurrentPhases).toHaveLength(3);
      expect(evidence.concurrentPhases.every(([left, right]) => left.finalVideoId === right.finalVideoId)).toBe(true);
      expect(evidence.replay).toMatchObject({ finalVideoId: evidence.final.id, status: "ready" });
      expect(evidence.probe).toMatchObject({ width: 1080, height: 1920, videoCodec: "h264", audioCodec: "aac" });
      expect(evidence.probe.durationSeconds).toBeCloseTo(durationSeconds, 1);
      expect(evidence.hashes.final).toBe(evidence.hashes.actualFinal);
      expect(evidence.hashes.audio).toBe(evidence.hashes.actualAudio);
      expect(evidence.assemblyManifestBytesAfterAssembly).toBe(evidence.final.assemblyManifestJson);
      expect(evidence.persistedSnapshotBytes).toBe(evidence.frozenSnapshotBytes);
      expect(evidence.lineage.map((asset) => asset.slot)).toEqual(expectedSlots);
      expect(evidence.lineage.every((asset) => asset.contentRunId === evidence.run.id && asset.qaStatus === "APPROVED")).toBe(true);
      expect(evidence.videoModels).toEqual(Array(videos).fill("veo-3.1-lite-low-priority"));
      expect((evidence.assemblyManifest as AssemblyManifest).clips.map(({ order, slotId, trimStartSeconds, trimEndSeconds, nativeAudioMode: mode }) => ({ order, slotId, trimStartSeconds, trimEndSeconds, nativeAudioMode: mode }))).toEqual(expectedClips.map(({ order, slotId, trimStartSeconds, trimEndSeconds }: { order: number; slotId: string; trimStartSeconds: number; trimEndSeconds: number }) => ({ order, slotId, trimStartSeconds, trimEndSeconds, nativeAudioMode })));
    },
    240_000,
  );

  it("persists a playable offline smoke MP4 and JSON evidence outside disposable harness storage", async () => {
    const requestedOutput = process.env.READY_TO_POST_SMOKE_OUTPUT_DIR;
    const outputDir = requestedOutput
      ? resolve(requestedOutput)
      : mkdtempSync(join(tmpdir(), "ready-to-post-smoke-output-"));
    try {
      const result = await persistReadyToPostSmokeEvidence(outputDir);
      const evidence = JSON.parse(readFileSync(result.evidencePath, "utf8"));

      expect(result.videoPath).toBe(join(outputDir, "ready-to-post-style1.mp4"));
      expect(result.evidencePath).toBe(join(outputDir, "ready-to-post-evidence.json"));
      expect(statSync(result.videoPath).size).toBeGreaterThan(0);
      expect(evidence).toMatchObject({ status: "ready", finalQaStatus: "APPROVED", networkProviderSpend: false });
      expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      if (!requestedOutput) rmSync(outputDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    ["provider", /acceptance provider failure/, "failed", null, null],
    ["storage", /acceptance storage failure/, "failed", "FAILED", "VOICEOVER_GENERATION_FAILED"],
    ["tts", /acceptance TTS failure/, "failed", "FAILED", "VOICEOVER_GENERATION_FAILED"],
    ["ffmpeg", /acceptance FFmpeg failure/, "failed", "FAILED", "FINAL_ASSEMBLY_FAILED"],
    ["final_qa", /^$/, "failed", "FAILED", "FINAL_QA_INFRASTRUCTURE_FAILURE"],
  ] as const)("keeps %s infrastructure failure terminal with no false READY or duplicate spend", async (fault, message, runStatus, finalStatus, failureCode) => {
    const evidence = await runReadyToPostFailureScenario(fault);

    expect(evidence.error).toMatch(message);
    expect(evidence.runStatus).toBe(runStatus);
    expect(evidence.finalStatus).toBe(finalStatus);
    expect(evidence.finalFailureCode).toBe(failureCode);
    expect(evidence.readyCount).toBe(0);
    expect(evidence.locks).toBe(0);
    expect(evidence.ttsCalls).toBeLessThanOrEqual(1);
    expect(evidence.finalObjects).toBeLessThanOrEqual(1);
  }, 120_000);

  it("routes a deterministic final-QA rejection to HUMAN_REVIEW and stops", async () => {
    const evidence = await runReadyToPostFailureScenario("final_qa_reject");

    expect(evidence.error).toBe("");
    expect(evidence.runStatus).toBe("human_review");
    expect(evidence.finalStatus).toBe("HUMAN_REVIEW");
    expect(evidence.finalQaAttempts).toBe(1);
    expect(evidence.readyCount).toBe(0);
    expect(evidence.ttsCalls).toBe(1);
    expect(evidence.finalObjects).toBe(1);
  }, 120_000);

  it.each(["workspace_lock", "source_revocation"] as const)(
    "fences %s before additional provider or final-output spend",
    async (fault) => {
      const evidence = await runReadyToPostFailureScenario(fault);

      expect(evidence.error).toMatch(fault === "workspace_lock" ? /WORKSPACE_PROVIDER_BUSY|active/i : /approved|source|hash|HUMAN_REVIEW|not ready/i);
      expect(evidence.readyCount).toBe(0);
      expect(evidence.ttsCalls).toBe(0);
      expect(evidence.finalObjects).toBe(0);
    },
    120_000,
  );
});
