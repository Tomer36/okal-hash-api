import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import express from 'express';
import { listenLocal } from '../services/listenLocal.mjs';

test('the service listens on the loopback addresses only, so the network cannot reach it', async (t) => {
  const app = express();
  app.get('/ping', (req, res) => res.send('pong'));
  const warnings = [];
  const servers = await listenLocal(app, 0, { hosts: ['127.0.0.1'], warn: message => warnings.push(message) });
  t.after(() => Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))));
  const { address, port } = servers[0].address();
  assert.equal(address, '127.0.0.1');
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/ping`)).text(), 'pong');

  const lanAddress = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal)?.address;
  if (lanAddress) {
    await assert.rejects(fetch(`http://${lanAddress}:${port}/ping`), 'not reachable from the network address');
  }
});

test('an address the machine does not have is skipped with a warning; none at all is an error', async () => {
  const warnings = [];
  const app = express();
  const servers = await listenLocal(app, 0, { hosts: ['203.0.113.7', '127.0.0.1'], warn: message => warnings.push(message) });
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  assert.equal(servers.length, 1);
  assert.match(warnings[0], /203\.0\.113\.7/);
  await assert.rejects(listenLocal(app, 0, { hosts: ['203.0.113.7'], warn: () => {} }), /could not listen/);
});
