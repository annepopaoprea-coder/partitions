// Metronome with sample-accurate clicks: beats are scheduled a little ahead
// on the audio clock instead of relying on timers, so the tempo never drifts.

export class Metronome {
  bpm = 80;
  beats = 4; // per bar; the first one is accented
  sound = true;
  onBeat: (beat: number) => void = () => {};

  private ctx?: AudioContext;
  private timer?: ReturnType<typeof setInterval>;
  private nextTime = 0;
  private beat = 0;
  private visual: { at: number; beat: number }[] = [];
  private raf = 0;

  get running() {
    return this.timer !== undefined;
  }

  start() {
    if (this.running) return;
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
    this.beat = 0;
    this.nextTime = this.ctx.currentTime + 0.08;
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
    const tick = () => {
      const now = this.ctx!.currentTime;
      while (this.visual.length && this.visual[0].at <= now) this.onBeat(this.visual.shift()!.beat);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    cancelAnimationFrame(this.raf);
    this.visual = [];
  }

  private schedule() {
    const ctx = this.ctx!;
    while (this.nextTime < ctx.currentTime + 0.12) {
      if (this.sound) this.click(this.nextTime, this.beat === 0);
      this.visual.push({ at: this.nextTime, beat: this.beat });
      this.nextTime += 60 / this.bpm;
      this.beat = (this.beat + 1) % Math.max(1, this.beats);
    }
  }

  private click(at: number, accent: boolean) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1100;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.5, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.06);
  }
}

// Tap tempo: average of the last taps, reset after a 2-second pause.
export class TapTempo {
  private taps: number[] = [];

  tap(now = performance.now()): number | null {
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    this.taps = this.taps.slice(-6);
    if (this.taps.length < 2) return null;
    const span = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
    return Math.round(60000 / span);
  }
}
