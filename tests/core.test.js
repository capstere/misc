import test from 'node:test';
import assert from 'node:assert/strict';
import { SCALES, KEYMAP, keyNotes, degreeNote, chordNotes, arpNotes, mod, loopLength, frequency } from '../src/music.js';
import { Performance } from '../src/performance.js';

for (const scale of Object.keys(SCALES)) test(`All keys / all roots stay in ${scale}`, () => {
  for (let root = 0; root < 12; root++) for (let octave = 2; octave <= 6; octave++) {
    const state = { root, scale, octave };
    for (const code of KEYMAP.keys()) {
      const data = keyNotes(code, state);
      if (!data) { assert.notEqual(scale, 'chromatic'); continue; }
      assert.ok(data.notes.length >= 1);
      for (const midi of data.notes) {
        assert.ok(midi >= 12 && midi <= 119, `${code}: ${midi}`);
        assert.ok(SCALES[scale].steps.includes(mod(midi - root, 12)));
      }
      assert.equal(new Set(data.notes).size, data.notes.length);
    }
  }
});
test('Octave transposition, negative degrees and concert A', () => {
  for (let degree = -20; degree <= 20; degree++) {
    const state = { root: 2, scale: 'dorian', octave: 4 };
    assert.equal(degreeNote(degree, state, 5) - degreeNote(degree, state), 12);
    assert.equal(degreeNote(degree + 7, state) - degreeNote(degree, state), 12);
  }
  assert.equal(frequency(69), 440);
});
test('Chromatic mode provides every semitone and useful dominant voicings', () => {
  const state = { root: 0, scale: 'chromatic', octave: 4 };
  assert.deepEqual(chordNotes(0, state), [48, 55, 58, 64]);
  assert.deepEqual([keyNotes('BracketLeft', state).notes[0], keyNotes('BracketRight', state).notes[0]], [70, 71]);
  assert.deepEqual([...KEYMAP.keys()].slice(0, 10).map(code => keyNotes(code, state).notes[0]), [60,61,62,63,64,65,66,67,68,69]);
});
test('Arpeggio patterns de-duplicate, span octaves and avoid doubled endpoints', () => {
  assert.deepEqual(arpNotes([60, 64, 60, 67], 1, 'bounce'), [60, 64, 67, 64]);
  assert.deepEqual(arpNotes([60, 64], 2, 'down'), [76,72,64,60]);
  assert.deepEqual(arpNotes([], 2), []);
  assert.deepEqual(arpNotes([60], 1, 'bounce'), [60]);
});
test('Loop bars do not add a whole silent bar for a tiny stop overshoot', () => {
  assert.equal(loopLength(.2), 4); assert.equal(loopLength(4.03), 4);
  assert.equal(loopLength(4.2), 8); assert.equal(loopLength(32), 32);
});
class FakeSynth {
  constructor() { this.ctx = { currentTime: 100 }; this.voices = new Map(); this.calls = []; this.serial = 0; }
  play(midi, options = {}) { const id = ++this.serial; this.voices.set(id, { midi, options }); this.calls.push({ id, midi, ...options }); return id; }
  release(id, when, fast) { this.voices.delete(id); }
  cancelGroup(group, futureOnly = false) { for (const [id, v] of this.voices) if (v.options.group === group && (!futureOnly || v.options.when > this.ctx.currentTime)) this.voices.delete(id); }
  panic() { this.voices.clear(); }
  setTempo() {}
}
const fixture = () => { const synth = new FakeSynth(); return { synth, p: new Performance(synth) }; };
const melody = { role: 'melody', code: 'KeyQ', label: 'C4', notes: [60] };
const chord = { role: 'chord', code: 'KeyA', label: 'Cmaj7', notes: [48, 55, 59, 64] };
test('Overlapping sources for the same note release independently', () => {
  const { synth, p } = fixture(); p.press('keyboard', melody); p.press('pointer', melody);
  p.release('keyboard'); assert.equal(synth.voices.size, 1); p.release('pointer'); assert.equal(synth.voices.size, 0);
});
test('Sustain is released-note aware and permits rapid re-articulation', () => {
  const { synth, p } = fixture(); p.pedal(true); p.press('q', melody); p.release('q');
  assert.equal(p.sources.size, 1); assert.equal(synth.voices.size, 1);
  p.press('q', melody); assert.equal(synth.voices.size, 1); p.pedal(false);
  assert.equal(synth.voices.size, 1); p.release('q'); assert.equal(synth.voices.size, 0);
});
test('Sustain up clears all released chords but not keys still down', () => {
  const { p, synth } = fixture(); p.pedal(true); p.press('a', chord); p.release('a'); p.press('q', melody); p.pedal(false);
  assert.equal(p.sources.size, 1); assert.equal(synth.voices.size, 1);
});
test('Held notes keep their original note numbers after a scale object changes', () => {
  const { p } = fixture(); const state = { root: 2, octave: 4, scale: 'minor' };
  p.press('q', keyNotes('KeyQ', state)); state.root = 7;
  assert.deepEqual(p.sources.get('q').notes, [62]); p.release('q'); assert.equal(p.sources.size, 0);
});
test('Only chord row enters arpeggiator; melodies and bass remain immediate', () => {
  const { synth, p } = fixture(); p.setArp(true); p.press('a', chord); p.press('q', melody);
  assert.ok(synth.calls.some(c => c.group === 'arp')); assert.ok(synth.calls.some(c => c.group === 'live' && c.midi === 60));
  assert.equal(p.sources.get('a').ids.length, 0);
  p.setArp(false); assert.equal(p.sources.get('a').ids.length, 4);
});
test('Arp scheduler uses bounded audio-time lookahead and skips stale time', () => {
  const { synth, p } = fixture(); p.setArp(true); p.press('a', chord);
  assert.ok(synth.calls.every(c => c.when < 100.076));
  synth.ctx.currentTime = 150; const count = synth.calls.length; p.tick();
  assert.ok(synth.calls.length - count <= 2); assert.ok(synth.calls.at(-1).when >= 150);
});
test('Empty armed recording is cancellable', () => {
  const { p } = fixture(); p.toggleRecord(); assert.equal(p.recordState, 'armed'); p.toggleRecord();
  assert.equal(p.recordState, 'idle'); assert.equal(p.events.length, 0); assert.equal(p.playing, false);
});
test('First note starts recording; ending closes held notes and loops whole bars', () => {
  const { synth, p } = fixture(); p.toggleRecord(); synth.ctx.currentTime += 5; p.press('q', melody);
  assert.equal(p.recordStart, 105); assert.equal(p.events[0].beat, 0);
  synth.ctx.currentTime += .5; p.finishRecord();
  assert.equal(p.recordState, 'ready'); assert.equal(p.loopBeats, 4); assert.equal(p.playing, true);
  assert.ok(p.events[0].duration > 0); assert.ok(synth.calls.some(c => c.group === 'loop'));
  p.release('q'); p.stopLoop(); assert.equal(p.playing, false);
});
test('Sustain duration is recorded rather than the physical key-up', () => {
  const { synth, p } = fixture(); p.toggleRecord(); p.pedal(true); p.press('q', melody);
  synth.ctx.currentTime += .2; p.release('q'); assert.equal(p.events[0].duration, null);
  synth.ctx.currentTime += .8; p.pedal(false); assert.ok(Math.abs(p.events[0].duration - 1.6) < 1e-6);
});
test('Loop tempo changes preserve phase, recorded pitch and preset', () => {
  const { synth, p } = fixture(); p.preset = 3; p.toggleRecord(); p.press('q', melody); synth.ctx.currentTime += .3; p.release('q'); p.finishRecord();
  synth.ctx.currentTime += .6; const beat = (p.now - p.origin) * p.bpm / 60;
  p.setTempo(132); assert.ok(Math.abs((p.now - p.origin) * p.bpm / 60 - beat) < 1e-9);
  p.preset = 5; assert.equal(p.events[0].preset, 3); assert.equal(p.events[0].midi, 60);
});
test('Tempo is bounded and locked only during active recording', () => {
  const { p } = fixture(); p.setTempo(999); assert.equal(p.bpm, 180); p.setTempo(0); assert.equal(p.bpm, 96);
  p.toggleRecord(); p.press('q', melody); assert.equal(p.setTempo(100), false); assert.equal(p.bpm, 96);
});
test('Maximum eight bars automatically finalize a held recording', () => {
  const { synth, p } = fixture(); p.toggleRecord(); p.press('q', melody); synth.ctx.currentTime += 21; p.tick();
  assert.equal(p.recordState, 'ready'); assert.equal(p.loopBeats, 32); assert.ok(p.events.every(e => e.duration <= 32));
});
test('Panic stops all scheduling, sustain and held notes; phrase is retained', () => {
  const { synth, p } = fixture(); p.toggleRecord(); p.pedal(true); p.press('q', melody); synth.ctx.currentTime += .4; p.panic();
  assert.equal(p.sources.size, 0); assert.equal(p.playing, false); assert.equal(p.sustain, false); assert.equal(synth.voices.size, 0);
  assert.equal(p.recordState, 'ready'); assert.equal(p.events.length, 1); p.tick(); assert.equal(synth.voices.size, 0);
});
test('Stopping and clearing a loop never kill unrelated live notes', () => {
  const { p, synth } = fixture(); p.events = [{ midi: 60, preset: 0, role: 'melody', velocity: 1, beat: 0, duration: 1 }]; p.recordState = 'ready';
  p.startLoop(); p.press('q', melody); p.clearLoop(); assert.equal(synth.voices.size, 1); assert.equal(p.events.length, 0);
});
test('Rapid pedal/arp/preset transitions leave no orphan source', () => {
  const { p, synth } = fixture();
  for (let i = 0; i < 300; i++) { p.preset = i % 8; p.pedal(i % 3 === 0); p.press('a', chord); p.setArp(i % 2 === 0); p.release('a'); synth.ctx.currentTime += .01; p.tick(); }
  p.panic(); assert.equal(p.sources.size, 0); assert.equal(p.pool.length, 0); assert.equal(synth.voices.size, 0);
});

test('Repeated sustained touch IDs are bounded', () => {
  const { p } = fixture(); p.pedal(true);
  for (let i = 0; i < 500; i++) { p.press(`pointer:${i}`, melody); p.release(`pointer:${i}`); }
  assert.ok(p.sources.size <= 64); p.pedal(false); assert.equal(p.sources.size, 0);
});
test('High arpeggio octave expansion never schedules an inaudible out-of-range MIDI note', () => {
  const notes = arpNotes([107, 111, 115, 119], 2, 'bounce');
  assert.ok(notes.every(n => n >= 12 && n <= 119)); assert.ok(notes.includes(119));
});
