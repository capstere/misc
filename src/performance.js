import { arpNotes, clamp, loopLength } from './music.js';

// The audio clock owns musical time. The interval only fills a short scheduling window.
export class Performance {
  constructor(synth, changed = () => {}) {
    this.synth = synth; this.changed = changed;
    this.sources = new Map(); this.sustain = false; this.preset = 0; this.bpm = 96;
    this.arp = false; this.pattern = 'bounce'; this.division = .5; this.octaves = 1; this.gate = .72;
    this.pool = []; this.nextArp = 0; this.arpStep = 0;
    this.recordState = 'idle'; this.events = []; this.pending = new Map();
    this.recordStart = 0; this.recordTempo = 96; this.loopBeats = 4;
    this.playing = false; this.origin = 0; this.cursor = 0; this.timer = null;
  }
  get now() { return this.synth.ctx.currentTime; }
  startClock() { if (!this.timer) this.timer = setInterval(() => this.tick(), 20); }
  stopClock() { clearInterval(this.timer); this.timer = null; }
  sound(midi, options = {}) {
    const when = options.when ?? this.now;
    options = { preset: this.preset, ...options };
    const id = this.synth.play(midi, options);
    if (id === null || options.group === 'loop') return id;
    if (this.recordState === 'armed') {
      this.recordState = 'recording'; this.recordStart = when; this.recordTempo = this.bpm; this.changed();
    }
    if (this.recordState === 'recording' && this.events.length < 2048) {
      const event = { midi, preset: options.preset ?? this.preset, role: options.role || 'melody', velocity: options.velocity ?? 1,
        beat: Math.max(0, (when - this.recordStart) * this.recordTempo / 60),
        duration: options.duration === undefined ? null : options.duration * this.recordTempo / 60 };
      this.events.push(event);
      if (event.duration === null) this.pending.set(id, event);
    }
    return id;
  }
  off(id, when = this.now, fast) {
    const event = this.pending.get(id);
    if (event) { event.duration = Math.max(.02, (when - this.recordStart) * this.recordTempo / 60 - event.beat); this.pending.delete(id); }
    this.synth.release(id, when, fast);
  }
  press(source, data) {
    if (this.sources.has(source)) this.release(source, true);
    // Pointer IDs change between touches; sustain must not accumulate them forever.
    if (this.sources.size >= 64) {
      const old = [...this.sources].find(([, entry]) => !entry.down)?.[0] ?? this.sources.keys().next().value;
      this.release(old, true);
    }
    const entry = { ...data, down: true, ids: [], preset: this.preset };
    this.sources.set(source, entry);
    if (!(this.arp && data.role === 'chord')) this.playEntry(entry);
    this.updatePool(); if (this.arp) this.tick(); this.changed();
  }
  playEntry(entry) {
    const velocity = entry.role === 'chord' ? .65 : entry.role === 'bass' ? .86 : .96;
    entry.ids = entry.notes.map(midi => this.sound(midi, { preset: this.preset, role: entry.role, velocity, group: 'live' }));
  }
  release(source, force = false) {
    const entry = this.sources.get(source); if (!entry) return;
    entry.down = false;
    if (this.sustain && !force) { this.changed(); return; }
    entry.ids.forEach(id => this.off(id)); this.sources.delete(source);
    this.updatePool(); this.changed();
  }
  pedal(on) {
    this.sustain = on;
    if (!on) for (const [source, entry] of this.sources) if (!entry.down) this.release(source, true);
    this.changed();
  }
  updatePool() {
    const notes = [];
    for (const entry of this.sources.values()) if (entry.role === 'chord') notes.push(...entry.notes);
    this.pool = arpNotes(notes, this.octaves, this.pattern);
    if (!this.pool.length) { this.nextArp = 0; this.arpStep = 0; this.synth.cancelGroup('arp', true); }
  }
  setArp(on) {
    this.arp = on; this.synth.cancelGroup('arp');
    for (const entry of this.sources.values()) if (entry.role === 'chord') {
      entry.ids.forEach(id => this.off(id)); entry.ids = [];
      if (!on) this.playEntry(entry);
    }
    this.arpStep = 0; this.nextArp = 0; this.updatePool(); this.changed();
  }
  configureArp({ pattern = this.pattern, division = this.division, octaves = this.octaves, gate = this.gate }) {
    this.pattern = pattern; this.division = division; this.octaves = octaves; this.gate = gate;
    this.synth.cancelGroup('arp', true); this.nextArp = 0; this.arpStep = 0; this.updatePool(); this.changed();
  }
  setTempo(value) {
    if (this.recordState === 'recording') return false;
    const bpm = clamp(Math.round(Number(value) || 96), 45, 180), now = this.now;
    const beat = this.playing ? (now - this.origin) * this.bpm / 60 : 0;
    this.bpm = bpm; this.synth.setTempo(bpm);
    if (this.playing) {
      this.synth.cancelGroup('loop', true); this.origin = now - beat * 60 / bpm; this.seek(beat);
    }
    this.synth.cancelGroup('arp', true); this.nextArp = 0; this.changed(); return true;
  }
  toggleRecord() {
    if (this.recordState === 'recording') return this.finishRecord();
    if (this.recordState === 'armed') { this.recordState = 'idle'; this.changed(); return; }
    this.stopLoop(); this.events = []; this.pending.clear(); this.loopBeats = 4;
    this.recordState = 'armed'; this.changed();
  }
  finishRecord(play = true, end = this.now) {
    if (this.recordState !== 'recording') { this.recordState = this.events.length ? 'ready' : 'idle'; this.changed(); return; }
    const beats = Math.min(32, Math.max(.02, (end - this.recordStart) * this.recordTempo / 60));
    for (const event of this.events) event.duration = Math.max(.02, Math.min(event.duration ?? beats - event.beat, beats - event.beat));
    this.events = this.events.filter(e => e.beat < beats).sort((a, b) => a.beat - b.beat);
    this.pending.clear(); this.loopBeats = loopLength(beats); this.recordState = this.events.length ? 'ready' : 'idle';
    if (play) this.startLoop(); this.changed();
  }
  startLoop() {
    if (!this.events.length || this.recordState === 'recording' || this.recordState === 'armed') return;
    this.synth.cancelGroup('loop'); this.playing = true; this.origin = this.now + .025; this.cursor = 0; this.tick(); this.changed();
  }
  stopLoop() { this.playing = false; this.synth.cancelGroup('loop'); this.changed(); }
  toggleLoop() { if (this.playing) this.stopLoop(); else this.startLoop(); }
  clearLoop() { this.stopLoop(); this.events = []; this.pending.clear(); this.recordState = 'idle'; this.loopBeats = 4; this.changed(); }
  seek(beat) {
    const cycle = Math.max(0, Math.floor(beat / this.loopBeats));
    const phase = beat - cycle * this.loopBeats;
    const i = this.events.findIndex(e => e.beat >= phase + .001);
    this.cursor = i < 0 ? (cycle + 1) * this.events.length : cycle * this.events.length + i;
  }
  tick() {
    const now = this.now, horizon = now + .075;
    if (this.recordState === 'recording' && (now - this.recordStart >= 32 * 60 / this.recordTempo || this.events.length >= 2048)) this.finishRecord();
    if (this.arp && this.pool.length) {
      if (this.nextArp < now - .08 || !this.nextArp) this.nextArp = now + .004;
      let guard = 0;
      while (this.nextArp < horizon && guard++ < 16) {
        const i = this.pattern === 'random' ? Math.floor(Math.random() * this.pool.length) : this.arpStep % this.pool.length;
        const step = 60 / this.bpm * this.division;
        this.sound(this.pool[i], { preset: this.preset, role: 'melody', when: this.nextArp,
          duration: step * this.gate, velocity: this.arpStep % 4 === 0 ? .9 : .77, group: 'arp' });
        this.arpStep++; this.nextArp += step;
      }
    }
    if (this.playing && this.events.length) {
      const count = this.events.length;
      const at = () => this.origin + (Math.floor(this.cursor / count) * this.loopBeats + this.events[this.cursor % count].beat) * 60 / this.bpm;
      if (at() < now - .08) this.seek((now - this.origin) * this.bpm / 60);
      let guard = 0;
      while (at() < horizon && guard++ < 256) {
        const event = this.events[this.cursor % count];
        this.synth.play(event.midi, { ...event, when: at(), duration: event.duration * 60 / this.bpm, group: 'loop' }); this.cursor++;
      }
    }
  }
  panic() {
    if (this.recordState === 'recording') this.finishRecord(false);
    else if (this.recordState === 'armed') this.recordState = 'idle';
    this.playing = false; this.sources.clear(); this.pending.clear(); this.sustain = false;
    this.pool = []; this.nextArp = 0; this.arpStep = 0;
    this.synth.panic(); this.changed();
  }
}
