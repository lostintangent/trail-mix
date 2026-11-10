import { expect, test } from 'bun:test';
import { label, matches, worksWhileTyping, type KeyPress } from './keys.ts';

const press = (key: string, held: Partial<Omit<KeyPress, 'key'>> = {}): KeyPress => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...held,
});

test('a letter matches in either case only with the Shift it asks for', () => {
  expect(matches('E', press('e'), true)).toBe(true);
  expect(matches('E', press('E', { shiftKey: true }), true)).toBe(false);
  expect(matches('Shift+U', press('U', { shiftKey: true }), true)).toBe(true);
  expect(matches('Shift+U', press('u'), true)).toBe(false);
});

test('a symbol matches whatever Shift made it, but no other modifier', () => {
  expect(matches('#', press('#', { shiftKey: true }), true)).toBe(true);
  expect(matches('?', press('?', { shiftKey: true }), false)).toBe(true);
  expect(matches('#', press('#', { metaKey: true }), true)).toBe(false);
});

test('Mod is ⌘ on Apple platforms and Ctrl elsewhere, and the other one spoils it', () => {
  expect(matches('Mod+K', press('k', { metaKey: true }), true)).toBe(true);
  expect(matches('Mod+K', press('k', { ctrlKey: true }), true)).toBe(false);
  expect(matches('Mod+K', press('k', { ctrlKey: true }), false)).toBe(true);
  expect(matches('E', press('e', { ctrlKey: true }), true)).toBe(false);
  expect(matches('Mod+K', press('k'), true)).toBe(false);
});

test('a shortcut reads as its platform writes it', () => {
  expect(label('Mod+K', true)).toBe('⌘K');
  expect(label('Mod+K', false)).toBe('Ctrl+K');
  expect(label('Shift+U', true)).toBe('⇧U');
  expect(label('e', false)).toBe('E');
  expect(label('#', true)).toBe('#');
});

test('only a shortcut with a modifier, or Escape, works while typing', () => {
  expect(worksWhileTyping('Mod+K')).toBe(true);
  expect(worksWhileTyping('Escape')).toBe(true);
  expect(worksWhileTyping('E')).toBe(false);
  expect(worksWhileTyping('Shift+U')).toBe(false);
});
