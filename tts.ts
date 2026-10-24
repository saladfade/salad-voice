import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { play } from "./audio.js";
import { BASE } from "./stt.js";

/**
 * Speech for salad-voice: Kokoro stock-voice TTS and Qwen3-TTS voice cloning, both through
 * POST /v1/audio/speech on the audio.cpp container, plus the saved clone sample in ~/.pi.
 */
const KOKORO_VOICE = "af_heart";
const CLONE_DIR = path.join(homedir(), ".pi");
export const CLONE_WAV = path.join(CLONE_DIR, "voice-clone.wav");
export const CLONE_TXT = path.join(CLONE_DIR, "voice-clone.txt");

async function synthesize(body: Record<string, unknown>): Promise<Buffer> {
  const res = await fetch(BASE + "/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, response_format: "wav" }),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!res.ok) throw new Error(`speech failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Stock Kokoro voice, returns WAV bytes. */
export function speakTts(text: string): Promise<Buffer> {
  return synthesize({ model: "kokoro", input: text, voice: KOKORO_VOICE });
}

/** Names of the clone files that are missing (empty when the clone is complete). */
export async function cloneMissing(): Promise<string[]> {
  const exists = (f: string) => stat(f).then(() => true, () => false);
  const missing: string[] = [];
  if (!(await exists(CLONE_WAV))) missing.push(CLONE_WAV);
  if (!(await exists(CLONE_TXT))) missing.push(CLONE_TXT);
  return missing;
}

/** Speaks text in the cloned voice from ~/.pi/voice-clone.wav and its transcript. */
export async function speakClone(text: string): Promise<Buffer> {
  const missing = await cloneMissing();
  if (missing.length) throw new Error(`voice clone incomplete, missing ${missing.join(", ")} (run /voice clone-record)`);
  const [sample, refText] = await Promise.all([readFile(CLONE_WAV), readFile(CLONE_TXT, "utf8")]);
  return synthesize({
    model: "qwen3-tts",
    input: text,
    voice_ref: { type: "base64", data: sample.toString("base64") },
    reference_text: refText.trim(),
  });
}

/** Writes the clone sample and its transcript to ~/.pi. */
export async function saveClone(wav: Buffer, transcript: string): Promise<void> {
  await mkdir(CLONE_DIR, { recursive: true });
  await writeFile(CLONE_WAV, wav);
  await writeFile(CLONE_TXT, transcript);
}

/** Plays WAV bytes through a temp file that is deleted afterwards. Resolves false if stopped. */
export async function playWav(wav: Buffer): Promise<boolean> {
  const dir = await mkdtemp(path.join(tmpdir(), "salad-voice-"));
  try {
    const file = path.join(dir, "speech.wav");
    await writeFile(file, wav);
    // Deadline from the WAV header: audio length plus 2 s grace, so playback ends even if the player hangs.
    const byteRate = wav.readUInt32LE(28);
    const dataBytes = Math.min(wav.readUInt32LE(40), wav.length - 44);
    return await play(file, byteRate ? (dataBytes / byteRate) * 1000 + 2000 : undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
