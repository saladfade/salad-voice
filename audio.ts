import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * Records raw 16 kHz mono S16LE PCM from the default ALSA input device
 * using arecord (alsa-utils). No native modules — plain pipes.
 */
export class Recorder {
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private chunks: Buffer[] = [];
  private stderr = "";
  failed: Error | null = null;

  start(): void {
    this.chunks = [];
    this.stderr = "";
    this.failed = null;
    const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
    const proc: ChildProcessByStdio<null, Readable, Readable> = spawn(
      "arecord",
      ["-D", "default", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw"],
      { stdio },
    );
    this.proc = proc;
    proc.stdout.on("data", (d: Buffer) => this.chunks.push(d));
    proc.stderr.on("data", (d: Buffer) => (this.stderr += d));
    proc.on("error", (e: Error) => {
      this.failed = e;
      this.proc = null;
    });
    // Exit before stop() was called (stop() clears this.proc first) means arecord failed.
    proc.on("close", (code) => {
      if (this.proc !== proc || code === 0) return;
      this.failed = new Error(this.stderr.trim() || `arecord exited with ${code}`);
      this.proc = null;
    });
  }

  /** Resolves true once audio is flowing; false if arecord fails or exits first. */
  waitReady(timeoutMs = 2000): Promise<boolean> {
    if (this.failed) return Promise.resolve(false);
    if (this.chunks.length > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const proc = this.proc;
      if (!proc) {
        resolve(false);
        return;
      }
      const finish = (ok: boolean) => {
        clearTimeout(t);
        resolve(ok && !this.failed);
      };
      const t = setTimeout(() => finish(true), timeoutMs);
      proc.stdout.once("data", () => finish(true));
      proc.once("close", () => finish(false));
      proc.once("error", (e: Error) => {
        this.failed = e;
        finish(false);
      });
    });
  }

  /** Elapsed recording time in ms, derived from captured bytes. */
  get durationMs(): number {
    const bytes = this.chunks.reduce((n, c) => n + c.length, 0);
    return Math.floor(bytes / 32); // 32 bytes per ms at 16 kHz mono S16LE
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

let playing: ChildProcess | null = null;
let active = false;
let stopped = false;

/**
 * Runs a player with no stdio and resolves only on exit code 0; tracked so stopPlayback() can kill it.
 * shortcut: when timeoutMs is set, the player is killed and treated as finished at that deadline, because
 * a player can stay alive after its audio has drained; upgrade by finding out why aplay does not exit.
 */
function run(cmd: string, args: string[], timeoutMs?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d)); // drained so the pipe never blocks the player
    playing = proc;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            done();
            proc.kill("SIGKILL");
            resolve();
          }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      if (playing === proc) playing = null;
    };
    proc.on("error", (e) => {
      done();
      reject(e);
    });
    proc.on("close", (code) => {
      done();
      if (code === 0) resolve();
      // aplay prints "Playing WAVE" only after the device opened, so a later failure means audio already played.
      else reject(Object.assign(new Error(`${cmd} exited with ${code}`), { started: stderr.includes("Playing") }));
    });
  });
}

/** Plays a WAV file with aplay, falling back to paplay on any failure. Resolves false if stopped; timeoutMs ends it early. */
export async function play(file: string, timeoutMs?: number): Promise<boolean> {
  if (stopped) return false;
  try {
    await run("aplay", [file], timeoutMs);
    return true;
  } catch (e) {
    if (stopped) return false;
    if ((e as { started?: boolean }).started) throw e; // audio already played: never replay it through paplay
  }
  try {
    await run("paplay", [file], timeoutMs);
    return true;
  } catch (e) {
    if (stopped) return false;
    throw e;
  }
}

/** Opens a playback session: a stop from here until endPlayback() sticks, even before any player runs. */
export function beginPlayback(): void {
  active = true;
  stopped = false;
}

export function endPlayback(): void {
  active = false;
  stopped = false;
}

export function wasStopped(): boolean {
  return stopped;
}

/** Kills the current playback and suppresses the paplay fallback. */
export function stopPlayback(): void {
  if (active) stopped = true;
  playing?.kill("SIGTERM");
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
