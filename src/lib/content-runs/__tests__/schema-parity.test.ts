import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../..");
const sqliteSchemaPath = path.join(repoRoot, "prisma/schema.prisma");
const postgresSchemaPath = path.join(repoRoot, "prisma/schema.postgres.prisma");

type ModelShape = Record<string, string[]>;

function normalizeSchema(schema: string): ModelShape {
  const models: ModelShape = {};
  const normalizedNewlines = schema.replace(/\r/g, "");
  const modelPattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

  for (const match of normalizedNewlines.matchAll(modelPattern)) {
    const [, modelName, body] = match;
    const members = body
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter(Boolean)
      .map((line) =>
        line
          .replace(/@db\.\w+(?:\([^)]*\))?/g, "")
          .replace(/\s+/g, " ")
          .replace(/\s*,\s*/g, ",")
          .trim(),
      )
      .sort();

    models[modelName] = members;
  }

  return models;
}

function modelBody(schema: string, modelName: string): string {
  const match = schema.match(
    new RegExp(`^model\\s+${modelName}\\s*\\{([\\s\\S]*?)^\\}`, "m"),
  );
  if (!match) throw new Error(`Missing Prisma model: ${modelName}`);
  return match[1];
}

function expectField(body: string, field: string, type: string): void {
  expect(body, `expected ${field} to have type ${type}`).toMatch(
    new RegExp(`^\\s*${field}\\s+${type.replace(/[?\[\]]/g, "\\$&")}(?:\\s|$)`, "m"),
  );
}

describe("managed Style 1 Prisma schema contract", () => {
  const sqliteSchema = fs.readFileSync(sqliteSchemaPath, "utf8");
  const postgresSchema = fs.readFileSync(postgresSchemaPath, "utf8");

  it("keeps SQLite and Postgres model structures aligned", () => {
    expect(normalizeSchema(postgresSchema)).toEqual(normalizeSchema(sqliteSchema));
  });

  it.each([
    ["FlowGeneratedImage", "storageBucket", "String?"],
    ["FlowGeneratedImage", "storageKey", "String?"],
    ["FlowGeneratedImage", "storageContentType", "String?"],
    ["FlowGeneratedImage", "storageBytes", "Int?"],
    ["FlowGeneratedImage", "storageSha256", "String?"],
    ["FlowGeneratedVideo", "storageBucket", "String?"],
    ["FlowGeneratedVideo", "storageKey", "String?"],
    ["FlowGeneratedVideo", "storageContentType", "String?"],
    ["FlowGeneratedVideo", "storageBytes", "Int?"],
    ["FlowGeneratedVideo", "storageSha256", "String?"],
    ["FlowGeneratedVideo", "sourceImageId", "String?"],
  ])("keeps legacy-compatible %s.%s nullable", (model, field, type) => {
    expectField(modelBody(sqliteSchema, model), field, type);
    expectField(modelBody(postgresSchema, model), field, type);
  });

  it("persists managed-run defaults and idempotency", () => {
    for (const schema of [sqliteSchema, postgresSchema]) {
      const settings = modelBody(schema, "WorkspaceSettings");
      expect(settings).toMatch(
        /^\s*flowImageModel\s+String\s+@default\("nano-banana-pro"\)/m,
      );
      expect(settings).toMatch(
        /^\s*flowVideoModel\s+String\s+@default\("veo-3\.1-lite-low-priority"\)/m,
      );

      const run = modelBody(schema, "ContentRun");
      expect(run).toMatch(/^\s*status\s+String\s+@default\("created"\)/m);
      expectField(run, "idempotencyKey", "String");
      expectField(run, "completedAt", "DateTime?");
      expect(run).toContain("@@unique([productId, idempotencyKey])");
    }
  });

  it("contains the provider operation and workspace lock models", () => {
    for (const schema of [sqliteSchema, postgresSchema]) {
      const operation = modelBody(schema, "ContentOperation");
      expectField(operation, "idempotencyKey", "String");
      expectField(operation, "providerJobId", "String?");
      expect(operation).toMatch(
        /^\s*providerAttemptNumber\s+Int\s+@default\(0\)/m,
      );
      expect(operation).toMatch(
        /^\s*providerAttemptsJson\s+String\s+@default\("\[\]"\)/m,
      );
      expect(operation).toContain("@@unique([workspaceId, idempotencyKey])");
      expect(operation).toContain("@@index([contentRunId, createdAt])");
      expect(operation).toContain("@@index([workspaceId, status])");
      expect(operation).toContain("@@index([providerJobId])");

      const lock = modelBody(schema, "WorkspaceProviderLock");
      expectField(lock, "workspaceId", "String");
      expectField(lock, "operationId", "String");
    }
  });

  it("persists one legacy-safe final video per content run with complete lifecycle metadata", () => {
    const nullableFields = [
      "voiceoverScript",
      "voiceoverProvider",
      "voiceoverVoiceId",
      "voiceoverModel",
      "audioStorageBucket",
      "audioStorageKey",
      "audioContentType",
      "audioBytes",
      "audioSha256",
      "audioDurationSeconds",
      "assemblyManifestJson",
      "finalStorageBucket",
      "finalStorageKey",
      "finalContentType",
      "finalBytes",
      "finalSha256",
      "finalDurationSeconds",
      "finalWidth",
      "finalHeight",
      "finalVideoCodec",
      "finalAudioCodec",
      "mediaValidationPassed",
      "mediaValidatedAt",
      "finalQaScore",
      "finalQaVerdict",
      "finalQaEvaluatedAt",
      "failureCode",
      "failureJson",
      "failedAt",
    ] as const;

    for (const schema of [sqliteSchema, postgresSchema]) {
      const run = modelBody(schema, "ContentRun");
      expectField(run, "finalVideo", "FinalVideoAsset?");

      const finalVideo = modelBody(schema, "FinalVideoAsset");
      expectField(finalVideo, "contentRunId", "String");
      expect(finalVideo).toMatch(/^\s*attempt\s+Int\s+@default\(1\)/m);
      expect(finalVideo).toMatch(/^\s*status\s+String\s+@default\("PENDING"\)/m);
      expect(finalVideo).toMatch(
        /^\s*finalQaStatus\s+String\s+@default\("NOT_QA_CHECKED"\)/m,
      );
      expect(finalVideo).toContain("@@unique([contentRunId])");
      for (const field of nullableFields) {
        expect(finalVideo, `${field} must be nullable for staged persistence`).toMatch(
          new RegExp(`^\\s*${field}\\s+\\w+\\?`, "m"),
        );
      }

      const qaAttempt = modelBody(schema, "QaAttempt");
      expectField(qaAttempt, "finalVideoId", "String?");
      expect(qaAttempt).toContain("@@index([finalVideoId])");
    }
  });
});
