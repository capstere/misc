import { clamp, frequency } from './music.js';
const EPS = 0.00001;
export const PRESETS = [
  { name: 'Ember', kind: 'WARM ANALOG', text: 'Mjuka kanter. En liten elektrisk glöd.', color: '#e9b588', a: .012, d: .5, s: .58, r: .65, cut: 1800, env: 2400, q: .65, level: .17, osc: [['sawtooth', .32, 1, -5], ['sawtooth', .32, 1, 5], ['triangle', .36, 1, 0]], wet: .22 },
  { name: 'Velvet', kind: 'ELECTRIC KEYS', text: 'Mjuka tangenter med en klang av glas.', color: '#dec6a0', a: .003, d: 1.5, s: .1, r: .7, cut: 6200, env: 2000, q: .5, level: .07, osc: [['sine', .9, 1, 0], ['sine', .1, 4.003, 0, .25]], fm: [2, .85, .35], wet: .18 },
  { name: 'Halo', kind: 'WIDE DREAM PAD', text: 'Håll ett ackord. Låt rummet öppna sig.', color: '#b8b1ef', a: .18, d: 1.2, s: .7, r: 1.8, cut: 2400, env: 1300, q: .55, level: .15, osc: [['sawtooth', .32, 1, -9], ['sawtooth', .32, 1, 9], ['triangle', .36, 1, 0]], wet: .55 },
  { name: 'Glass', kind: 'FM CRYSTAL', text: 'Klara droppar som stannar i luften.', color: '#a6dce0', a: .003, d: 1.3, s: .025, r: 1.05, cut: 10500, env: 500, q: .45, level: .065, osc: [['sine', .86, 1, 0], ['sine', .14, 2.01, 0, .45]], fm: [3.5, 2.3, .24], wet: .48 },
  { name: 'Undertow', kind: 'DEEP & DARK', text: 'Lågt, tätt och precis under ytan.', color: '#95bca6', a: .006, d: .3, s: .45, r: .25, cut: 700, env: 1800, q: 1.1, level: .15, osc: [['sawtooth', .4, 1, 0], ['square', .2, .5, 0], ['triangle', .4, 1, 0]], wet: .08 },
  { name: 'Neon', kind: 'RETRO PULSE', text: 'Ett nattåg genom en stad av ljus.', color: '#f0a4bc', a: .004, d: .24, s: .3, r: .22, cut: 2100, env: 3700, q: .85, level: .195, osc: [['square', .3, 1, -3], ['sawtooth', .5, 1, 3], ['triangle', .2, 1, 0]], wet: .28 },
  { name: 'Moss', kind: 'ORGANIC PLUCK', text: 'Trä, strängar och ett mjukt anslag.', color: '#c4d49c', a: .003, d: .42, s: .015, r: .24, cut: 1800, env: 5200, q: .55, level: .29, osc: [['triangle', .78, 1, 0], ['sine', .14, 2.003, 0, .2], ['sawtooth', .08, 1, 0]], wet: .3 },
  { name: 'Satellite', kind: 'CINEMATIC AIR', text: 'En långsam signal från någon annanstans.', color: '#acbde7', a: .09, d: 1.8, s: .48, r: 2, cut: 2700, env: 1800, q: .6, level: .135, osc: [['triangle', .44, 1, 0], ['sawtooth', .23, 1, -7], ['sawtooth', .23, 1, 7], ['sine', .1, 2, 0]], fm: [1.002, .16, 2], wet: .6 }
];
const BASS = { a: .006, d: .24, s: .58, r: .2, cut: 580, env: 850, q: .6, level: .2, osc: [['triangle', .7, 1, 0], ['sine', .2, 1, 0], ['sawtooth', .1, 1, 0]], wet: .045 };
function disconnect(nodes) { for (const node of nodes) { try { node.disconnect(); } catch {} } }
function impulse(ctx) {
  const buffer = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 2.6), ctx.sampleRate);
  let seed = 136;
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c); let low = 0;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      low = low * .63 + (seed / 2147483648 - 1) * .37;
      const t = i / ctx.sampleRate;
      data[i] = low * Math.exp(-t * 2.8) * Math.min(1, t * 130);
    }
  }
  return buffer;
}
function envelopeAt(v, time) {
  const t = time - v.when;
  if (t <= 0) return EPS;
  if (t < v.sound.a) return EPS + (v.peak - EPS) * t / v.sound.a;
  const decay = clamp((t - v.sound.a) / v.sound.d, 0, 1);
  return v.peak * Math.pow(Math.max(EPS, v.sound.s), decay);
}
export class Synth {
  constructor(context) {
    this.ctx = context; this.voices = new Map(); this.serial = 0;
    this.tone = .48; this.space = .48; this.expression = false; this.volume = .72; this.bpm = 96;
    this.ir = impulse(context);
    this.compressor = context.createDynamicsCompressor();
    Object.assign(this.compressor.threshold, { value: -15 });
    this.compressor.knee.value = 16; this.compressor.ratio.value = 8;
    this.compressor.attack.value = .003; this.compressor.release.value = .18;
    this.ceiling = context.createWaveShaper();
    const curve = new Float32Array(2049);
    for (let i = 0; i < curve.length; i++) { const x = i / (curve.length - 1) * 2 - 1; curve[i] = .94 * Math.tanh(1.25 * x) / Math.tanh(1.25); }
    this.ceiling.curve = curve;
    this.master = context.createGain(); this.master.gain.value = this.volume;
    this.analyser = context.createAnalyser(); this.analyser.fftSize = 512; this.analyser.smoothingTimeConstant = .7;
    this.compressor.connect(this.ceiling).connect(this.master).connect(this.analyser).connect(context.destination);
    this.graph = this.makeGraph();
  }
  makeGraph() {
    const c = this.ctx, nodes = [], node = kind => { const n = c[kind](); nodes.push(n); return n; };
    const dry = node('createGain'), send = node('createGain'), kill = node('createGain');
    const highpass = node('createBiquadFilter'); highpass.type = 'highpass'; highpass.frequency.value = 28;
    dry.connect(highpass).connect(kill); kill.connect(this.compressor);
    const reverb = node('createConvolver'); reverb.buffer = this.ir;
    const reverbLevel = node('createGain'); reverbLevel.gain.value = .64;
    send.connect(reverb).connect(reverbLevel).connect(kill);
    const delay = node('createDelay'), feedback = node('createGain'), damping = node('createBiquadFilter'), delayLevel = node('createGain');
    delay.delayTime.value = 60 / this.bpm * .75; feedback.gain.value = .3;
    damping.type = 'lowpass'; damping.frequency.value = 2400; delayLevel.gain.value = .32;
    send.connect(delay).connect(damping).connect(feedback).connect(delay);
    damping.connect(delayLevel).connect(kill);
    const chorus = node('createDelay'), chorusLevel = node('createGain'), lfoGain = node('createGain'), lfo = node('createOscillator');
    chorus.delayTime.value = .018; chorusLevel.gain.value = .23; lfo.frequency.value = .27; lfoGain.gain.value = .003;
    lfo.connect(lfoGain).connect(chorus.delayTime); lfo.start();
    send.connect(chorus).connect(chorusLevel).connect(kill);
    return { dry, send, kill, delay, nodes, lfo };
  }
  play(midi, { preset = 0, role = 'melody', when = this.ctx.currentTime, velocity = 1, duration, group = 'live' } = {}) {
    when = Math.max(this.ctx.currentTime, when);
    const sound = role === 'bass' ? BASS : PRESETS[preset] || PRESETS[0];
    if (!Number.isFinite(midi) || midi < 12 || midi > 119) return null;
    // Prefer stealing release tails, then the oldest voice. Bounded even with sustain.
    if (this.voices.size >= 48) {
      const oldest = [...this.voices.values()].find(v => v.released) || this.voices.values().next().value;
      this.release(oldest.id, this.ctx.currentTime, .009); this.voices.delete(oldest.id);
    }
    const c = this.ctx, id = ++this.serial, hz = frequency(midi), nodes = [], sources = [];
    const amp = c.createGain(), filter = c.createBiquadFilter(), pan = c.createStereoPanner(), send = c.createGain();
    nodes.push(amp, filter, pan, send);
    filter.type = 'lowpass'; filter.Q.value = sound.q;
    const peak = sound.level * clamp(velocity, .2, 1.2);
    const v = { id, midi, sound, when, peak, amp, filter, send, nodes, sources, group, released: false, preset, role };
    const cutoff = this.cutoff(v);
    filter.frequency.setValueAtTime(clamp(cutoff + sound.env, 60, c.sampleRate * .44), when);
    filter.frequency.exponentialRampToValueAtTime(cutoff, when + sound.a + sound.d);
    amp.gain.setValueAtTime(EPS, when);
    amp.gain.linearRampToValueAtTime(peak, when + sound.a);
    amp.gain.exponentialRampToValueAtTime(Math.max(EPS, peak * sound.s), when + sound.a + sound.d);
    pan.pan.value = role === 'bass' ? 0 : clamp((midi - 66) / 80, -.3, .3);
    send.gain.value = sound.wet * this.space * 1.5;
    filter.connect(amp).connect(pan); pan.connect(this.graph.dry); pan.connect(send).connect(this.graph.send);
    for (const [type, level, ratio, detune, decay] of sound.osc) {
      const osc = c.createOscillator(), gain = c.createGain();
      osc.type = type; osc.frequency.value = hz * ratio; osc.detune.value = detune;
      gain.gain.setValueAtTime(level, when);
      if (decay) gain.gain.exponentialRampToValueAtTime(EPS, when + decay * 5);
      osc.connect(gain).connect(filter); nodes.push(osc, gain); sources.push(osc);
    }
    if (sound.fm) {
      const mod = c.createOscillator(), index = c.createGain();
      mod.frequency.value = hz * sound.fm[0];
      index.gain.setValueAtTime(hz * sound.fm[1], when);
      index.gain.exponentialRampToValueAtTime(Math.max(.1, hz * sound.fm[1] * .015), when + sound.fm[2] * 5);
      mod.connect(index).connect(sources[0].frequency); nodes.push(mod, index); sources.push(mod);
    }
    for (const src of sources) src.start(when);
    sources[0].onended = () => { disconnect(nodes); this.voices.delete(id); };
    this.voices.set(id, v);
    if (duration !== undefined) this.release(id, when + Math.max(.015, duration));
    return id;
  }
  cutoff(v) { return clamp(v.sound.cut * 2 ** ((this.tone - .5) * 3 + (this.expression ? 1.5 : 0)) * 2 ** ((v.midi - 60) / 48), 70, this.ctx.sampleRate * .44); }
  release(id, when = this.ctx.currentTime, fast) {
    const v = this.voices.get(id); if (!v) return;
    if (v.released && fast === undefined) return;
    const t = Math.max(this.ctx.currentTime, when);
    const release = fast ?? v.sound.r;
    // Analytic envelope value also works in Firefox without cancelAndHoldAtTime.
    const level = v.released ? Math.min(v.peak, Math.max(EPS, v.amp.gain.value)) : envelopeAt(v, t);
    v.amp.gain.cancelScheduledValues(t);
    v.amp.gain.setValueAtTime(t < v.when ? EPS : Math.max(EPS, level), t);
    v.amp.gain.exponentialRampToValueAtTime(EPS, t + release);
    for (const src of v.sources) { try { src.stop(t + release + .015); } catch {} }
    v.released = true; v.off = t;
  }
  cancelGroup(group, futureOnly = false) {
    for (const v of this.voices.values()) if (v.group === group && (!futureOnly || v.when > this.ctx.currentTime)) this.release(v.id, this.ctx.currentTime, .012);
  }
  setTone(value, expression = this.expression) {
    this.tone = clamp(value, 0, 1); this.expression = expression;
    const t = this.ctx.currentTime;
    for (const v of this.voices.values()) { v.filter.frequency.cancelScheduledValues(t); v.filter.frequency.setTargetAtTime(this.cutoff(v), t, .035); }
  }
  setSpace(value) {
    this.space = clamp(value, 0, 1);
    for (const v of this.voices.values()) v.send.gain.setTargetAtTime(v.sound.wet * this.space * 1.5, this.ctx.currentTime, .05);
  }
  setVolume(value) { this.volume = clamp(value, 0, 1); this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, .025); }
  setTempo(bpm) { this.bpm = bpm; this.graph.delay.delayTime.setTargetAtTime(60 / bpm * .75, this.ctx.currentTime, .12); }
  panic() {
    const old = this.graph, t = this.ctx.currentTime;
    old.kill.gain.cancelScheduledValues(t); old.kill.gain.setValueAtTime(1, t); old.kill.gain.linearRampToValueAtTime(0, t + .009);
    for (const v of this.voices.values()) this.release(v.id, t, .009);
    this.voices.clear(); old.lfo.stop(t + .02); old.lfo.onended = () => disconnect(old.nodes);
    this.graph = this.makeGraph(); this.expression = false;
  }
  async dispose() {
    this.panic(); this.graph.lfo.stop(); disconnect(this.graph.nodes);
    disconnect([this.compressor, this.ceiling, this.master, this.analyser]);
    if (this.ctx.close) await this.ctx.close();
  }
}
