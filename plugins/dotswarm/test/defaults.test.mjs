import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Set before the first import: the defaults are read once, when config.mjs loads.
const env = { DOTSWARM_DEFAULT_PROVIDER: 'hosted-provider', DOTSWARM_DEFAULT_MODEL: 'vendor/model-1', DOTSWARM_VISION_MODEL: 'vendor/vision-1' };
Object.assign(process.env, env, { DOTSWARM_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-defaults-')) });
const { DEFAULTS, ROOT } = await import('../src/config.mjs');
const { SwarmManager } = await import('../src/swarm.mjs');

test('the default provider and model come from the environment when set', () => {
  assert.equal(DEFAULTS.provider, 'hosted-provider');
  assert.equal(DEFAULTS.model, 'vendor/model-1');
  const manager = new SwarmManager();
  const spec = manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir() });
  assert.equal(spec.provider, 'hosted-provider');
  assert.equal(spec.model, 'vendor/model-1');
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), model: 'other' }).model, 'other', 'an explicit model still wins');
  assert.equal(DEFAULTS.visionModel, 'vendor/vision-1');
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), design: true }).model, 'vendor/vision-1', 'design swarms use the vision default');
});

test('swarm_start and swarm_doctor report the effective defaults', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'server.mjs')],
    env: {
      ...process.env,
      ...env,
      CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-defaults-home-')),
      DOTSWARM_DOTBOT_CLIENT: '',
      DOTBOT_API_KEY: '',
    },
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  try {
    const start = (await client.listTools()).tools.find((t) => t.name === 'swarm_start');
    assert.match(start.inputSchema.properties.model.description, /default vendor\/model-1; design swarms default to vendor\/vision-1/);
    const status = (await client.listTools()).tools.find((t) => t.name === 'swarm_status');
    assert.match(status.description, /Read failure\.providerError first/, 'a 400 is not always the model');
    const doctor = JSON.parse((await client.callTool({ name: 'swarm_doctor', arguments: {} })).content[0].text);
    assert.equal(doctor.defaults.model, 'vendor/model-1');
    assert.equal(doctor.defaults.provider, 'hosted-provider');
    assert.equal(doctor.defaults.visionModel, 'vendor/vision-1');
  } finally {
    await client.close();
  }
});
