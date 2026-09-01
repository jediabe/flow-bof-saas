import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { compileStyleManifest } from "../../content-styles/registry";
import { CreativeDirectionSchema } from "../../content-runs/schemas";
import {
  HERMES_CONTENT_TOOL_NAMES,
  HERMES_CONTENT_TOOL_SCHEMAS,
} from "../schemas";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const skillPath = resolve(root, "hermes/managed-content-operator/SKILL.md");
const contractsPath = resolve(root, "hermes/managed-content-operator/references/tool-contracts.md");

const APPROVED_TOOLS = [
  "content_get_product",
  "content_create_run",
  "content_generate_image",
  "content_generate_video",
  "content_run_qa",
  "content_run_final_output",
  "content_get_run",
] as const;

const FORBIDDEN_TOOL_RE = /\b(content_create_style1_run|content_generate_style1_image|content_generate_style1_video|content_run_asset_qa|google_flow|flow_generate|post_to_tiktok|content_post|content_publish|content_upload|prisma|sql)\b/i;

type ApprovedTool = (typeof APPROVED_TOOLS)[number];
type CallFixture = { tool: ApprovedTool; args: Record<string, unknown> };
type RequiredAction = { type: string; slot?: string; assetId?: string; sourceAssetId?: string; finalVideoId?: string; operationId?: string; reason?: string };

const RequiredNextActionFixtureSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("GENERATE_IMAGE"), slot: z.string() }).strict(),
  z.object({ type: z.literal("GENERATE_VIDEO"), slot: z.string(), sourceAssetId: z.string().optional() }).strict(),
  z.object({ type: z.literal("RUN_QA"), slot: z.string(), assetId: z.string() }).strict(),
  z.object({ type: z.literal("GENERATE_VOICEOVER") }).strict(),
  z.object({ type: z.literal("ASSEMBLE_FINAL"), finalVideoId: z.string() }).strict(),
  z.object({ type: z.literal("RUN_FINAL_QA"), finalVideoId: z.string() }).strict(),
  z.object({ type: z.literal("WAIT_FOR_OPERATION"), operationId: z.string() }).strict(),
  z.object({ type: z.literal("HUMAN_REVIEW"), reason: z.string() }).strict(),
  z.object({ type: z.literal("FAILED"), reason: z.string() }).strict(),
  z.object({ type: z.literal("COMPLETE") }).strict(),
]);
const StyleFixtureSchema = z.object({ id: z.enum(["style1", "style2"]), version: z.enum(["managed-style1-v1", "managed-style2-v1"]), variant: z.enum(["store_discovery", "handheld", "large_countertop", "worn"]) }).strict();
const AssetAttemptFixtureSchema = z.object({ assetId: z.string(), attempt: z.number().int().positive(), qaStatus: z.string(), selected: z.boolean() }).strict();
const ProjectedSlotFixtureSchema = z.object({ slot: z.string(), assetType: z.string(), selectedAssetId: z.string().optional(), attempts: z.array(AssetAttemptFixtureSchema) }).strict();
const RunProjectionFixtureSchema = z.object({
  id: z.string(), productId: z.string(), objective: z.string(), status: z.string(), specVersion: z.string(),
  modelSnapshot: z.object({ imageModel: z.string(), videoModel: z.string() }).strict(),
  slots: z.array(ProjectedSlotFixtureSchema),
  activeOperation: z.object({ id: z.string(), kind: z.string(), status: z.enum(["requested", "running"]), slot: z.string() }).strict().optional(),
  requiredNextAction: RequiredNextActionFixtureSchema,
  terminalReason: z.string().optional(),
}).strict();
const GetRunResultFixtureSchema = z.object({ style: StyleFixtureSchema, slotMediaTypes: z.record(z.string(), z.enum(["image", "video"])), run: RunProjectionFixtureSchema }).strict();
const ProductResultFixtureSchema = z.object({ id: z.string(), reviewStatus: z.literal("approved") }).passthrough();
const CreateRunResultFixtureSchema = z.object({ runId: z.string(), style: StyleFixtureSchema, nextAction: RequiredNextActionFixtureSchema }).strict();
const ImageAssetFixtureSchema = z.object({ id: z.string(), contentRunId: z.string().nullable(), sceneLabel: z.string(), mediaGenerationId: z.string(), prompt: z.string().nullable(), attemptNumber: z.number(), qaStatus: z.string(), storageBucket: z.string().nullable(), storageKey: z.string().nullable(), storageContentType: z.string().nullable(), storageBytes: z.number().nullable(), storageSha256: z.string().nullable() }).strict();
const VideoAssetFixtureSchema = ImageAssetFixtureSchema.extend({ imageMediaGenerationId: z.string().nullable(), sourceImageId: z.string().nullable() }).strict();
const ImageResultFixtureSchema = z.object({ operationId: z.string(), contentRunId: z.string(), slot: z.string(), asset: ImageAssetFixtureSchema, requiredNextAction: RequiredNextActionFixtureSchema }).strict();
const VideoResultFixtureSchema = z.union([
  z.object({ operationId: z.string(), operationStatus: z.literal("running"), contentRunId: z.string(), slot: z.string(), providerJobId: z.string().optional(), requiredNextAction: RequiredNextActionFixtureSchema }).strict(),
  z.object({ operationId: z.string(), operationStatus: z.literal("succeeded"), contentRunId: z.string(), slot: z.string(), providerJobId: z.string(), asset: VideoAssetFixtureSchema, requiredNextAction: RequiredNextActionFixtureSchema }).strict(),
]);
const QaResultFixtureSchema = z.object({ contentRunId: z.string(), assetId: z.string(), assetKind: z.enum(["image", "video"]), decision: z.string(), qaStatus: z.string(), runStatus: z.string(), requiredNextAction: RequiredNextActionFixtureSchema }).strict();
const FinalResultFixtureSchema = z.union([
  z.object({ action: z.literal("GENERATE_VOICEOVER"), phase: z.literal("GENERATE_VOICEOVER"), status: z.literal("VOICEOVER_READY"), finalVideoId: z.string() }).strict(),
  z.object({ action: z.literal("ASSEMBLE_FINAL"), phase: z.literal("ASSEMBLE_FINAL"), status: z.literal("MEDIA_VALIDATED"), finalVideoId: z.string() }).strict(),
  z.object({ action: z.literal("READY"), phase: z.literal("RUN_FINAL_QA"), status: z.literal("ready"), finalVideoId: z.string() }).strict(),
  z.object({ action: z.literal("READY") }).strict(),
  z.object({ action: z.literal("WAIT"), operationId: z.string() }).strict(),
  z.object({ action: z.literal("HUMAN_REVIEW"), reason: z.string() }).strict(),
  z.object({ action: z.literal("FAILED"), reason: z.string() }).strict(),
]);

