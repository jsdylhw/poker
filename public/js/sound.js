const Sound = (() => {
  let ctx = null;
  let enabled = true;

  function init() {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { enabled = false; }
  }

  function play(freq, duration, type = 'sine', volume = 0.15, ramp = true) {
    if (!enabled || !ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = volume;
    if (ramp) gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration + 0.05);
  }

  function tone(freqs, duration, type = 'sine', volume = 0.12) {
    if (!enabled || !ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = f;
      const t = ctx.currentTime + i * 0.08;
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + duration + 0.05);
    });
  }

  function deal()   { play(800, 0.08, 'sine', 0.1); }
  function chip()   { play(600, 0.06, 'triangle', 0.08); }
  function bet()    { play(400, 0.1, 'triangle', 0.1); }
  function raise()  { tone([500, 700], 0.1, 'triangle', 0.12); }
  function fold()   { play(200, 0.15, 'triangle', 0.08); }
  function allin()  { tone([300, 500, 800], 0.15, 'square', 0.1); }
  function win()    { tone([523, 659, 784, 1047], 0.2, 'sine', 0.12); }
  function tick()   { play(1000, 0.04, 'sine', 0.06); }
  function countdownAlert() { tone([880, 660, 880], 0.12, 'triangle', 0.11); }
  function check()  { play(500, 0.05, 'sine', 0.06); }
  function yourTurn(){ tone([600, 900], 0.12, 'sine', 0.1); }
  function shuffleDeck() { for (let i = 0; i < 6; i++) setTimeout(() => play(300 + Math.random() * 600, 0.03, 'triangle', 0.04), i * 40); }

  return { init, deal, chip, bet, raise, fold, allin, win, tick, countdownAlert, check, yourTurn, shuffleDeck, get enabled() { return enabled; }, set enabled(v) { enabled = v; } };
})();
