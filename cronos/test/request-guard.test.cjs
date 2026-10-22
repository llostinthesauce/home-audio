'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { refusal, hostName } = require('../lib/helpers/request-guard');

const req = headers => ({ headers });

test('hostName drops the port and IPv6 brackets', () => {
  assert.equal(hostName('192.0.2.10:5005'), '192.0.2.10');
  assert.equal(hostName('[::1]:5005'), '::1');
  assert.equal(hostName('Sonos-Box.local:5005'), 'sonos-box.local');
});

test('requests addressed to this box pass', () => {
  assert.equal(refusal(req({ host: '127.0.0.1:5005' })), null);
  assert.equal(refusal(req({ host: 'localhost:5005' })), null);
  assert.equal(refusal(req({ host: `${os.hostname()}:5005` })), null);
  // HTTP/1.0 clients send no Host; browsers always do.
  assert.equal(refusal(req({})), null);
});

test('a rebound hostname is refused unless listed in allowedHosts', () => {
  assert.equal(refusal(req({ host: 'attacker.example:5005' })), 'unexpected Host header');
  assert.equal(refusal(req({ host: 'sonos.home.arpa:5005' }), ['sonos.home.arpa']), null);
});

test('cross-site browser requests are refused; the UI, typed URLs and native clients pass', () => {
  const host = '127.0.0.1:5005';
  assert.equal(refusal(req({ host, 'sec-fetch-site': 'cross-site' })), 'cross-site request refused');
  assert.equal(refusal(req({ host, 'sec-fetch-site': 'same-site' })), 'cross-site request refused');
  assert.equal(refusal(req({ host, 'sec-fetch-site': 'same-origin' })), null);
  assert.equal(refusal(req({ host, 'sec-fetch-site': 'none' })), null);
});
