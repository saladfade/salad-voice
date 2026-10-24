import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Client for the audio.cpp container (docker/): its HTTP API on 127.0.0.1:8082,
 * plus start/stop/status through the docker CLI.
 */
const exec = promisify(execFile);
const BASE = "http://127.0.0.1:8082";
const NAME = "salad-audiocpp";
const IMAGE = "salad-audiocpp:latest";
const MODEL = "parakeet-tdt";
const DOCKER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "docker");

async function docker(args: string[]): Promise<string> {
  try {
    return (await exec("docker", args)).stdout.trim();
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr?.trim();
    throw new Error(`docker ${args[0]} failed: ${stderr || String(e)}`);
  }
}

async function dockerOk(args: string[]): Promise<boolean> {
  return docker(args).then(
    () => true,
    () => false,
  );
}

export async function health(): Promise<boolean> {
  try {
    return (await fetch(BASE + "/health", { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

/** Ids of the models the server reports as loaded (GET /v1/models). */
export async function loadedModels(): Promise<string[]> {
  const res = await fetch(BASE + "/v1/models", { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`/v1/models failed: ${res.status}`);
  const data = (await res.json()) as { data?: { id: string; loaded: boolean }[] };
  return (data.data ?? []).filter((m) => m.loaded).map((m) => m.id);
}

/** Docker state of the container: "running", "exited", ... or "not created". */
export async function containerState(): Promise<string> {
  try {
    return await docker(["inspect", "-f", "{{.State.Status}}", NAME]);
  } catch {
    return "not created";
  }
}

/** Starts the container (building the image or creating it if needed) and waits for /health. */
export async function ensureRunning(onStatus: (msg: string) => void): Promise<void> {
  if (await health()) return;
  const state = await containerState();
  if (state === "not created") {
    if (!(await dockerOk(["image", "inspect", IMAGE]))) {
      onStatus("Building salad-audiocpp image (first time only, slow)…");
      await docker(["build", "-t", IMAGE, DOCKER_DIR]);
    }
    onStatus("Starting transcription container…");
    await docker([
      "run", "-d", "--name", NAME, "--restart", "unless-stopped",
      "--cpus", "4", "--memory", "6g",
      "-p", "127.0.0.1:8082:8082", "-v", "salad-audiocpp-models:/models", IMAGE,
    ]);
  } else if (state !== "running") {
    onStatus("Starting transcription container…");
    await docker(["start", NAME]);
  }
  onStatus("Waiting for transcription server…");
  // First start downloads the models into the volume, so allow a long wait.
  const deadline = Date.now() + 10 * 60_000;
  while (!(await health())) {
    if (Date.now() > deadline) throw new Error("container not healthy after 10 min");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function stopContainer(): Promise<void> {
  await docker(["stop", NAME]);
}

/** POSTs a WAV buffer to /v1/audio/transcriptions and returns the transcript text. */
export async function transcribe(wav: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "recording.wav");
  form.append("model", MODEL);
  const res = await fetch(BASE + "/v1/audio/transcriptions", { method: "POST", body: form });
  if (!res.ok) throw new Error(`transcription failed: ${res.status}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}