function readSkillFile(path: string) { return readFileSync(path, "utf8"); }
function section(content: string, heading: string) {
  const marker = `## ${heading}`;
  const start = content.indexOf(marker);
  expect(start, `missing section ${heading}`).toBeGreaterThanOrEqual(0);
  const bodyStart = content.indexOf("\n", start + marker.length);
  expect(bodyStart, `missing section body ${heading}`).toBeGreaterThanOrEqual(0);
  const next = content.indexOf("\n## ", bodyStart + 1);
  return content.slice(bodyStart + 1, next === -1 ? content.length : next);
}
function transcript(content: string, heading: string) {
  const transcripts = section(content, "Scripted Contract Transcripts");
  const marker = `### ${heading}`;
  const start = transcripts.indexOf(marker);
  expect(start, `missing transcript ${heading}`).toBeGreaterThanOrEqual(0);
  const bodyStart = transcripts.indexOf("\n", start + marker.length);
  expect(bodyStart, `missing transcript body ${heading}`).toBeGreaterThanOrEqual(0);
  const next = transcripts.indexOf("\n### ", bodyStart + 1);
  return transcripts.slice(bodyStart + 1, next === -1 ? transcripts.length : next);
}
function parseCalls(block: string): CallFixture[] { return Array.from(block.matchAll(/^\d+\. CALL (content_[a-z_]+) (\{.*\})$/gm)).map((match) => ({ tool: match[1] as ApprovedTool, args: JSON.parse(match[2]) as Record<string, unknown> })); }
function parseResults(block: string): Record<string, unknown>[] { return Array.from(block.matchAll(/^\s+RESULT (\{.*\})$/gm)).map((match) => JSON.parse(match[1]) as Record<string, unknown>); }
function callNames(block: string) { return parseCalls(block).map((call) => call.tool); }
function expectNoForbiddenCalls(block: string) { expect(block).not.toMatch(FORBIDDEN_TOOL_RE); for (const name of callNames(block)) expect(APPROVED_TOOLS).toContain(name); }
function expectCallsParseAgainstW4A(block: string) { for (const call of parseCalls(block)) { const result = HERMES_CONTENT_TOOL_SCHEMAS[call.tool].safeParse(call.args); expect(result.success, `${call.tool} args must parse against W4A schema: ${JSON.stringify(call.args)}`).toBe(true); } }
function expectNoRejectedW4AFields(block: string) { for (const call of parseCalls(block)) { if (["content_generate_image", "content_generate_video", "content_run_qa", "content_run_final_output"].includes(call.tool)) { expect(call.args).not.toHaveProperty("slot"); expect(call.args).not.toHaveProperty("sourceAssetId"); expect(call.args).not.toHaveProperty("assetId"); expect(call.args).not.toHaveProperty("phase"); expect(call.args).not.toHaveProperty("finalVideoId"); } } }
function expectResultParsesForCall(call: CallFixture, result: Record<string, unknown>) { const schema = { content_get_product: ProductResultFixtureSchema, content_create_run: CreateRunResultFixtureSchema, content_generate_image: ImageResultFixtureSchema, content_generate_video: VideoResultFixtureSchema, content_run_qa: QaResultFixtureSchema, content_run_final_output: FinalResultFixtureSchema, content_get_run: GetRunResultFixtureSchema }[call.tool]; const parsed = schema.safeParse(result); expect(parsed.success, `${call.tool} result must match W4A handler/query shape: ${JSON.stringify(result)}`).toBe(true); }
function expectResultsParseAgainstW4A(block: string) { const calls = parseCalls(block); const results = parseResults(block); expect(results).toHaveLength(calls.length); calls.forEach((call, index) => expectResultParsesForCall(call, results[index])); }
function resultAction(result: Record<string, unknown>) { if ("nextAction" in result) return result.nextAction as RequiredAction; if ("requiredNextAction" in result) return result.requiredNextAction as RequiredAction; const getRunAction = (result.run as { requiredNextAction?: RequiredAction } | undefined)?.requiredNextAction; expect(getRunAction, `missing nested get_run requiredNextAction in ${JSON.stringify(result)}`).toBeDefined(); return getRunAction!; }
function expectGetRunProjection(result: Record<string, unknown>, expected: RequiredAction) { expect(GetRunResultFixtureSchema.safeParse(result).success, `get_run result must be nested W4A view: ${JSON.stringify(result)}`).toBe(true); expect((result.run as { requiredNextAction: RequiredAction }).requiredNextAction).toMatchObject(expected); }
function assetKindFor(mediaType: "image" | "video") { return mediaType; }

