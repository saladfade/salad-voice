import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// TTS server (audio.cpp in Docker). Override with SALAD_TTS_URL.
export const TTS_SERVER_URL = (process.env.SALAD_TTS_URL || "http://127.0.0.1:8082").replace(/\/+$/, "");
const TTS_SERVER_MODEL = "qwen3-tts";

// Local llama-tts fallback. Auto-detected:
// SALAD_LLAMA_TTS env -> known install locations -> PATH.
const LLAMA_TTS_DEFAULT = "~/llama.cpp/bin/llama-tts";
const LLAMA_TTS_CANDIDATES = [LLAMA_TTS_DEFAULT, "~/super-llama-cpp/bin/llama-tts"];

export function resolveTtsBinary(): string {
  const env = process.env.SALAD_LLAMA_TTS;
  if (env && existsSync(env)) return env;
  for (const p of LLAMA_TTS_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  for (const dir of (process.env.PATH || "").split(":").filter(Boolean)) {
    const p = join(dir, "llama-tts");
    if (existsSync(p)) return p;
  }
  return LLAMA_TTS_DEFAULT;
}

// Model resolution for the local fallback:
// env SALAD_TTS_MODEL -> TTS entry in pi llama config files -> default.
export function resolveTtsModel(): string {
  const env = process.env.SALAD_TTS_MODEL;
  if (env) return env;

  const configFiles = [
    join(process.env.HOME || "", ".pi", "agent", "llama", "models-store.json"),
    join(process.env.HOME || "", ".pi", "agent", "llama", "llamacpp-infra-models.json"),
  ];

  for (const file of configFiles) {
    if (!existsSync(file)) continue;
    try {
      const cfg = JSON.parse(readFileSync(file, "utf-8"));
      const entries = Array.isArray(cfg) ? cfg : cfg.models;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry?.task === "tts" && entry?.model) return entry.model;
      }
    } catch {
      // ignore malformed config
    }
  }

  return "ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF";
}

export async function ttsServerHealthy(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${TTS_SERVER_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

// Primary path: audio.cpp TTS server (Docker). Voice cloning via inline base64
// reference — the sample never needs to be staged on the host or in the container.
async function generateTtsViaServer(text: string, speakerFile?: string): Promise<string> {
  const body: Record<string, unknown> = { model: TTS_SERVER_MODEL, input: text };
  if (speakerFile) {
    body.voice_ref = { type: "base64", data: readFileSync(speakerFile).toString("base64") };
  }
  const res = await fetch(`${TTS_SERVER_URL}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`audio.cpp TTS server error: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const out = join(tmpdir(), `salad-tts-${Date.now()}.wav`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

// Fallback path: local llama-tts binary.
function generateTtsLocal(text: string, model: string, speakerFile?: string): Promise<string> {
  const bin = resolveTtsBinary();
  const out = join(tmpdir(), `salad-tts-${Date.now()}.wav`);
  const args: string[] = [];
  if (existsSync(model)) {
    args.push("--model", model);
    // Multimodal TTS models need the projector; look next to the backbone.
    const dir = dirname(model);
    const mm = readdirSync(dir).find((f) => f.startsWith("mmproj") && f.endsWith(".gguf"));
    if (mm) args.push("--mmproj", join(dir, mm));
  } else {
    args.push("-hf", model);
  }
  args.push("-p", text, "-o", out);
  if (speakerFile) args.push("--tts-speaker-file", speakerFile);

  return new Promise((resolve, reject) => {
    // Force CPU: the GPU is usually occupied by Pi's own LLM, and this
    // llama.cpp build still allocates compute buffers on CUDA. A
    // nonexistent device id makes backend init fail -> CPU fallback.
    const proc = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CUDA_VISIBLE_DEVICES: "99" },
    });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => reject(new Error(`Failed to run ${bin}: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`llama-tts exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// Generate a WAV file from text.
// Tries the audio.cpp TTS server first; falls back to local llama-tts.
export async function generateTtsWav(text: string, model: string, speakerFile?: string): Promise<{ wav: string; error?: string }> {
  if (await ttsServerHealthy()) {
    try {
      return { wav: await generateTtsViaServer(text, speakerFile) };
    } catch (e) {
      console.error(`[salad-voice] TTS server failed (${(e as Error).message}); falling back to local llama-tts`);
    }
  }
  try {
    return { wav: await generateTtsLocal(text, model, speakerFile) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
