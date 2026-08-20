import { spawn } from "node:child_process";

export type FfmpegRunErrorCode = "INVALID_ARGV" | "SPAWN_ERROR" | "NONZERO_EXIT" | "TIMEOUT";

export class FfmpegRunError extends Error {
  readonly code: FfmpegRunErrorCode;
  readonly exitCode?: number | null;
  readonly stderr: string;

  constructor(
    message: string,
    options: { code: FfmpegRunErrorCode; exitCode?: number | null; stderr?: string; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.stderr = options.stderr ?? "";
  }
}

export interface FfmpegCommandManifest {
  binary: string;
  args: string[];
}

export interface RunFfmpegInput {
  binary: string;
  args: string[];
  timeoutMs?: number;
  stderrLimitBytes?: number;
  stdoutLimitBytes?: number;
}

export interface RunFfmpegResult {
  command: FfmpegCommandManifest;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_LIMIT_BYTES = 64 * 1024;

export async function runFfmpeg(input: RunFfmpegInput): Promise<RunFfmpegResult> {
  validateArgv(input.binary, input.args);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stderrLimitBytes = input.stderrLimitBytes ?? DEFAULT_LIMIT_BYTES;
  const stdoutLimitBytes = input.stdoutLimitBytes ?? DEFAULT_LIMIT_BYTES;
  const command = { binary: input.binary, args: [...input.args] };

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(input.binary, input.args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new FfmpegRunError(`${input.binary} timed out after ${timeoutMs}ms.`, { code: "TIMEOUT", stderr }));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, stdoutLimitBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, stderrLimitBytes);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new FfmpegRunError(`Failed to spawn ${input.binary}: ${err.message}`, { code: "SPAWN_ERROR", stderr, cause: err }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve({ command, stdout, stderr, exitCode: 0 });
      reject(
        new FfmpegRunError(`${input.binary} exited with code ${code}. Last stderr lines:\n${stderr || "<no stderr>"}`, {
          code: "NONZERO_EXIT",
          exitCode: code,
          stderr,
        }),
      );
    });
  });
}

function validateArgv(binary: string, args: string[]): void {
  for (const value of [binary, ...args]) {
    if (value.includes("\0")) {
      throw new FfmpegRunError("Refusing to spawn process with null byte in argv.", { code: "INVALID_ARGV" });
    }
  }
}

function appendBounded(current: string, chunk: Buffer, maxBytes: number): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  return next.slice(-maxBytes);
}
