// Pure contract for the large-paste artifact module (issues #94:
// oversized paste silently truncated at the 6,000-char human-input budget).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PASTE_ARTIFACT_EXCERPT_HEAD_CHARS,
  PASTE_ARTIFACT_EXCERPT_TAIL_CHARS,
  PASTE_ARTIFACT_MAX_CHARS,
  PASTE_ARTIFACT_MIN_CHARS,
  PASTE_ARTIFACT_MIN_LINES,
  buildPasteArtifact,
  classifyPastedText,
  isPasteArtifact,
  pasteArtifactBaseName,
  pasteArtifactExceedsLocalLimit,
  pasteArtifactExcerpt,
  pasteArtifactShortening,
} from '../extension/lib/paste-artifact.mjs';

test('classifyPastedText flags pastes over the character threshold', () => {
  assert.equal(classifyPastedText('a'.repeat(PASTE_ARTIFACT_MIN_CHARS)).large, false);
  const over = classifyPastedText('a'.repeat(PASTE_ARTIFACT_MIN_CHARS + 1));
  assert.equal(over.large, true);
  assert.equal(over.reason, 'chars');
});

test('classifyPastedText flags pastes over the line threshold', () => {
  const lines = Array.from({ length: PASTE_ARTIFACT_MIN_LINES }, () => 'x').join('\n');
  assert.equal(classifyPastedText(lines).large, false);
  const over = classifyPastedText(Array.from({ length: PASTE_ARTIFACT_MIN_LINES + 1 }, () => 'x').join('\n'));
  assert.equal(over.large, true);
  assert.equal(over.reason, 'lines');
  assert.equal(over.lines, PASTE_ARTIFACT_MIN_LINES + 1);
});

test('classifyPastedText prefers the character reason when both thresholds trip', () => {
  const text = Array.from({ length: 40 }, () => 'y'.repeat(120)).join('\n');
  const result = classifyPastedText(text);
  assert.equal(result.large, true);
  assert.equal(result.reason, 'chars');
});

test('pasteArtifactBaseName builds a timestamped .txt name', () => {
  const name = pasteArtifactBaseName(new Date(2026, 8, 24, 17, 32, 5));
  assert.equal(name, 'pasted-text-20260924-173205.txt');
});

test('buildPasteArtifact reports raw stats and keeps the full text', () => {
  const text = `${'line\n'.repeat(100)}end`;
  const artifact = buildPasteArtifact(text, { now: new Date(2026, 8, 24, 17, 32, 5) });
  assert.equal(artifact.kind, 'text');
  assert.equal(artifact.source, 'paste');
  assert.equal(artifact.label, 'pasted-text-20260924-173205.txt');
  assert.equal(artifact.charCount, text.length);
  assert.equal(artifact.lineCount, 101);
  assert.equal(artifact.truncated, false);
  assert.equal(artifact.text, text);
  assert.ok(artifact.sizeBytes >= text.length);
});

test('buildPasteArtifact clamps beyond the keep-full ceiling', () => {
  const text = 'z'.repeat(PASTE_ARTIFACT_MAX_CHARS + 500);
  const artifact = buildPasteArtifact(text);
  assert.equal(artifact.truncated, true);
  assert.equal(artifact.text.length, PASTE_ARTIFACT_MAX_CHARS);
  assert.equal(artifact.charCount, text.length);
});

test('pasteArtifactExcerpt passes short text through untouched', () => {
  const text = 'short paste';
  assert.equal(pasteArtifactExcerpt(text), text);
});

test('pasteArtifactExcerpt keeps head, marker, and tail within budget', () => {
  const text = 'H'.repeat(2_500) + 'M'.repeat(50_000) + 'T'.repeat(2_000);
  const excerpt = pasteArtifactExcerpt(text);
  assert.ok(excerpt.startsWith('H'.repeat(PASTE_ARTIFACT_EXCERPT_HEAD_CHARS)));
  assert.ok(excerpt.endsWith('T'.repeat(PASTE_ARTIFACT_EXCERPT_TAIL_CHARS)));
  assert.match(excerpt, /pasted characters omitted from this excerpt/);
  assert.ok(excerpt.length <= PASTE_ARTIFACT_EXCERPT_HEAD_CHARS + PASTE_ARTIFACT_EXCERPT_TAIL_CHARS + 120);
});

test('isPasteArtifact only accepts pasted text attachments', () => {
  assert.equal(isPasteArtifact({ kind: 'text', source: 'paste' }), true);
  assert.equal(isPasteArtifact({ kind: 'text' }), false);
  assert.equal(isPasteArtifact({ kind: 'file', source: 'paste' }), false);
  assert.equal(isPasteArtifact(null), false);
});

test('pasteArtifactExceedsLocalLimit bounds local preservation at the ceiling', () => {
  assert.equal(pasteArtifactExceedsLocalLimit('a'.repeat(PASTE_ARTIFACT_MAX_CHARS)), false);
  assert.equal(pasteArtifactExceedsLocalLimit('a'.repeat(PASTE_ARTIFACT_MAX_CHARS + 1)), true);
  assert.equal(pasteArtifactExceedsLocalLimit('a'.repeat(PASTE_ARTIFACT_MAX_CHARS + 1), { maxChars: PASTE_ARTIFACT_MAX_CHARS + 10 }), false);
  assert.equal(pasteArtifactExceedsLocalLimit(''), false);
  assert.equal(pasteArtifactExceedsLocalLimit(null), false);
});

test('pasteArtifactShortening names the omitted middle only when the excerpt really shortens the paste', () => {
  const longText = 'H'.repeat(2_500) + 'M'.repeat(50_000) + 'T'.repeat(2_000);
  const artifact = { ...buildPasteArtifact(longText), id: 'a1' };
  const shortening = pasteArtifactShortening(artifact);
  assert.equal(shortening.head, PASTE_ARTIFACT_EXCERPT_HEAD_CHARS);
  assert.equal(shortening.tail, PASTE_ARTIFACT_EXCERPT_TAIL_CHARS);
  assert.equal(shortening.total, longText.length);
  assert.equal(shortening.omitted, longText.length - PASTE_ARTIFACT_EXCERPT_HEAD_CHARS - PASTE_ARTIFACT_EXCERPT_TAIL_CHARS);
});

test('pasteArtifactShortening stays silent for pastes the excerpt sends whole', () => {
  const fits = buildPasteArtifact('x'.repeat(PASTE_ARTIFACT_EXCERPT_HEAD_CHARS + PASTE_ARTIFACT_EXCERPT_TAIL_CHARS));
  assert.equal(pasteArtifactShortening(fits), null);
  const mediumPaste = buildPasteArtifact('y'.repeat(3_000));
  assert.equal(pasteArtifactShortening(mediumPaste), null, 'a paste under the excerpt budget is sent in full');
});

test('pasteArtifactShortening ignores attachments that are not paste artifacts', () => {
  assert.equal(pasteArtifactShortening({ kind: 'file', source: 'picker', text: 'z'.repeat(50_000) }), null);
  assert.equal(pasteArtifactShortening(null), null);
});
