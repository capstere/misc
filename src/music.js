export const ROOTS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export const SCALES = {
  pentatonic: { name: 'Minor pent.', steps: [0, 3, 5, 7, 10] },
  majorPent: { name: 'Major pent.', steps: [0, 2, 4, 7, 9] },
  minor: { name: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  major: { name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  dorian: { name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  blues: { name: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  chromatic: { name: 'Chromatic / fri', steps: Array.from({ length: 12 }, (_, i) => i) }
};
export const ROWS = [
  { role: 'melody', name: 'Melodi', keys: 'QWERTYUIOP' },
  { role: 'chord', name: 'Ackord', keys: 'ASDFGHJKL' },
  { role: 'bass', name: 'Bas', keys: 'ZXCVBNM' }
];
export const KEYMAP = new Map(ROWS.flatMap(row => [...row.keys].map((key, degree) => [`Key${key}`, { role: row.role, degree }])));
KEYMAP.set('BracketLeft', { role: 'melody', degree: 10, freeOnly: true });
KEYMAP.set('BracketRight', { role: 'melody', degree: 11, freeOnly: true });
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const mod = (v, n) => ((v % n) + n) % n;
export const noteName = (midi, octave = false) => ROOTS[mod(midi, 12)] + (octave ? Math.floor(midi / 12) - 1 : '');
export const frequency = midi => 440 * 2 ** ((midi - 69) / 12);
export function degreeNote(degree, state, octave = state.octave) {
  const steps = SCALES[state.scale].steps;
  return (octave + 1) * 12 + state.root + Math.floor(degree / steps.length) * 12 + steps[mod(degree, steps.length)];
}
// Open voicings. Every pitch remains in the selected scale, including pentatonic/blues.
export function chordNotes(degree, state) {
  const root = degreeNote(degree, state, state.octave - 1);
  if (state.scale === 'chromatic') return [root, root + 7, root + 10, root + 16];
  const steps = SCALES[state.scale].steps;
  if (steps.length === 7) return [0, 4, 6, 2].map((offset, i) => degreeNote(degree + offset, state, state.octave - 1) + (i === 3 ? 12 : 0));
  const candidates = Array.from({ length: steps.length }, (_, i) => degreeNote(degree + i, state, state.octave - 1));
  const choose = (target, min, max) => candidates.filter(n => n - root >= min && n - root <= max)
    .sort((a, b) => Math.abs(a - root - target) - Math.abs(b - root - target))[0];
  const third = choose(4, 2, 5) ?? root + 12;
  const fifth = choose(7, 6, 8);
  const color = choose(10, 9, 11);
  return [...new Set([root, fifth ?? root + 12, color ?? third, third + 12])].sort((a, b) => a - b);
}
export function chordName(notes) {
  const root = notes[0];
  const intervals = new Set(notes.map(n => mod(n - root, 12)));
  let quality = intervals.has(3) ? 'm' : intervals.has(4) ? '' : intervals.has(5) ? 'sus4' : 'sus2';
  if (intervals.has(6) && !intervals.has(7)) quality = intervals.has(10) ? 'm7♭5' : 'dim';
  else if (intervals.has(11)) quality += 'maj7';
  else if (intervals.has(10)) quality += '7';
  else if (intervals.has(9)) quality += '6';
  return noteName(root) + quality;
}
export function keyNotes(code, state) {
  const key = KEYMAP.get(code);
  if (!key || (key.freeOnly && state.scale !== 'chromatic')) return null;
  const notes = key.role === 'chord' ? chordNotes(key.degree, state) : [degreeNote(key.degree, state, state.octave - (key.role === 'bass' ? 2 : 0))];
  return { ...key, notes, label: key.role === 'chord' ? chordName(notes) : noteName(notes[0], true) };
}
export function arpNotes(notes, octaves = 1, pattern = 'up') {
  const result = [...new Set(Array.from({ length: octaves }, (_, octave) => notes.map(n => n + octave * 12)).flat())].filter(n => n >= 12 && n <= 119).sort((a, b) => a - b);
  if (pattern === 'down') result.reverse();
  if (pattern === 'bounce' && result.length > 2) result.push(...result.slice(1, -1).reverse());
  return result;
}
export const loopLength = beats => Math.max(4, Math.ceil(Math.max(0, beats - 0.08) / 4) * 4);
