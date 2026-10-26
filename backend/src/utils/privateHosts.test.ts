/**
 * The portal runs on EC2. A scrape of http://169.254.169.254/latest/meta-data/iam/ returns the
 * instance role's credentials, and the scraper fetches URLs supplied by signup forms, prospecting
 * shortlists and Google listings — none of which we control.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isBlockedHostname, isBlockedIp } from './privateHosts.js';

test('blocks the addresses that matter on a cloud host', () => {
  assert.ok(isBlockedIp('169.254.169.254'));  // EC2 instance metadata
  assert.ok(isBlockedIp('127.0.0.1'));
  assert.ok(isBlockedIp('0.0.0.0'));
  assert.ok(isBlockedIp('10.0.1.5'));
  assert.ok(isBlockedIp('172.16.0.9'));
  assert.ok(isBlockedIp('172.31.255.254'));
  assert.ok(isBlockedIp('192.168.1.1'));
  assert.ok(isBlockedIp('100.64.0.1'));
  assert.ok(isBlockedIp('::1'));
  assert.ok(isBlockedIp('fe80::1'));
  assert.ok(isBlockedIp('fd00::1'));
  assert.ok(isBlockedIp('::ffff:169.254.169.254'));
});

test('allows ordinary public addresses', () => {
  assert.ok(!isBlockedIp('8.8.8.8'));
  assert.ok(!isBlockedIp('93.184.216.34'));
  assert.ok(!isBlockedIp('172.32.0.1'));   // just outside the private range
  assert.ok(!isBlockedIp('172.15.255.255'));
});

test('refuses anything that is not an address at all', () => {
  assert.ok(isBlockedIp('not-an-ip'));
  assert.ok(isBlockedIp(''));
});

test('blocks hostnames that cannot be a customer website', () => {
  assert.ok(isBlockedHostname('localhost'));
  assert.ok(isBlockedHostname('db.internal'));
  assert.ok(isBlockedHostname('printer.local'));
  assert.ok(isBlockedHostname('169.254.169.254'));
  assert.ok(isBlockedHostname(''));
});

test('allows a real garage website', () => {
  assert.ok(!isBlockedHostname('cowesharbourgarage.com'));
  assert.ok(!isBlockedHostname('www.roywindebank.co.uk'));
});

test('unwraps the IPv6 forms that hide an IPv4 address', () => {
  // Every one of these is 169.254.169.254 wearing a different coat.
  assert.ok(isBlockedIp('::ffff:a9fe:a9fe'));
  assert.ok(isBlockedIp('::ffff:169.254.169.254'));
  assert.ok(isBlockedIp('64:ff9b::a9fe:a9fe'));
  assert.ok(isBlockedIp('2002:a9fe:a9fe::'));
  assert.ok(isBlockedIp('::7f00:1'));            // 127.0.0.1
  assert.ok(isBlockedIp('::ffff:7f00:1'));
});

test('does not block a public address wrapped in an IPv6 form', () => {
  assert.ok(!isBlockedIp('::ffff:8.8.8.8'));
  assert.ok(!isBlockedIp('2001:4860:4860::8888'));
});

test('blocks the ranges the first version missed', () => {
  assert.ok(isBlockedIp('198.18.0.1'));      // benchmarking
  assert.ok(isBlockedIp('198.19.255.254'));
  assert.ok(isBlockedIp('192.0.2.1'));       // documentation
  assert.ok(isBlockedIp('203.0.113.9'));
  assert.ok(isBlockedIp('240.0.0.1'));       // reserved
  assert.ok(isBlockedIp('255.255.255.255'));
});

test('judges a bracketed IPv6 literal as an address, not a hostname', () => {
  assert.ok(isBlockedHostname('[::1]'));
  assert.ok(isBlockedHostname('[::ffff:a9fe:a9fe]'));
  assert.ok(!isBlockedHostname('[2001:4860:4860::8888]'));
});
