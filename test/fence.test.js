/**
 * The Host/Origin fence.
 *
 * Every case here is one the plugin previously had to be trusted about: the
 * fence is the only admission control on routes registered with
 * `webServer.register`, so a regression in it turns the plugin's HTTP surface
 * into a cross-origin reachable endpoint. `Host` cases are the DNS-rebinding
 * defence; `Origin` cases are the browser cross-site defence.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultPortFor, isLoopbackHostname, parseAuthority, requestAuthorized } from '../lib/fence.js';

/** The listener facts a normal desktop host reports. */
const policy = { bindHost: '127.0.0.1', port: 39259, protocol: 'http:' };

/** Build a request shaped like Node's `IncomingMessage` for the fence. */
const req = (headers) => ({ headers });

test('parseAuthority reads the shapes a Host header can take', () => {
  assert.deepEqual(parseAuthority('127.0.0.1:3080'), { hostname: '127.0.0.1', port: 3080 });
  assert.deepEqual(parseAuthority('localhost'), { hostname: 'localhost', port: undefined });
  assert.deepEqual(parseAuthority('[::1]:3080'), { hostname: '::1', port: 3080 });
  assert.deepEqual(parseAuthority('EXAMPLE.com:80'), { hostname: 'example.com', port: 80 });
});

test('parseAuthority rejects what is not an authority', () => {
  assert.equal(parseAuthority(''), undefined);
  assert.equal(parseAuthority('   '), undefined);
  assert.equal(parseAuthority('a:b:c'), undefined);
  assert.equal(parseAuthority('[::1'), undefined);
  assert.equal(parseAuthority('host:port'), undefined);
});

test('loopback detection covers localhost, 127/8, and ::1', () => {
  assert.equal(isLoopbackHostname('localhost'), true);
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  assert.equal(isLoopbackHostname('127.99.1.2'), true);
  assert.equal(isLoopbackHostname('::1'), true);
  assert.equal(isLoopbackHostname('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackHostname('192.168.124.30'), false);
  assert.equal(isLoopbackHostname('evil.example'), false);
});

test('defaultPortFor knows both schemes', () => {
  assert.equal(defaultPortFor('https:'), 443);
  assert.equal(defaultPortFor('http:'), 80);
});

test('a plain same-origin browser request passes', () => {
  assert.equal(
    requestAuthorized(
      req({ host: '127.0.0.1:39259', origin: 'http://127.0.0.1:39259' }),
      policy,
    ),
    true,
  );
});

test('a non-browser client with no Origin passes', () => {
  // curl and the host itself send no Origin; refusing them would break the
  // documented API surface.
  assert.equal(requestAuthorized(req({ host: '127.0.0.1:39259' }), policy), true);
});

test('DNS rebinding is refused: an attacker Host is never loopback', () => {
  assert.equal(requestAuthorized(req({ host: 'attacker.example:39259' }), policy), false);
});

test('a foreign Origin is refused even on a loopback Host', () => {
  assert.equal(
    requestAuthorized(
      req({ host: '127.0.0.1:39259', origin: 'http://attacker.example' }),
      policy,
    ),
    false,
  );
});

test('a mismatched Origin port is refused', () => {
  assert.equal(
    requestAuthorized(req({ host: '127.0.0.1:39259', origin: 'http://127.0.0.1:1' }), policy),
    false,
  );
});

test('a stale port on an otherwise-correct host is refused', () => {
  assert.equal(requestAuthorized(req({ host: '127.0.0.1:3080' }), policy), false);
});

test('Sec-Fetch-Site: cross-site is refused outright', () => {
  assert.equal(
    requestAuthorized(
      req({ host: '127.0.0.1:39259', 'sec-fetch-site': 'cross-site' }),
      policy,
    ),
    false,
  );
});

test('a non-http Origin scheme is refused', () => {
  assert.equal(
    requestAuthorized(req({ host: '127.0.0.1:39259', origin: 'file:///tmp/x' }), policy),
    false,
  );
});

test('an unparsable Origin is refused', () => {
  assert.equal(
    requestAuthorized(req({ host: '127.0.0.1:39259', origin: 'not a url' }), policy),
    false,
  );
});

test('the listener bind address is accepted on a non-loopback host', () => {
  // A host bound to a LAN address must still be reachable at that address.
  const lan = { bindHost: '192.168.124.30', port: 3080, protocol: 'http:' };
  assert.equal(requestAuthorized(req({ host: '192.168.124.30:3080' }), lan), true);
  assert.equal(requestAuthorized(req({ host: '192.168.124.31:3080' }), lan), false);
});

test('the same authority under https matches a default port', () => {
  const secure = { bindHost: '127.0.0.1', port: 443, protocol: 'https:' };
  assert.equal(
    requestAuthorized(req({ host: '127.0.0.1', origin: 'https://127.0.0.1' }), secure),
    true,
  );
});

test('an IPv6 loopback Host and Origin match despite brackets', () => {
  const v6 = { bindHost: '::1', port: 39259, protocol: 'http:' };
  assert.equal(
    requestAuthorized(req({ host: '[::1]:39259', origin: 'http://[::1]:39259' }), v6),
    true,
  );
});