function expectTranscriptMatchesManifest(block: string, styleId: "style1" | "style2", version: "managed-style1-v1" | "managed-style2-v1", variant: "store_discovery" | "handheld" | "large_countertop" | "worn") {
  const manifest = compileStyleManifest(styleId, version, variant);
  const calls = parseCalls(block);
  const results = parseResults(block);
  const runId = styleId === "style1" ? "cr_style1_store" : variant === "large_countertop" ? "cr_style2_large" : `cr_style2_${variant}`;
  const finalVideoId = `fv_${runId.replace("cr_", "")}`;
  expect(calls[0]).toEqual({ tool: "content_get_product", args: { productId: "p_approved" } });
  expect(results[0]).toMatchObject({ id: "p_approved", reviewStatus: "approved" });
  expect(calls[1].tool).toBe("content_create_run");
  expect(calls[1].args).toMatchObject({ productId: "p_approved", style: styleId });
  expect(calls[1].args).not.toHaveProperty("variant");
  expect(calls[1].args).not.toHaveProperty("objective");
  expect(calls[1].args).not.toHaveProperty("compilerInputs");
  expect(calls[1].args).toHaveProperty("compilerInput");
  expect(resultAction(results[1])).toMatchObject({ type: manifest.slots[0].mediaType === "image" ? "GENERATE_IMAGE" : "GENERATE_VIDEO", slot: manifest.slots[0].id });
  for (const [index, slot] of manifest.slots.entries()) {
    const base = 2 + index * 3;
    expect(calls[base]).toEqual({ tool: slot.mediaType === "image" ? "content_generate_image" : "content_generate_video", args: { contentRunId: runId, idempotencyKey: `managed:${runId}:${slot.id}:generate` } });
    expect(calls[base + 1]).toEqual({ tool: "content_run_qa", args: { contentRunId: runId } });
    expect(calls[base + 2]).toEqual({ tool: "content_get_run", args: { contentRunId: runId } });
    expect(resultAction(results[base])).toMatchObject({ type: "RUN_QA", slot: slot.id, assetId: `asset_${slot.id}` });
    expect(results[base + 1]).toMatchObject({ contentRunId: runId, assetId: `asset_${slot.id}`, assetKind: assetKindFor(slot.mediaType), decision: "APPROVE", qaStatus: "APPROVED" });
    const nextSlot = manifest.slots[index + 1];
    const expectedNext = nextSlot ? { type: nextSlot.mediaType === "image" ? "GENERATE_IMAGE" : "GENERATE_VIDEO", slot: nextSlot.id, ...(nextSlot.sourceDependency ? { sourceAssetId: `asset_${nextSlot.sourceDependency}` } : {}) } : { type: "GENERATE_VOICEOVER" };
    expectGetRunProjection(results[base + 2], expectedNext);
  }
  const finalStart = 2 + manifest.slots.length * 3;
  expect(calls.slice(finalStart)).toEqual([
    { tool: "content_run_final_output", args: { contentRunId: runId, idempotencyKey: `managed:${runId}:final-output` } },
    { tool: "content_run_final_output", args: { contentRunId: runId, idempotencyKey: `managed:${runId}:final-output` } },
    { tool: "content_run_final_output", args: { contentRunId: runId, idempotencyKey: `managed:${runId}:final-output` } },
    { tool: "content_get_run", args: { contentRunId: runId } },
  ]);
  expect(results[finalStart]).toEqual({ action: "GENERATE_VOICEOVER", phase: "GENERATE_VOICEOVER", status: "VOICEOVER_READY", finalVideoId });
  expect(results[finalStart + 1]).toEqual({ action: "ASSEMBLE_FINAL", phase: "ASSEMBLE_FINAL", status: "MEDIA_VALIDATED", finalVideoId });
  expect(results[finalStart + 2]).toEqual({ action: "READY", phase: "RUN_FINAL_QA", status: "ready", finalVideoId });
  expectGetRunProjection(results[finalStart + 3], { type: "COMPLETE" });
  expect((results[finalStart + 3].run as { status: string }).status).toBe("ready");
}

