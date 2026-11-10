import { describe, expect, test } from 'bun:test';
import {
  EXPIRED,
  codeFrom,
  codeRequest,
  isFresh,
  pollRequest,
  polled,
  refreshRequest,
  refreshed,
  type DeviceSignIn,
} from './device-sign-in.ts';
import { PRESETS } from './presets.ts';

const microsoft: DeviceSignIn = PRESETS.outlook.device;
const app = { id: 'client' };
const NOW = Date.parse('2026-11-10T20:00:00Z');

/** How Microsoft words a refusal: a first line, then IDs only its support reads. */
const withTrace = (first: string) =>
  `${first}\r\nTrace ID: 2c1e7a4b-0000\r\nCorrelation ID: 9f00-1111\r\nTimestamp: 2026-11-10 20:00:00Z`;

describe('the requests', () => {
  test('a code is asked for with the preset’s scopes, at its authority', () => {
    const request = codeRequest(microsoft, app);
    expect(request.url).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode');
    expect(Object.fromEntries(request.form)).toEqual({
      client_id: 'client',
      scope:
        'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access',
    });
  });

  test('a poll redeems the device code, and a refresh the refresh token, at the token path', () => {
    const poll = pollRequest(microsoft, app, 'device');
    expect(poll.url).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    expect(Object.fromEntries(poll.form)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: 'client',
      device_code: 'device',
    });
    const refresh = refreshRequest(microsoft, app, 'kept');
    expect(refresh.url).toBe(poll.url);
    expect(Object.fromEntries(refresh.form)).toMatchObject({
      grant_type: 'refresh_token',
      client_id: 'client',
      refresh_token: 'kept',
    });
  });
});

describe('a code', () => {
  test('comes with the page to enter it at, and when it expires', () => {
    const answer = {
      status: 200,
      body: {
        device_code: 'device',
        user_code: 'F7KQ2M9XR',
        verification_uri: 'https://www.microsoft.com/link',
        expires_in: 900,
        interval: 5,
        message: 'To sign in, use a web browser…',
      },
    };
    expect(codeFrom(microsoft, answer, NOW)).toEqual({
      deviceCode: 'device',
      code: 'F7KQ2M9XR',
      link: 'https://www.microsoft.com/link',
      expiresAt: NOW + 900_000,
      interval: 5000,
    });
  });

  test('reads a time sent as text, and waits five seconds when no interval is given', () => {
    const answer = {
      status: 200,
      body: {
        device_code: 'device',
        user_code: 'ABCD',
        verification_uri: 'https://accounts.example/device',
        expires_in: '600',
      },
    };
    expect(codeFrom(microsoft, answer, NOW)).toMatchObject({
      link: 'https://accounts.example/device',
      expiresAt: NOW + 600_000,
      interval: 5000,
    });
  });

  test('refused is said in the vendor’s words, without its trace', () => {
    const answer = {
      status: 400,
      body: {
        error: 'unauthorized_client',
        error_description: withTrace(
          "AADSTS70002: The client application must be marked as 'mobile.'",
        ),
      },
    };
    expect(() => codeFrom(microsoft, answer, NOW)).toThrow(
      "Microsoft refused to start signing in: AADSTS70002: The client application must be marked as 'mobile.'",
    );
  });

  test('is refused when its page isn’t one a browser should open', () => {
    for (const link of ['javascript:alert(1)', 'http://login.example/link', 'not a url']) {
      const answer = {
        status: 200,
        body: { device_code: 'd', user_code: 'u', verification_uri: link },
      };
      expect(() => codeFrom(microsoft, answer, NOW)).toThrow('a sign-in page Trail Mix won’t open');
    }
    const standIn = {
      status: 200,
      body: {
        device_code: 'd',
        user_code: 'u',
        verification_uri: 'http://127.0.0.1:4080/devicelogin',
      },
    };
    expect(codeFrom(microsoft, standIn, NOW).link).toBe('http://127.0.0.1:4080/devicelogin');
  });
});

