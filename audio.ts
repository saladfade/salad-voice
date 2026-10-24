import { spawn, type ChildProcess } from "node:child_process";

/**
 * Records raw 16 kHz mono S16LE PCM from the default ALSA input device
 * using arecord (alsa-utils). No native modules — plain pipes.
 */
export class Recorder {
  private proc: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  failed: Error | null = null;

  start(): void {
    this.chunks = [];
    this.failed = null;
    this.proc = spawn(
      "arecord",
      ["-D", "default", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.proc.stdout.on("data", (d: Buffer) => this.chunks.push(d));
    // Drain stderr so the pipe never backs up.
    this.proc.stderr.on("data", () => {});
    this.proc.on("error", (e: Error) => {
      this.failed = e;
      this.proc = null;
    });
  }

  /** Resolves true once audio is flowing (or the recorder failed). */
  waitReady(timeoutMs = 2000): Promise<boolean> {
    if (this.failed) return Promise.resolve(false);
    if (this.chunks.length > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(!this.failed), timeoutMs);
      const proc = this.proc;
      if (!proc) {
        clearTimeout(t);
        resolve(false);
        return;
      }
      proc.stdout.once("data", () => {
        clearTimeout(t);
        resolve(true);
      });
      proc.once("error", (e: Error) => {
        this.failed = e;
        clearTimeout(t);
        resolve(false);
      });
    });
  }

  /** Elapsed recording time in ms, derived from captured bytes. */
  get durationMs(): number {
    const bytes = this.chunks.reduce((n, c) => n + c.length, 0);
    return Math.floor((bytes / 32) * 1000);
  }

  /** Stops arecord and returns the captured PCM, or null if nothing was captured. */
  async stop(): Promise<Buffer | null> {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return null;
    if (!proc.killed) proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000);
      proc.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    return pcm.length > 0 ? pcm : null;
  }
}

/**
 * Plays a WAV file with aplay (ALSA), falling back to paplay (PulseAudio)
 * if aplayer is unavailable.
 */
export class Player {
  private proc: ChildProcess | null = null;
  onEnd: ((err: string | null) => void) | null = null;

  get playing(): boolean {
    return this.proc !== null;
  }

  start(file: string): void {
    this.stop();
    this.spawn("aplay", file);
  }

  private spawn(cmd: string, file: string): void {
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, [file], { stdio: "ignore" });
    } catch (e) {
      this.onEnd?.(e instanceof Error ? e.message : String(e));
      return;
    }
    this.proc = proc;
    proc.on("close", (code) => {
      this.proc = null;
      this.onEnd?.(code === 0 ? null : `${cmd} exited with code ${code}`);
    });
    proc.on("error", (e: Error) => {
      this.proc = null;
      if (cmd === "aplay") {
        // aplayer missing/unusable → try paplay
        this.spawn("paplay", file);
      } else {
        this.onEnd?.(e.message);
      }
    });
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    if (p && !p.killed) p.kill("SIGTERM");
  }
}

/** Wraps raw S16LE mono PCM in a 44-byte RIFF/WAVE header. */
export function buildWav(pcm: Buffer, sampleRate = 16000, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
