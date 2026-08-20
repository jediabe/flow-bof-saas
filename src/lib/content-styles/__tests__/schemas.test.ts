import { describe, expect, it } from "vitest";
import { compileStyleManifest } from "../registry";
import { StyleManifestSchema } from "../schemas";

const clone = <T>(value: T): T => structuredClone(value);

describe("persistable style manifest schema", () => {
  it.each([
    ["missing slot", (manifest: any) => manifest.slots.pop()],
    [
      "extra slot",
      (manifest: any) => {
        const extra = clone(manifest.slots[0]);
        extra.id = "unexpected_slot";
        extra.order = manifest.slots.length;
        extra.promptCompilerId = "style1.store_image.v1";
        manifest.slots.push(extra);
      },
    ],
    ["duplicate slot", (manifest: any) => manifest.slots.splice(1, 1, clone(manifest.slots[0]))],
    [
      "missing dependency",
      (manifest: any) => {
        manifest.slots[1].sourceDependency = "missing";
        manifest.slots[1].attachmentPolicy.startImageFromSlot = "missing";
      },
    ],
    [
      "cyclic dependency",
      (manifest: any) => {
        manifest.slots[0].sourceDependency = manifest.slots[1].id;
        manifest.slots[0].attachmentPolicy.startImageFromSlot = manifest.slots[1].id;
      },
    ],
  ])("rejects %s topology", (_label, mutate) => {
    const manifest: any = clone(
      compileStyleManifest("style1", "managed-style1-v1", "store_discovery"),
    );
    mutate(manifest);
    expect(StyleManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it.each([
    ["negative trim", (manifest: any) => (manifest.assembly.clips[0].trimStartSeconds = -1)],
    ["trim beyond source", (manifest: any) => (manifest.assembly.clips[0].trimEndSeconds = 9)],
    ["duration mismatch", (manifest: any) => (manifest.assembly.clips[0].durationSeconds = 7)],
    ["invalid native audio", (manifest: any) => (manifest.assembly.clips[0].nativeAudioMode = "replace")],
    ["invalid output dimensions", (manifest: any) => (manifest.assembly.output.width = 0)],
    ["invalid fps", (manifest: any) => (manifest.assembly.output.fps = 0)],
    ["invalid mix", (manifest: any) => (manifest.assembly.output.audioMix.voiceoverGainDb = 99)],
    ["invalid final duration", (manifest: any) => (manifest.assembly.output.finalDurationSeconds = 99)],
  ])("rejects %s", (_label, mutate) => {
    const manifest: any = clone(compileStyleManifest("style2", "managed-style2-v1", "handheld"));
    mutate(manifest);
    expect(StyleManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it.each([
    ["prompt", "write any arbitrary prompt"],
    ["secret", "secret-value"],
    ["providerUrl", "https://attacker.example"],
    ["workspaceId", "workspace-1"],
    ["status", "ready"],
    ["qaDecision", "APPROVE"],
    ["compiler", () => "runtime function"],
  ])("rejects arbitrary persistable field %s", (field, value) => {
    const manifest: any = clone(compileStyleManifest("style2", "managed-style2-v1", "worn"));
    manifest[field] = value;
    expect(StyleManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("bounds registry and compiler identifiers", () => {
    const manifest: any = clone(compileStyleManifest("style2", "managed-style2-v1", "handheld"));
    manifest.slots[0].promptCompilerId = "custom.prompt.compiler";
    expect(StyleManifestSchema.safeParse(manifest).success).toBe(false);

    manifest.slots[0].promptCompilerId = "style2.handheld.n1.v1";
    manifest.creativeDirectionProfileId = "custom.direction";
    expect(StyleManifestSchema.safeParse(manifest).success).toBe(false);
  });
});