describe('a poll', () => {
  const refusal = (error: string, description?: string) => ({
    status: 400,
    body: { error, ...(description ? { error_description: description } : {}) },
  });

  test('waiting on the member asks again after the same interval', () => {
    expect(polled(microsoft, refusal('authorization_pending'), 5000, NOW)).toEqual({
      pending: 5000,
    });
  });

  test('told to slow down waits five seconds longer each time', () => {
    expect(polled(microsoft, refusal('slow_down'), 5000, NOW)).toEqual({ pending: 10_000 });
    expect(polled(microsoft, refusal('slow_down'), 10_000, NOW)).toEqual({ pending: 15_000 });
  });

  test('approved carries both tokens and when the access token runs out', () => {
    const answer = {
      status: 200,
      body: {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3599,
        token_type: 'Bearer',
      },
    };
    expect(polled(microsoft, answer, 5000, NOW)).toEqual({
      granted: { access: 'access', refresh: 'refresh', expiresAt: NOW + 3_599_000 },
    });
  });

  test('approved without a refresh token stops, since the member couldn’t stay signed in', () => {
    const answer = { status: 200, body: { access_token: 'access', expires_in: 3600 } };
    expect(polled(microsoft, answer, 5000, NOW)).toEqual({
      refused: 'Microsoft signed you in, but gave Trail Mix no way to stay signed in.',
    });
  });

  test('declined, expired or refused stops, with why', () => {
    expect(polled(microsoft, refusal('authorization_declined'), 5000, NOW)).toEqual({
      refused: 'You declined the sign-in at Microsoft.',
    });
    expect(polled(microsoft, refusal('access_denied'), 5000, NOW)).toEqual({
      refused: 'You declined the sign-in at Microsoft.',
    });
    expect(polled(microsoft, refusal('expired_token'), 5000, NOW)).toEqual({ refused: EXPIRED });
    expect(
      polled(
        microsoft,
        refusal(
          'bad_verification_code',
          withTrace("AADSTS70000: The provided value for the 'device_code' is not valid."),
        ),
        5000,
        NOW,
      ),
    ).toEqual({
      refused:
        "Microsoft refused the sign-in: AADSTS70000: The provided value for the 'device_code' is not valid.",
    });
    expect(polled(microsoft, { status: 502, body: null }, 5000, NOW)).toEqual({
      refused: 'Microsoft refused the sign-in: it gave no reason.',
    });
    // An error is an error, even when a vendor sends it with a 200.
    expect(
      polled(microsoft, { status: 200, body: { error: 'authorization_pending' } }, 5000, NOW),
    ).toEqual({ pending: 5000 });
  });
});

describe('a refresh', () => {
  test('rotates the refresh token when the vendor sends a new one, and keeps the old one if not', () => {
    const rotated = {
      status: 200,
      body: { access_token: 'access2', refresh_token: 'refresh2', expires_in: 3600 },
    };
    expect(refreshed(microsoft, rotated, 'refresh1', NOW)).toEqual({
      granted: { access: 'access2', refresh: 'refresh2', expiresAt: NOW + 3_600_000 },
    });
    const kept = { status: 200, body: { access_token: 'access2' } };
    expect(refreshed(microsoft, kept, 'refresh1', NOW)).toEqual({
      granted: { access: 'access2', refresh: 'refresh1', expiresAt: NOW + 3_600_000 },
    });
  });

  test('refused for good lapses, so the member signs in again', () => {
    const answer = {
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description: withTrace(
          'AADSTS700082: The refresh token has expired due to inactivity.',
        ),
      },
    };
    expect(refreshed(microsoft, answer, 'refresh1', NOW)).toEqual({
      lapsed:
        'Microsoft refused to keep you signed in: AADSTS700082: The refresh token has expired due to inactivity.',
    });
    expect(
      refreshed(microsoft, { status: 400, body: { error: 'interaction_required' } }, 'r', NOW),
    ).toHaveProperty('lapsed');
  });

  test('failing any other way may pass, and lapses nothing', () => {
    expect(refreshed(microsoft, { status: 503, body: null }, 'r', NOW)).toEqual({
      failed: 'Microsoft refused to keep you signed in: it gave no reason.',
    });
    // The operator's app, not the member's sign-in: signing in again wouldn't help.
    expect(
      refreshed(microsoft, { status: 401, body: { error: 'invalid_client' } }, 'r', NOW),
    ).toEqual({ failed: 'Microsoft refused to keep you signed in: invalid_client' });
    expect(refreshed(microsoft, { status: 200, body: {} }, 'r', NOW)).toEqual({
      failed: 'Microsoft sent no access token.',
    });
  });
});

test('an access token is used until five minutes before it runs out', () => {
  const tokens = { expiresAt: NOW + 10 * 60_000 };
  expect(isFresh(tokens, NOW)).toBe(true);
  expect(isFresh(tokens, NOW + 5 * 60_000 - 1)).toBe(true);
  expect(isFresh(tokens, NOW + 5 * 60_000)).toBe(false);
});
