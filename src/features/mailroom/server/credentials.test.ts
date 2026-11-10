import { describe, expect, test } from 'bun:test';
import { memberKey, open, seal } from './credentials.ts';

const SECRET = 'a worker secret that is long enough to use';

describe('sealed credentials', () => {
  test('open with the same member’s key, for the same account', async () => {
    const key = await memberKey(SECRET, 'member-a');
    expect(await open(key, await seal(key, 'app-password', 'zoho'), 'zoho')).toBe('app-password');
  });

  test('never hold the secret in the clear, and differ every time', async () => {
    const key = await memberKey(SECRET, 'member-a');
    const [one, two] = [
      await seal(key, 'app-password', 'zoho'),
      await seal(key, 'app-password', 'zoho'),
    ];
    expect(new TextDecoder('latin1').decode(one)).not.toContain('app-password');
    expect(one).not.toEqual(two);
  });

  test('do not open under another member’s key, or for another account', async () => {
    const sealed = await seal(await memberKey(SECRET, 'member-a'), 'app-password', 'zoho');
    await expect(open(await memberKey(SECRET, 'member-b'), sealed, 'zoho')).rejects.toThrow();
    await expect(open(await memberKey(SECRET, 'member-a'), sealed, 'outlook')).rejects.toThrow();
  });

  test('refuse a Worker secret too short to be one', async () => {
    await expect(memberKey('short', 'member-a')).rejects.toThrow('at least 32 characters');
  });
});