describe("managed content operator skill contract", () => {
  it("freezes the approved managed MCP tool surface with exact W4A set equality", () => {
    const skill = readSkillFile(skillPath); const contracts = readSkillFile(contractsPath);
    const approvedSection = section(skill, "Approved Tool Surface"); const contractTools = section(contracts, "Approved tools");
    const skillTools = Array.from(approvedSection.matchAll(/`(content_[a-z_]+)`/g)).map((match) => match[1]).sort();
    const referenceTools = Array.from(contractTools.matchAll(/^- `(content_[a-z_]+)`:/gm)).map((match) => match[1]).sort();
    expect(skillTools).toEqual([...APPROVED_TOOLS].sort()); expect(referenceTools).toEqual([...APPROVED_TOOLS].sort()); expect([...HERMES_CONTENT_TOOL_NAMES].sort()).toEqual([...APPROVED_TOOLS].sort()); expect(`${skill}\n${contracts}`).not.toMatch(FORBIDDEN_TOOL_RE); expect(`${skill}\n${contracts}`).toMatch(/never raw Google Flow/i);
  });
  it("defines reproducible stable idempotency keys that hash the W4A-accepted create document", () => {
    const skill = readSkillFile(skillPath); const idempotency = section(skill, "Idempotency Keys"); const transcripts = section(skill, "Scripted Contract Transcripts");
    expect(idempotency).toMatch(/W4A-accepted `content_create_run` input/i); expect(idempotency).toMatch(/canonical JSON/i); expect(idempotency).toMatch(/SHA-256/i); expect(idempotency).toMatch(/lowercase hex/i); expect(idempotency).toMatch(/one run-stable final-output root/i); expect(idempotency).not.toMatch(/final:voiceover|final:assembly|finalqa/);
    for (const key of ["managed:p_approved:style1:store_discovery:objective:sha256-4e2bac1c296b7c9e8138c3b77049f2df92c0712a8083d3b575fa2ecdc50cb0e7", "managed:cr_style1_store:scene_1_store_image:generate", "managed:cr_style1_store:scene_1_store_video:generate", "managed:cr_style1_store:scene_2_home_image:generate", "managed:cr_style1_store:scene_2_home_video:generate", "managed:cr_style1_store:final-output", "managed:p_approved:style2:handheld:objective:sha256-5b8add3bc4e139a8d948462bc10fb9ede8c6f44354a1d4b728d852fe09d622b1", "managed:cr_style2_handheld:N1:generate", "managed:cr_style2_handheld:N3:generate", "managed:cr_style2_handheld:final-output"]) expect(transcripts).toContain(key);
  });
  it("contains schema-parseable ordered transcripts for Style1 and every Style2 topology", () => {
    const skill = readSkillFile(skillPath);
    const blocks = [[transcript(skill, "Style1 store_discovery"), "style1", "managed-style1-v1", "store_discovery"], [transcript(skill, "Style2 handheld"), "style2", "managed-style2-v1", "handheld"], [transcript(skill, "Style2 large_countertop"), "style2", "managed-style2-v1", "large_countertop"], [transcript(skill, "Style2 worn"), "style2", "managed-style2-v1", "worn"]] as const;
    for (const [block, style, version, variant] of blocks) { expectNoForbiddenCalls(block); expectCallsParseAgainstW4A(block); expectNoRejectedW4AFields(block); expectResultsParseAgainstW4A(block); expectTranscriptMatchesManifest(block, style, version, variant); }
    expect(transcript(skill, "Style2 worn")).not.toMatch(/"slot":"N7"|slot: "N7"/);
  });
  it("scripts safety branches without spend, bypass behavior, or invalid replay", () => {
    const skill = readSkillFile(skillPath); const contracts = readSkillFile(contractsPath);
    const incomplete = transcript(skill, "Incomplete input"); const wait = transcript(skill, "WAIT_FOR_OPERATION"); const humanReview = transcript(skill, "HUMAN_REVIEW"); const failed = transcript(skill, "FAILED"); const style3 = transcript(skill, "Style3 unsupported"); const posting = transcript(skill, "Posting refusal");
    expect(incomplete).toMatch(/NO CALL content_create_run/); expect(incomplete).toMatch(/clarify/i);
    expect(wait).toMatch(/CALL content_generate_video \{"contentRunId":"cr_style2_handheld","idempotencyKey":"managed:cr_style2_handheld:N1:generate"\}[\s\S]*"WAIT_FOR_OPERATION"[\s\S]*CALL content_generate_video \{"contentRunId":"cr_style2_handheld","idempotencyKey":"managed:cr_style2_handheld:N1:generate"\}/);
    expect(wait).not.toMatch(/generation WAIT.*contract mismatch/i); expect(`${skill}\n${contracts}`).not.toMatch(/generation WAIT.*contract mismatch/i);
    expect(humanReview).toMatch(/RESULT .*"action":"HUMAN_REVIEW"/); expect(humanReview).toMatch(/STOP/); expect(failed).toMatch(/RESULT .*"action":"FAILED"/); expect(failed).toMatch(/terminal/); expect(failed).toMatch(/never resume or spend again on that ContentRun/i); expect(failed).not.toMatch(/new objective key/i); expect(style3).toMatch(/NO CALL content_create_run/); expect(style3).toMatch(/unsupported/i); expect(posting).toMatch(/NO CALL/); expect(posting).toMatch(/manual upload/i);
    for (const block of [wait, humanReview, failed]) { expectCallsParseAgainstW4A(block); expectNoRejectedW4AFields(block); expectResultsParseAgainstW4A(block); }
    for (const block of [incomplete, wait, humanReview, failed, style3, posting]) expectNoForbiddenCalls(block);
  });
  it("bounds style, model, and creative-direction choices to human-approved SaaS inputs", () => {
    const skill = readSkillFile(skillPath); const contracts = readSkillFile(contractsPath);
    const creativeDirection = { cameraMovement: "locked_off", pacing: "steady", framing: "stable_medium", distance: "hold_distance", interactionStyle: "minimal_hand_interaction", movementIntensity: "minimal", preservationFocus: ["packaging_proportions"] };
    expect(CreativeDirectionSchema.safeParse(creativeDirection).success).toBe(true); expect(skill).toMatch(/Support only Style1 and Style2/i); expect(skill).toMatch(/handheld/); expect(skill).toMatch(/large_countertop/); expect(skill).toMatch(/worn/); expect(skill).toMatch(/clarify[\s\S]*style[\s\S]*product[\s\S]*compiler input/i); expect(skill).toMatch(/never inject model[\s\S]*human[\s\S]*allowlisted model/i); expect(contracts).toMatch(/creativeDirection[\s\S]*only[\s\S]*manifest allows/i); expect(contracts).toMatch(/cameraMovement[\s\S]*preservationFocus/); expect(contracts).toMatch(/no QA skip[\s\S]*no QA override[\s\S]*no QA repair/i);
  });
});
