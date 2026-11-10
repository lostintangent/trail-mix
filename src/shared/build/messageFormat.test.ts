import { describe, expect, test } from 'bun:test';
import MessageFormat, { isSimpleMessage } from './messageFormat.ts';

describe('MessageFormat', () => {
  test('fills plain arguments', () => {
    expect(new MessageFormat('Clear {label}', 'en').format({ label: 'Width' })).toBe('Clear Width');
  });

  test('formats number arguments for the locale', () => {
    expect(new MessageFormat('Page {current, number}', 'en').format({ current: 1200 })).toBe(
      'Page 1,200',
    );
    expect(new MessageFormat('Page {current, number}', 'de').format({ current: 1200 })).toBe(
      'Page 1.200',
    );
  });

  test('leaves text without arguments alone', () => {
    expect(new MessageFormat('Close', 'en').format({})).toBe('Close');
  });
});

describe('isSimpleMessage', () => {
  test('accepts plain and number arguments', () => {
    expect(isSimpleMessage('Increment {label}')).toBe(true);
    expect(isSimpleMessage('{from, number} of {total, number}')).toBe(true);
    expect(isSimpleMessage("Isn't it")).toBe(true);
  });

  test('rejects plural, select, other formats, and quoted syntax', () => {
    expect(isSimpleMessage('{count, plural, one {item} other {items}}')).toBe(false);
    expect(isSimpleMessage('{side, select, first {first} other {}}')).toBe(false);
    expect(isSimpleMessage('{when, date}')).toBe(false);
    expect(isSimpleMessage("'{literal}'")).toBe(false);
  });
});
