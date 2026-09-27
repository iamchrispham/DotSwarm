import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../src/config.mjs';

test('the Codex plugin launcher starts the MCP server, installs the subagents, and exposes the swarm tools', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-server-home-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'server.mjs')],
    env: {
      ...process.env,
      DOTSWARM_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-server-test-')),
      CODEX_HOME: codexHome,
      DOTSWARM_DOTBOT_CLIENT: '',
      DOTBOT_API_KEY: '',
    },
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'dotswarm');
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['swarm_doctor', 'swarm_inspect', 'swarm_list', 'swarm_result', 'swarm_resume', 'swarm_setup', 'swarm_start', 'swarm_status', 'swarm_steer', 'swarm_stop', 'swarm_task_add']);
  const doctor = await client.callTool({ name: 'swarm_doctor', arguments: {} });
  const report = JSON.parse(doctor.content[0].text);
  assert.ok(Array.isArray(report.checks) && report.checks.length >= 4);
  assert.match(report.keyFile, /dsh-home[\\/]\.env$/);
  assert.equal(report.dotbot.connected, false);
  assert.deepEqual(await client.ping(), {});
  const list = await client.callTool({ name: 'swarm_list', arguments: {} });
  assert.equal(list.content[0].text, '[]');
  const missing = await client.callTool({ name: 'swarm_status', arguments: { swarm_id: 'nope' } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /unknown swarm nope/);
  // Starting the server is enough to get the subagents; swarm_setup is only for the DeepSeek side.
  assert.deepEqual(fs.readdirSync(path.join(codexHome, 'agents')).sort(),
    ['dotswarm-designer.toml', 'dotswarm-imager.toml', 'dotswarm-writer.toml']);
  await client.close();
});

test('with a DotBot client and key the coordinator gets skill search and a skills argument', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'server.mjs')],
    env: {
      ...process.env,
      DOTSWARM_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-server-dotbot-')),
      CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-server-dotbot-home-')),
      DOTSWARM_DOTBOT_CLIENT: fileURLToPath(new URL('./fixtures/fake-dotbot-client.mjs', import.meta.url)),
      DOTBOT_API_KEY: 'dot_test',
    },
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  try {
    assert.match(client.getInstructions(), /swarm_find_skills/);
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some((t) => t.name === 'swarm_find_skills'));
    assert.ok(tools.find((t) => t.name === 'swarm_start').inputSchema.properties.skills);
    for (const tool of tools) assert.doesNotMatch(tool.description, /Claude|Codex|GPT/);
    const found = await client.callTool({ name: 'swarm_find_skills', arguments: { work_units: ['print a greeting', 'this will fail'] } });
    const body = JSON.parse(found.content[0].text);
    assert.equal(body.units[0].results[0].id, 'fixture-alpha');
    assert.match(body.units[1].error, /network down/);
    const doctor = JSON.parse((await client.callTool({ name: 'swarm_doctor', arguments: {} })).content[0].text);
    assert.deepEqual(doctor.dotbot, { connected: true, baseUrl: 'https://dotbot.test' });
  } finally {
    await client.close();
  }
});

test('swarm_start over MCP takes the objective from a file, backslashes and all', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-server-file-'));
  const briefFile = path.join(home, 'brief.md');
  const brief = 'Match `\\(` and `\\*` literally; keep "quotes".';
  fs.writeFileSync(briefFile, brief);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'server.mjs')],
    env: {
      ...process.env,
      DOTSWARM_HOME: home,
      CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-server-file-home-')),
      DOTSWARM_DSH_BIN: fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url)),
      DEEPSEEK_API_KEY: 'test-key',
      DOTSWARM_DOTBOT_CLIENT: '',
      DOTBOT_API_KEY: '',
    },
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  try {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-server-file-ws-'));
    const started = await client.callTool({ name: 'swarm_start', arguments: { objective_file: briefFile, workspace, max_agents: 1 } });
    assert.notEqual(started.isError, true, started.content[0].text);
    const { swarmId } = JSON.parse(started.content[0].text);
    assert.ok(fs.readFileSync(path.join(home, 'swarms', swarmId, 'lead-prompt.md'), 'utf8').includes(brief));
    await client.callTool({ name: 'swarm_stop', arguments: { swarm_id: swarmId } });
  } finally {
    await client.close();
  }
});
