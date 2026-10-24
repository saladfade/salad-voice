import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component } from "@earendil-works/pi-tui";
import { Recorder, buildWav } from "./audio.js";
import { containerState, ensureRunning, health, loadedModels, stopContainer, transcribe } from "./stt.js";

/**
 * salad-voice — local dictation for the Pi TUI, via the audio.cpp container.
 *
 *   /voice          record microphone; Enter transcribes and pastes the text into the editor, Esc cancels
 *   /voice status   container state, health and loaded models
 *   /voice stop     stop the container
 *
 * The container (docker/) starts on first use. Requires alsa-utils (arecord) and docker.
 */
export default function (pi: ExtensionAPI) {
  // Register commands at load time (not just on startup) so /voice works
  // in "new", "resume", "fork" sessions too.
  pi.registerCommand("voice", {
    description: "Voice: /voice (dictate into the editor), /voice status, /voice stop",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim();
      if (sub === "stop") return handleStop(ctx);
      if (sub === "status") return handleStatus(ctx);
      return handleDictate(ctx);
    },
  });

  async function handleDictate(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.setStatus("voice", "Dictation requires the TUI.");
      return;
    }
    try {
      await ensureRunning((msg) => ctx.ui.setStatus("voice", msg));
    } catch (e) {
      ctx.ui.setStatus("voice", `Transcription container not available: ${errMsg(e)}`);
      return;
    }

    const recorder = new Recorder();
    recorder.start();
    const ready = await recorder.waitReady();
    if (!ready) {
      ctx.ui.setStatus("voice", `Microphone unavailable: ${recorder.failed?.message ?? "no audio captured"}`);
      return;
    }

    const pcm = await ctx.ui.custom<Buffer | null>((_tui, theme, _keybindings, done) => new RecordingComponent(theme, recorder, done));
    if (!pcm) {
      ctx.ui.setStatus("voice", "Dictation cancelled.");
      return;
    }

    ctx.ui.setStatus("voice", "Transcribing…");
    try {
      const text = await transcribe(buildWav(pcm));
      if (!text) {
        ctx.ui.setStatus("voice", "No speech detected.");
        return;
      }
      ctx.ui.pasteToEditor(text);
      ctx.ui.setStatus("voice", "Transcript pasted into the editor ✓");
    } catch (e) {
      ctx.ui.setStatus("voice", `Transcription failed: ${errMsg(e)}`);
    }
  }

  async function handleStop(ctx: ExtensionCommandContext): Promise<void> {
    try {
      await stopContainer();
      ctx.ui.setStatus("voice", "Container stopped.");
    } catch (e) {
      ctx.ui.setStatus("voice", `Stop failed: ${errMsg(e)}`);
    }
  }

  async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
    const state = await containerState();
    const ok = await health();
    const loaded = ok ? (await loadedModels().catch(() => [])).join(", ") || "none" : "—";
    ctx.ui.setStatus("voice", `Container: ${state} · Health: ${ok ? "ok" : "not reachable"} · Models: ${loaded}`);
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Full-screen "listening" overlay for dictation. Enter resolves with the PCM, Esc with null. */
class RecordingComponent implements Component {
  private finished = false;
  constructor(
    private theme: Theme,
    private recorder: Recorder,
    private onDone: (pcm: Buffer | null) => void,
  ) {}

  handleInput(data: string): void {
    if (this.finished) return;
    const cancel = matchesKey(data, "escape");
    if (!cancel && !matchesKey(data, "enter") && !matchesKey(data, "return")) return;
    this.finished = true;
    void this.recorder.stop().then((pcm) => this.onDone(cancel ? null : pcm));
  }

  render(): string[] {
    const s = Math.floor(this.recorder.durationMs / 1000);
    const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    return [
      this.theme.fg("accent", `🎙 Listening… ${t}`),
      this.theme.fg("dim", "Enter = transcribe · Esc = cancel"),
    ];
  }

  invalidate(): void {}
}
