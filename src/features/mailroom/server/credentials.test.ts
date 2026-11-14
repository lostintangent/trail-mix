import { describe, expect, test } from 'bun:test';
import { credentialsOf } from './credentials.ts';

const SECRET = 'a worker secret that is long enough to use';

describe('sealed credentials', () => {
  test('open with the same member’s key, for the same account', async () => {
    const credentials = credentialsOf(SECRET, 'member-a');
    const sealed = await credentials.seal('app-password', 'zoho');
    expect(await credentials.open(sealed, 'zoho')).toBe('app-password');
  });

  test('never hold the secret in the clear, and differ every time', async () => {
    const credentials = credentialsOf(SECRET, 'member-a');
    const [one, two] = [
      await credentials.seal('app-password', 'zoho'),
      await credentials.seal('app-password', 'zoho'),
    ];
    expect(new TextDecoder('latin1').decode(one)).not.toContain('app-password');
    expect(one).not.toEqual(two);
  });

  test('do not open under another member’s key, or for another account', async () => {
    const sealed = await credentialsOf(SECRET, 'member-a').seal('app-password', 'zoho');
    await expect(credentialsOf(SECRET, 'member-b').open(sealed, 'zoho')).rejects.toThrow();
    await expect(credentialsOf(SECRET, 'member-a').open(sealed, 'outlook')).rejects.toThrow();
  });

  test('refuse a Worker secret too short to be one', async () => {
    await expect(credentialsOf('short', 'member-a').seal('app-password', 'zoho')).rejects.toThrow(
      'at least 32 characters',
    );
  });
});
