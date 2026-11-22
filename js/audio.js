// Ljudsignaler (Web Audio) och röst (Web Speech API).
let ctx = null;

/** Låser upp ljudet; måste anropas från en knapptryckning (särskilt iOS). */
export function unlockAudio() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch { /* inget ljud tillgängligt */ }
}

function tone(freq, start, dur, gain = 0.35, type = 'sine') {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t0 = ctx.currentTime + start;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
  g.gain.setValueAtTime(gain, t0 + dur - 0.05);
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

export const sounds = {
  /** Släpp gasen: två fallande toner. */
  release() { tone(880, 0, 0.18); tone(660, 0.22, 0.28); },
  /** Pausad (dålig GPS / utanför rutten): låg, lång ton. */
  pause() { tone(220, 0, 0.6, 0.3, 'triangle'); },
  /** Igång igen. */
  resume() { tone(440, 0, 0.12); tone(660, 0.15, 0.12); },
  /** Varning (nedförsbacke). */
  warn() { tone(520, 0, 0.15, 0.3, 'square'); tone(520, 0.25, 0.15, 0.3, 'square'); },
  /** Klart. */
  done() { tone(523, 0, 0.15); tone(659, 0.17, 0.15); tone(784, 0.34, 0.3); },
};

let svVoice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const vs = speechSynthesis.getVoices();
  svVoice = vs.find(v => v.lang && v.lang.toLowerCase().startsWith('sv')) || null;
  return svVoice;
}
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

export function speak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'sv-SE';
    if (svVoice || pickVoice()) u.voice = svVoice;
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch { /* röst stöds inte */ }
}
