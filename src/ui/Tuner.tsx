import { useEffect, useRef, useState } from 'preact/hooks';
import { back } from '../app';
import { DIAPASONS, detectPitch, INSTRUMENTS, nearestNote, stringFreq, TEMPERAMENTS, temperament, type Reading } from '../tuner';

function saved<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`tuner.${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function persist(key: string, v: unknown) {
  localStorage.setItem(`tuner.${key}`, JSON.stringify(v));
}

export function Tuner() {
  const [a4, setA4] = useState<number>(saved('a4', 415));
  const [tempId, setTempId] = useState<string>(saved('temperament', 'egal'));
  const [instrument, setInstrument] = useState<string>(saved('instrument', 'violon'));
  const [listening, setListening] = useState(false);
  const [reading, setReading] = useState<(Reading & { hz: number }) | null>(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState<number | null>(null);
  const audio = useRef<{ ctx: AudioContext; stream?: MediaStream; raf?: number; osc?: OscillatorNode; gain?: GainNode } | null>(null);
  const history = useRef<number[]>([]);

  const dev = temperament(tempId);
  const inst = INSTRUMENTS.find((i) => i.id === instrument) ?? INSTRUMENTS[0];
  const custom = !DIAPASONS.some((d) => d.hz === a4);

  useEffect(() => () => stopAll(), []);

  function ctx() {
    audio.current ??= { ctx: new AudioContext() };
    void audio.current.ctx.resume();
    return audio.current.ctx;
  }

  async function listen() {
    if (listening) return stopListening();
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const ac = ctx();
      const src = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 4096;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      audio.current!.stream = stream;
      let last = 0;
      const loop = (t: number) => {
        if (t - last > 60) {
          last = t;
          analyser.getFloatTimeDomainData(buf);
          const hz = detectPitch(buf, ac.sampleRate);
          if (hz) {
            // Median of recent readings keeps the needle steady.
            history.current = [...history.current.slice(-4), hz];
            const med = [...history.current].sort((x, y) => x - y)[Math.floor(history.current.length / 2)];
            setReading({ ...nearestNote(med, a4Ref.current, devRef.current), hz: med });
          }
        }
        audio.current!.raf = requestAnimationFrame(loop);
      };
      audio.current!.raf = requestAnimationFrame(loop);
      setListening(true);
    } catch {
      setError("Le micro n'est pas accessible. Autorisez-le pour cette app dans le navigateur.");
    }
  }

  // The loop reads the latest settings without restarting the microphone.
  const a4Ref = useRef(a4);
  const devRef = useRef(dev);
  a4Ref.current = a4;
  devRef.current = dev;

  function stopListening() {
    const a = audio.current;
    if (a?.raf) cancelAnimationFrame(a.raf);
    a?.stream?.getTracks().forEach((t) => t.stop());
    if (a) a.stream = undefined;
    history.current = [];
    setListening(false);
    setReading(null);
  }

  function stopTone() {
    const a = audio.current;
    if (a?.osc && a.gain) {
      a.gain.gain.setTargetAtTime(0, a.ctx.currentTime, 0.05);
      a.osc.stop(a.ctx.currentTime + 0.3);
      a.osc = undefined;
    }
    setPlaying(null);
  }

  function play(hz: number) {
    if (playing === hz) return stopTone();
    stopTone();
    const ac = ctx();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    // A soft, slightly bright tone that is easy to tune against.
    const real = new Float32Array([0, 1, 0.45, 0.2, 0.1]);
    osc.setPeriodicWave(ac.createPeriodicWave(real, new Float32Array(real.length)));
    osc.frequency.value = hz;
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.25, ac.currentTime, 0.05);
    osc.connect(gain).connect(ac.destination);
    osc.start();
    audio.current!.osc = osc;
    audio.current!.gain = gain;
    setPlaying(hz);
  }

  function stopAll() {
    stopListening();
    stopTone();
  }

  const cents = reading ? Math.max(-50, Math.min(50, reading.cents)) : 0;
  const inTune = reading && Math.abs(reading.cents) <= 3;

  return (
    <div class="screen tuner">
      <header class="topbar">
        <button class="icon" onClick={back}>
          ←
        </button>
        <h1>Accordeur</h1>
      </header>
      <div class="form">
        <section class="tuner-display">
          <div class={`note ${inTune ? 'ok' : ''}`}>
            {reading ? (
              <>
                {reading.name}
                <sub>{reading.octave}</sub>
              </>
            ) : (
              '—'
            )}
          </div>
          <div class="gauge">
            <div class="scale">
              <span>−50</span>
              <span>0</span>
              <span>+50</span>
            </div>
            <div class="track">
              <div class="center" />
              {reading && <div class={`needle ${inTune ? 'ok' : ''}`} style={{ left: `${50 + cents}%` }} />}
            </div>
          </div>
          <p class="hint">
            {reading
              ? `${reading.hz.toFixed(1)} Hz · cible ${reading.target.toFixed(1)} Hz · ${reading.cents > 0 ? '+' : ''}${reading.cents.toFixed(0)} cents`
              : listening
                ? 'Jouez une note…'
                : 'Touchez « Écouter » et jouez une note.'}
          </p>
          <button class={listening ? 'wide' : 'primary wide'} onClick={listen}>
            {listening ? '■ Arrêter le micro' : '🎤 Écouter'}
          </button>
          {error && <p class="error">{error}</p>}
        </section>

        <section>
          <h2>Diapason</h2>
          <select
            value={custom ? 'custom' : String(a4)}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              const hz = v === 'custom' ? 415 : Number(v);
              setA4(hz);
              persist('a4', hz);
              stopTone();
            }}
          >
            {DIAPASONS.map((d) => (
              <option value={d.hz}>{d.label}</option>
            ))}
            <option value="custom">Autre…</option>
          </select>
          <label>
            La (Hz)
            <input
              type="number"
              min={380}
              max={480}
              step={0.5}
              value={a4}
              onChange={(e) => {
                const hz = Number((e.target as HTMLInputElement).value);
                if (hz >= 380 && hz <= 480) {
                  setA4(hz);
                  persist('a4', hz);
                  stopTone();
                }
              }}
            />
          </label>
        </section>

        <section>
          <h2>Tempérament</h2>
          <select
            value={tempId}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setTempId(v);
              persist('temperament', v);
              stopTone();
            }}
          >
            {TEMPERAMENTS.map((t) => (
              <option value={t.id}>{t.label}</option>
            ))}
          </select>
          <p class="hint">
            Le La est toujours au diapason choisi ; les autres notes suivent le tempérament (utile pour jouer avec un clavecin ou
            un orgue accordé ainsi).
          </p>
        </section>

        <section>
          <h2>Cordes à vide</h2>
          <select
            value={instrument}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setInstrument(v);
              persist('instrument', v);
              stopTone();
            }}
          >
            {INSTRUMENTS.map((i) => (
              <option value={i.id}>{i.label}</option>
            ))}
          </select>
          <div class="strings">
            {inst.strings.map((s) => {
              const hz = stringFreq(s, a4, dev);
              return (
                <button class={playing === hz ? 'primary' : ''} onClick={() => play(hz)}>
                  {s.name}
                  <small>{hz.toFixed(1)} Hz</small>
                </button>
              );
            })}
          </div>
          <p class="hint">
            {inst.id === 'gambe'
              ? 'Touchez une corde pour entendre la note, accordée selon le tempérament.'
              : 'Touchez une corde pour entendre la note. Les cordes sont en quintes justes à partir du La.'}
          </p>
        </section>
      </div>
    </div>
  );
}
