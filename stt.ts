/**
 * whisper.cpp HTTP server client.
 * Server: docker run --rm -p 8081:8081 salad-whisper
 *   (see docker/Dockerfile in this extension)
 */
export const WHISPER_URL = process.env.SALAD_WHISPER_URL ?? "http://127.0.0.1:8081";

export async function whisperHealth(base: string = WHISPER_URL): Promise<boolean> {
  try {
    const res = await fetch(base + "/health", { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** POSTs a WAV buffer to /inference and returns the transcript text. */
export async function transcribe(wav: Buffer, base: string = WHISPER_URL): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "recording.wav");
  const res = await fetch(base + "/inference", { method: "POST", body: form });
  if (!res.ok) throw new Error(`Whisper /inference failed: ${res.status}`);
  const data = (await res.json()) as { text?: string };
  const text = (data.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("Whisper returned no text");
  return text;
}
