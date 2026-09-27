import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.DOTSWARM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-swarm-test-'));
// These tests pin the built-in defaults; a machine that exports its own must not change them.
for (const name of ['DOTSWARM_DEFAULT_MODEL', 'DOTSWARM_DEFAULT_PROVIDER', 'DOTSWARM_VISION_MODEL']) delete process.env[name];
const { SwarmManager, attentionReason, providerRejection } = await import('../src/swarm.mjs');
const { DshClient } = await import('../src/dsh-client.mjs');
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-dsh.mjs');

const fakeLaunch = (mode) => ({ swarm, patchFile }) => {
  assert.ok(fs.existsSync(patchFile), 'per-swarm patch written');
  assert.match(fs.readFileSync(patchFile, 'utf8'), /serverName: findings/);
  return new DshClient({
    command: process.execPath, args: [fake, '--profile', 'swarm', '--patch', patchFile], cwd: swarm.workspace,
    env: { ...process.env, FAKE_DSH_MODE: mode }, initializeTimeoutMs: 10_000, requestTimeoutMs: 5000,
  });
};

test('start, observe, steer, result, stop against the fake runtime', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({
    objective: 'Make hello.txt', workspace, max_agents: 2,
    acceptance_criteria: ['hello.txt exists'], plan: '1. create file',
  });
  assert.match(swarm.id, /^sw-/);
  assert.ok(fs.existsSync(path.join(swarm.dir, 'lead-prompt.md')));
  assert.match(fs.readFileSync(path.join(swarm.dir, 'lead-prompt.md'), 'utf8'), /Use Agent Teams/);
  assert.match(fs.readFileSync(path.join(swarm.dir, 'swarm.patch.yml'), 'utf8'), /^- id: agent-team\n {2}config:\n {4}maxMembers: 2$/m, 'the runtime is capped at max_agents teammates');

  const deadline = Date.now() + 5000;
  while (swarm.phase !== 'idle' && Date.now() < deadline) await swarm.waitForChange(500);
  const status = swarm.status();
  assert.equal(status.phase, 'idle');
  assert.equal(status.reportReady, true);
  assert.deepEqual(status.tasks.counts, { pending: 0, in_progress: 0, completed: 1 });
  assert.equal(status.roster.find((r) => r.name === 'worker').phase, 'active');
  assert.equal(status.mail.delivered, 1);
  assert.equal(status.toolErrors[0].code, 'ENOENT');
  assert.equal(status.cost.swarmTokens.input, 600);
  assert.equal(status.cost.byMember.worker.input, 100);
  assert.equal(status.cost.swarmTokens.cacheRead, 300);
  assert.equal(status.cost.byMember.worker.cacheRead, 300);
  assert.equal(status.cost.cacheHitPct, 33.3);
  assert.equal(status.cost.estimatedUsd, undefined);
  process.env.DOTSWARM_PRICE_INPUT_PER_M = '100';
  process.env.DOTSWARM_PRICE_OUTPUT_PER_M = '200';
  assert.equal(swarm.cost().estimatedUsd, 0.08, 'input 600 and output 100; cached reads unpriced');
  assert.match(swarm.cost().note, /DOTSWARM_PRICE_CACHE_READ_PER_M/);
  process.env.DOTSWARM_PRICE_CACHE_READ_PER_M = '10';
  assert.equal(swarm.cost().estimatedUsd, 0.083, 'plus 300 cached reads at 10');
  assert.doesNotMatch(swarm.cost().note, /DOTSWARM_PRICE_CACHE_READ_PER_M/);
  for (const k of ['INPUT', 'OUTPUT', 'CACHE_READ']) delete process.env[`DOTSWARM_PRICE_${k}_PER_M`];
  assert.deepEqual(status.openQuestions, []);
  swarm.findings.append({ author: 'lead', type: 'question', scope: 'coordinator', message: 'may I edit wrangler.jsonc?' });
  assert.equal(swarm.status().openQuestions[0].message, 'may I edit wrangler.jsonc?');
  assert.equal(swarm.status({ sinceFinding: 'F-001' }).findings.new.length, 0);
  assert.equal(swarm.status({ sinceFinding: 'F-000' }).findings.new.length, 1);
  assert.equal(swarm.status().findings.latestId, 'F-001');
  assert.equal(status.teammatesOverBudget, undefined);
  swarm.spec.maxAgents = 0;
  assert.deepEqual(swarm.status().teammatesOverBudget, { budget: 0, spawned: 1 }, 'a Lead past its teammate budget is reported');
  swarm.spec.maxAgents = 2;

  const result = await swarm.result();
  assert.equal(result.complete, true);
  assert.equal(result.report.summary, 'All done.');
  assert.match(result.report.changes, /hello\.txt/);

  const member = swarm.inspect('member:worker');
  assert.equal(member.messages[0].text, 'worker done');
  assert.deepEqual(member.recentTools, ['read']);
  assert.throws(() => swarm.inspect('member:nobody'), /unknown member/);
  assert.equal(swarm.inspect('events', 5).length, 5);

  const steered = await swarm.steer('also add a newline');
  assert.equal(steered.findingId, 'F-002');
  assert.equal(swarm.phase, 'running');
  const steerDeadline = Date.now() + 5000;
  while (swarm.phase !== 'idle' && Date.now() < steerDeadline) await swarm.waitForChange(500);
  assert.match((await swarm.result()).report.summary, /Steered/);
  assert.equal(swarm.inspect('prompts').length, 2);
  assert.deepEqual(swarm.status().steers, { sent: 1, read: 1 });
  assert.equal(swarm.status().permissionMode, 'danger-full-access');
  assert.equal(swarm.inspect('findings')[1].type, 'steer');
  const task = await swarm.addTask({ subject: 'Fix wrangler config', description: 'set the var', writeScopes: ['wrangler.jsonc'] });
  assert.equal(task.findingId, 'F-003');
  assert.match(swarm.inspect('findings')[2].message, /^TASK REQUEST[\s\S]*Subject: Fix wrangler config[\s\S]*Write scopes: wrangler\.jsonc/);
  await assert.rejects(swarm.addTask({ subject: '', description: 'x' }), /required/);
  const benign = swarm.status();
  assert.ok(!benign.toolErrors.some((e) => e.code === 'FS_NOT_OBSERVED'));

  assert.equal(manager.list()[0].swarmId, swarm.id);
  const stopped = await swarm.stop();
  assert.equal(stopped.phase, 'stopped');
  await assert.rejects(swarm.steer('x'), /cannot be steered/);
});

test('a runtime that dies during start reports failed with stderr', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('exit-early') });
  await assert.rejects(manager.start({ objective: 'x', workspace }), /boot failure/);
  assert.equal(manager.list().find((s) => s.workspace === workspace).phase, 'failed');
});

test('a Lead turn that ends in a provider error reports the error and wakes failed, and a steer retries', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('turn-error') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'x', workspace, max_agents: 1 });
  assert.equal(await swarm.waitForAttention(5000), 'failed');
  // The wake comes on turn/end; the session reports idle just after it.
  const idleBy = Date.now() + 5000;
  while (swarm.phase !== 'idle' && Date.now() < idleBy) await swarm.waitForChange(500);
  const status = swarm.status();
  assert.equal(status.phase, 'idle');
  assert.equal(status.error, 'Lead turn 1 ended in an error: DeepSeek API error (HTTP 400) (INVALID_REQUEST, 400, request req-1)');
  assert.deepEqual(status.failure, {
    kind: 'provider_rejected', httpStatus: 400, providerError: 'DeepSeek API error (HTTP 400)', model: 'deepseek-v4-flash', provider: 'deepseek-official',
  }, 'a request the provider refused before any token is named, with the model it was sent');
  const result = await swarm.result();
  assert.equal(result.complete, false);
  assert.match(result.error, /HTTP 400/);

  // The runtime is still up: a steer starts a new Lead turn, which clears the error when it succeeds.
  await swarm.steer('the model is fixed; start again');
  const deadline = Date.now() + 5000;
  while ((swarm.phase !== 'idle' || swarm.problem) && Date.now() < deadline) await swarm.waitForChange(500);
  assert.equal(swarm.status().error, undefined);
  assert.equal(swarm.status().failure, undefined);
  assert.equal((await swarm.result()).complete, true);
});

test('providerRejection names only a refused request that spent no tokens', () => {
  const zero = { input: 0, output: 0, cacheRead: 0 };
  const spec = { model: 'm-1', provider: 'p-1' };
  const quota = { message: 'Insufficient Balance', code: 'QUOTA', status: 402 };
  assert.deepEqual(providerRejection({ failure: quota, tokens: zero, ...spec }), { kind: 'provider_rejected', httpStatus: 402, providerError: 'Insufficient Balance', model: 'm-1', provider: 'p-1' });
  for (const status of [400, 401, 429]) assert.equal(providerRejection({ failure: { ...quota, status }, tokens: zero, ...spec }).httpStatus, status);
  assert.equal(providerRejection({ failure: { ...quota, status: 500 }, tokens: zero, ...spec }), null, 'a server error is not a rejection');
  assert.equal(providerRejection({ failure: quota, tokens: { ...zero, input: 10 }, ...spec }), null, 'a run that already spent tokens was not rejected up front');
  assert.equal(providerRejection({ failure: null, tokens: zero, ...spec }), null);
  const dump = providerRejection({ failure: { ...quota, status: 400, message: 'x'.repeat(5000) }, tokens: zero, ...spec });
  assert.equal(dump.providerError.length, 500, 'a long provider dump does not flood the compressed status');
});

function tempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-repo-'));
  const run = (args) => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'pipe' });
  run(['init', '-q']);
  run(['config', 'user.email', 't@example.com']);
  run(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  return dir;
}

test('isolation defaults to a worktree for git repos, and swarms persist, detach, and resume', async (t) => {
  const repo = tempGitRepo();
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: repo }).isolate, true);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir() }).isolate, false);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: repo, isolate: false }).isolate, false);

  const first = await manager.start({ objective: 'Build it', workspace: repo, max_agents: 1 });
  assert.equal(first.branch, `swarm/${first.id}`);
  assert.notEqual(first.workspace, repo);
  assert.ok(fs.existsSync(path.join(first.workspace, 'README.md')), 'worktree checked out');
  const deadline = Date.now() + 5000;
  while (first.phase !== 'idle' && Date.now() < deadline) await first.waitForChange(500);
  assert.equal((await first.result()).branch, first.branch);
  await first.stop();
  // Left by the first team: a resume that took a fresh snapshot would count it as already there.
  fs.writeFileSync(path.join(first.workspace, 'left-by-first-team.txt'), 'x');
  const saved = JSON.parse(fs.readFileSync(path.join(first.dir, 'state.json'), 'utf8'));
  assert.equal(saved.phase, 'stopped');
  assert.equal(saved.branch, first.branch);

  // A later server process sees the clean stop as stopped...
  const later = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => later.shutdownAll());
  assert.equal(later.get(first.id).phase, 'stopped');
  assert.equal(saved.owner.pid, process.pid, 'state.json records the owning server process');
  // ...a swarm another live server process owns as owned-elsewhere, which cannot be resumed here...
  const liveOwner = { pid: process.ppid, heartbeatAt: new Date().toISOString() };
  fs.writeFileSync(path.join(first.dir, 'state.json'), JSON.stringify({ ...saved, phase: 'running', owner: liveOwner }));
  const second = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => second.shutdownAll());
  assert.equal(second.list().find((s) => s.swarmId === first.id).phase, 'owned-elsewhere');
  assert.match(second.get(first.id).status().ownedElsewhere, new RegExp(`pid ${process.ppid}`));
  await assert.rejects(second.resume(first.id), /still running in another DotSwarm server process/);
  await assert.rejects(second.get(first.id).steer('x'), /another DotSwarm server process/);
  // ...and reads it as detached once that owner's heartbeat goes stale.
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  fs.writeFileSync(path.join(first.dir, 'state.json'), JSON.stringify({ ...saved, phase: 'running', owner: { ...liveOwner, heartbeatAt: stale } }));
  assert.equal(second.get(first.id).phase, 'detached');
  // A swarm whose owner died mid-run is detached, replayed from its log. Our own pid in the
  // record means a previous process that happened to have it, so it reads as gone too.
  fs.writeFileSync(path.join(first.dir, 'state.json'), JSON.stringify({ ...saved, phase: 'running' }));
  const crashed = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => crashed.shutdownAll());
  const detached = crashed.get(first.id);
  assert.equal(detached.phase, 'detached');
  assert.match(detached.status().detached, /swarm_resume/);
  assert.deepEqual(detached.status().tasks.counts, { pending: 0, in_progress: 0, completed: 1 });
  assert.equal(detached.inspect('member:worker').messages[0].text, 'worker done');
  await assert.rejects(detached.steer('x'), /detached/);

  await assert.rejects(crashed.resume(first.id, { maxAgents: 'abc' }), /max_agents must be a whole number/);
  const resumed = await crashed.resume(first.id, { instruction: 'verify task-1 then finish', mode: 'refactor', design: true, maxAgents: 3.7 });
  assert.notEqual(resumed.id, first.id);
  assert.match(fs.readFileSync(path.join(resumed.dir, 'swarm.patch.yml'), 'utf8'), /^ {4}maxMembers: 3$/m, 'a resume caps its new team at its own budget');
  assert.equal(resumed.spec.mode, 'refactor');
  assert.equal(resumed.spec.design, true);
  assert.equal(resumed.spec.model, 'deepseek-flash', 'a design continuation of a default-model swarm switches to the vision model');
  assert.ok(fs.existsSync(path.join(resumed.dir, 'screens')));
  assert.equal(resumed.status().mode, 'refactor');
  assert.equal(resumed.status().design, true);
  assert.equal(resumed.workspace, first.workspace, 'reuses the existing worktree');
  assert.equal(resumed.branch, first.branch);
  assert.equal(resumed.spec.isolate, false);
  const prompt = fs.readFileSync(path.join(resumed.dir, 'lead-prompt.md'), 'utf8');
  assert.match(prompt, new RegExp(`RESUMING PREVIOUS SWARM ${first.id}`));
  assert.match(prompt, /task-1 \[completed, was worker\] Explore/);
  assert.match(prompt, /verify task-1 then finish/);
  assert.match(prompt, /PREVIOUS LEAD'S LAST MESSAGE/);
  assert.match(prompt, /REFACTOR MODE/);
  assert.match(prompt, /UX AND DESIGN ITERATION/);
  assert.equal(resumed.findings.readAll().length, first.findings.readAll().length, 'ledger carried over');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(resumed.dir, 'workspace-baseline.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(first.dir, 'workspace-baseline.json'), 'utf8')), 'the sweep compares against the first start');
  assert.equal(crashed.list().find((s) => s.swarmId === resumed.id).resumedFrom, first.id);
  await assert.rejects(crashed.resume(resumed.id), /still running/);
  const d2 = Date.now() + 5000;
  while (resumed.phase !== 'idle' && Date.now() < d2) await resumed.waitForChange(500);
  assert.equal(resumed.status().resumedFrom, first.id);
  assert.ok((await resumed.result()).git.newUntracked.includes('left-by-first-team.txt'), 'the sweep spans the whole chain');
  await resumed.stop();
});

test('spec validation', () => {
  const manager = new SwarmManager();
  assert.throws(() => manager.normalizeSpec({ workspace: os.tmpdir() }), /objective or objective_file is required/);
  assert.throws(() => manager.normalizeSpec({ objective: 'x', workspace: path.join(os.tmpdir(), 'nope-' + Date.now()) }), /does not exist/);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), max_agents: 99 }).maxAgents, 7);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), max_agents: 2.5 }).maxAgents, 2, 'the runtime limit must be an integer');
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), max_agents: '3' }).maxAgents, 3);
  assert.throws(() => manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), max_agents: 'abc' }), /max_agents must be a whole number/);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), max_tokens: 2048.9 }).maxTokens, 2048);
  assert.throws(() => manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), max_tokens: 'lots' }), /max_tokens must be a whole number/);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), permission_mode: 'read-only' }).permissionMode, 'read-only');
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), permission_mode: 'bogus' }).permissionMode, 'danger-full-access');
  const plain = manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir() });
  assert.equal(plain.design, false);
  assert.equal(plain.mode, 'build');
  assert.equal(plain.model, 'deepseek-v4-flash');
  const design = manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), design: true });
  assert.equal(design.model, 'deepseek-flash', 'design swarms switch to the vision model');
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), design: true, model: 'deepseek-v4-pro' }).model, 'deepseek-v4-pro');
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), mode: 'refactor' }).mode, 'refactor');
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), mode: 'nonsense' }).mode, 'build');
});

test('objective and context can come from files, one source each, capped like a brief', () => {
  const manager = new SwarmManager();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-brief-files-'));
  const objectiveFile = path.join(dir, 'brief.md');
  const brief = '# Brief\nMatch `\\(` and `\\*` literally; "quotes" stay.\n';
  fs.writeFileSync(objectiveFile, brief);
  const contextFile = path.join(dir, 'context.md');
  fs.writeFileSync(contextFile, 'do not touch db\n');
  const spec = manager.normalizeSpec({ objective_file: objectiveFile, context_file: contextFile, workspace: os.tmpdir() });
  assert.equal(spec.objective, brief.trim(), 'the file text arrives unescaped');
  assert.equal(spec.context, 'do not touch db\n');
  assert.throws(() => manager.normalizeSpec({ objective: 'x', objective_file: objectiveFile, workspace: os.tmpdir() }), /objective or objective_file, not both/);
  assert.throws(() => manager.normalizeSpec({ objective: 'x', context: 'y', context_file: contextFile, workspace: os.tmpdir() }), /context or context_file, not both/);
  assert.throws(() => manager.normalizeSpec({ objective_file: 'brief.md', workspace: os.tmpdir() }), /absolute path/);
  assert.throws(() => manager.normalizeSpec({ objective_file: path.join(dir, 'missing.md'), workspace: os.tmpdir() }), /objective_file cannot be read/);
  assert.throws(() => manager.normalizeSpec({ objective_file: dir, workspace: os.tmpdir() }), /not a regular file/, 'a directory, pipe, or device is refused before it is read');
  const dense = path.join(dir, 'dense.md');
  fs.writeFileSync(dense, `${'x'.repeat(40)} `.repeat(20_000));
  assert.equal(manager.normalizeSpec({ objective_file: dense, workspace: os.tmpdir() }).objective.length, 41 * 20_000 - 1, 'long words under the word cap are read');
  const long = path.join(dir, 'long.md');
  fs.writeFileSync(long, 'word '.repeat(30_001));
  assert.throws(() => manager.normalizeSpec({ objective_file: long, workspace: os.tmpdir() }), /30001 words; the cap is 30000/);
});

test('attentionReason holds routine progress and wakes on what needs the coordinator', () => {
  const base = { phase: 'running', error: null, newFindings: [], openQuestionIds: [], knownQuestionIds: [], toolErrorCount: 0, knownToolErrorCount: 0 };
  const f = (type, scope = 'pages/home') => ({ type, scope });
  assert.equal(attentionReason(base), null);
  assert.equal(attentionReason({ ...base, newFindings: [f('discovery'), f('result'), f('decision'), f('warning'), f('warning')] }), null);
  assert.equal(attentionReason({ ...base, newFindings: [f('decision', 'step7/plan')] }), 'plan');
  assert.equal(attentionReason({ ...base, newFindings: [f('warning'), f('warning'), f('warning')] }), 'warnings');
  assert.equal(attentionReason({ ...base, newFindings: [f('failure')] }), 'failure');
  assert.equal(attentionReason({ ...base, openQuestionIds: ['F-004'], knownQuestionIds: ['F-004'] }), null);
  assert.equal(attentionReason({ ...base, openQuestionIds: ['F-004', 'F-009'], knownQuestionIds: ['F-004'] }), 'question');
  assert.equal(attentionReason({ ...base, toolErrorCount: 3, knownToolErrorCount: 1 }), null);
  assert.equal(attentionReason({ ...base, toolErrorCount: 4, knownToolErrorCount: 1 }), 'tool-errors');
  assert.equal(attentionReason({ ...base, phase: 'idle' }), 'idle');
  assert.equal(attentionReason({ ...base, phase: 'stopped' }), 'stopped');
  assert.equal(attentionReason({ ...base, phase: 'detached' }), 'detached');
  assert.equal(attentionReason({ ...base, phase: 'owned-elsewhere' }), 'owned-elsewhere');
  assert.equal(attentionReason({ ...base, error: 'runtime exited' }), 'failed');
});

test('waitForAttention sleeps through routine findings and wakes on a failure or the end of the run', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'Make hello.txt', workspace, max_agents: 1, acceptance_criteria: ['hello.txt exists'] });
  assert.equal(await swarm.waitForAttention(5000), 'idle');

  const since = swarm.findings.lastId() ?? 'F-000';
  swarm.phase = 'running';
  swarm.findings.append({ author: 'lead', type: 'discovery', scope: 'notes', message: 'routine' });
  assert.equal(await swarm.waitForAttention(200, { sinceFinding: since }), 'timeout');
  const status = swarm.status({ sinceFinding: since });
  assert.deepEqual(status.findings.newByType, { discovery: 1 });

  setTimeout(() => swarm.findings.append({ author: 'reviewer', type: 'failure', scope: 'a11y', message: 'broken' }), 100);
  const started = Date.now();
  assert.equal(await swarm.waitForAttention(10_000, { sinceFinding: since }), 'failure');
  assert.ok(Date.now() - started < 5000, 'failure found by the poll, not the deadline');
});

test('swarm_result carries a compact ledger, risky files first, and writes a handoff', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'Make hello.txt', workspace, max_agents: 1, acceptance_criteria: ['hello.txt exists'] });
  await swarm.waitForAttention(5000);
  swarm.findings.append({ author: 'reviewer', type: 'failure', scope: 'gate', message: 'release gate exits 0 when blocked' });
  const fixed = swarm.findings.append({ author: 'reviewer', type: 'warning', scope: 'copy', message: 'too long' });
  swarm.findings.append({ author: 'lead', type: 'result', scope: 'copy', message: `Trimmed; resolves ${fixed.id}` });
  await swarm.steer('Owner confirmed: insured and bonded.');
  const result = await swarm.result();
  assert.equal(result.ledger.open.length, 1);
  assert.match(result.ledger.open[0], /release gate/);
  assert.equal(result.ledger.addressedCount, 1);
  assert.equal(result.findings, undefined, 'the full ledger is not returned');
  const handoff = fs.readFileSync(result.handoff, 'utf8');
  for (const needle of ['# Handoff:', 'Make hello.txt', 'insured and bonded', 'release gate exits 0', 'All done.']) {
    assert.ok(handoff.includes(needle), `handoff includes ${needle}`);
  }
});

test('brief and verify swarms work in place; a brief swarm reports its brief', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace }).isolate, true);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace, mode: 'verify' }).isolate, false);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace, mode: 'brief', brief_words: 50 }).briefWords, 1000);

  const swarm = await manager.start({ objective: 'Brief the sources', workspace, mode: 'brief', max_agents: 1 });
  assert.equal(swarm.branch, null, 'no worktree for a brief swarm');
  assert.match(fs.readFileSync(path.join(swarm.dir, 'lead-prompt.md'), 'utf8'), /BRIEF MODE/);
  await swarm.waitForAttention(5000);
  assert.equal((await swarm.result()).brief.missing, true);
  fs.writeFileSync(swarm.briefPath, 'one two three four');
  const { brief } = await swarm.result();
  assert.equal(brief.words, 4);
  assert.equal(brief.overBudget, false);
  assert.equal(brief.text, 'one two three four', 'a finished brief comes back inline');
  fs.writeFileSync(swarm.briefPath, 'word '.repeat(swarm.spec.briefWords * 2));
  assert.equal((await swarm.result()).brief.text, undefined, 'an oversized brief is not inlined');
  assert.match(fs.readFileSync(path.join(swarm.dir, 'handoff.md'), 'utf8'), /Brief: .*brief\.md \(read this instead of the sources\)/);
});

test('a design swarm result lists its final screenshots', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'Verify the site', workspace, mode: 'verify', design: true, max_agents: 1 });
  await swarm.waitForAttention(5000);
  const screens = path.join(swarm.dir, 'screens');
  for (const f of ['home-390-final.png', 'home-390-v1.png', 'service-deep-1440-final.png']) fs.writeFileSync(path.join(screens, f), '');
  const { screenshots } = await swarm.result();
  assert.equal(screenshots.length, 2);
  assert.ok(screenshots.every((p) => p.endsWith('-final.png')));
  assert.match(fs.readFileSync(path.join(swarm.dir, 'lead-prompt.md'), 'utf8'), /<screen>-<viewport>-final.png/);
});

test('the result lists files a swarm left untracked or ignored in the workspace since it started', async (t) => {
  const repo = tempGitRepo();
  fs.writeFileSync(path.join(repo, '.gitignore'), '.cache/\n.jest-cache/\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'ignore'], { cwd: repo });
  fs.mkdirSync(path.join(repo, '.cache'));
  fs.writeFileSync(path.join(repo, 'notes-before.md'), 'the owner was here first\n');
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'Make hello.txt', workspace: repo, isolate: false, max_agents: 1 });
  assert.ok(fs.statSync(path.join(swarm.dir, 'scratch')).isDirectory(), 'the scratch directory exists before the Lead starts');
  assert.ok(fs.readFileSync(path.join(swarm.dir, 'lead-prompt.md'), 'utf8').includes(`${path.join(swarm.dir, 'scratch').split(path.sep).join('/')}`));
  await swarm.waitForAttention(5000);
  fs.mkdirSync(path.join(repo, '.jest-cache', 'failproof'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.jest-cache', 'failproof', 'copy.test.js'), 'x');
  fs.writeFileSync(path.join(repo, 'probe.test.js'), 'x');
  fs.writeFileSync(path.join(repo, ' lead.txt'), 'x');
  const { git } = await swarm.result();
  assert.deepEqual(git.newIgnored, ['.jest-cache/']);
  assert.deepEqual(git.newUntracked, [' lead.txt', 'probe.test.js'], 'untracked files that were there at the start are not listed, and names keep their spaces');
});

test('with allowed_paths the result lists every changed path outside them, as git reports it', async (t) => {
  const repo = tempGitRepo();
  const run = (args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'src']);
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'Edit src', workspace: repo, isolate: false, max_agents: 1, allowed_paths: ['src', 'docs/*.md'] });
  assert.deepEqual(swarm.spec.allowedPaths, ['src', 'docs/*.md']);
  await swarm.waitForAttention(5000);
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'new\n');
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'docs', 'x.md'), 'doc\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
  fs.writeFileSync(path.join(repo, 'probe.test.js'), 'x');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'committed by the team\n');
  run(['add', 'other.txt']);
  run(['commit', '-q', '-m', 'team commit']);
  const { git } = await swarm.result();
  assert.deepEqual(git.outsideAllowedPaths, ['README.md', 'other.txt', 'probe.test.js']);

  const unscoped = await manager.start({ objective: 'x', workspace: repo, isolate: false, max_agents: 1 });
  await unscoped.waitForAttention(5000);
  assert.equal((await unscoped.result()).git.outsideAllowedPaths, undefined, 'no allowed_paths, no scope list');
});

test('allowed_paths leaves out what the workspace already had changed at the start, unless the team changes it again', async (t) => {
  const repo = tempGitRepo();
  fs.writeFileSync(path.join(repo, 'coordinator-notes.md'), 'mine\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo, edited by the coordinator\n');
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'Verify it', workspace: repo, mode: 'verify', max_agents: 1, allowed_paths: ['app'] });
  assert.equal(swarm.branch, null, 'a verify swarm works in place');
  await swarm.waitForAttention(5000);
  assert.deepEqual((await swarm.result()).git.outsideAllowedPaths, [], 'the team touched nothing');
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo, edited by the coordinator, then by the team\n');
  assert.deepEqual((await swarm.result()).git.outsideAllowedPaths, ['README.md'], 'a file dirty at the start that the team changes again is listed');
});

test('a long sweep list keeps only paths and reports the overflow in its own count', async (t) => {
  const repo = tempGitRepo();
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'x', workspace: repo, isolate: false, max_agents: 1, allowed_paths: ['src'] });
  await swarm.waitForAttention(5000);
  for (let i = 0; i < 52; i += 1) fs.writeFileSync(path.join(repo, `f-${String(i).padStart(2, '0')}.txt`), 'x');
  const { git } = await swarm.result();
  for (const field of ['newUntracked', 'outsideAllowedPaths']) {
    assert.equal(git[field].length, 50);
    assert.ok(git[field].every((p) => fs.existsSync(path.join(repo, p))), `${field} holds only paths`);
    assert.equal(git[`${field}Omitted`], 2);
  }
  assert.equal(git.newIgnoredOmitted, undefined);
});

function repoWithApp() {
  const repo = tempGitRepo();
  fs.mkdirSync(path.join(repo, 'app', 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'app', 'src', 'a.js'), 'a\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'app'], { cwd: repo });
  return repo;
}

test('a subdirectory workspace sweeps only itself, with paths and allowed_paths relative to it', async (t) => {
  const repo = repoWithApp();
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'Edit app', workspace: path.join(repo, 'app'), isolate: false, max_agents: 1, allowed_paths: ['src'] });
  await swarm.waitForAttention(5000);
  fs.mkdirSync(path.join(repo, 'other'));
  fs.writeFileSync(path.join(repo, 'other', 'sibling.txt'), 'another process\n');
  fs.writeFileSync(path.join(repo, 'app', 'src', 'new.js'), 'new\n');
  fs.writeFileSync(path.join(repo, 'app', 'stray.txt'), 'x\n');
  const { git } = await swarm.result();
  assert.deepEqual(git.newUntracked, ['src/new.js', 'stray.txt'], 'a sibling directory is not the team\'s');
  assert.deepEqual(git.outsideAllowedPaths, ['stray.txt']);
});

test('an isolated subdirectory workspace sweeps its whole worktree and resolves allowed_paths inside the same subdirectory', async (t) => {
  const repo = repoWithApp();
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'Edit app', workspace: path.join(repo, 'app'), max_agents: 1, allowed_paths: ['src'] });
  assert.ok(swarm.branch, 'isolated');
  await swarm.waitForAttention(5000);
  fs.writeFileSync(path.join(swarm.workspace, 'app', 'src', 'a.js'), 'changed\n');
  fs.writeFileSync(path.join(swarm.workspace, 'app', 'notes.md'), 'x\n');
  fs.writeFileSync(path.join(swarm.workspace, 'root-stray.txt'), 'x\n');
  const { git } = await swarm.result();
  assert.deepEqual(git.outsideAllowedPaths, ['app/notes.md', 'root-stray.txt'], 'app/src/a.js is inside src relative to app');
  assert.deepEqual(git.newUntracked, ['app/notes.md', 'root-stray.txt'], 'the worktree is the team\'s alone, so a stray outside app is listed too');
});

test('owner questions come back complete, numbered, and only from this run', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'Stage 2', workspace, max_agents: 1 });
  await swarm.waitForAttention(5000);
  // A question left in the ledger by an earlier stage does not count.
  fs.appendFileSync(swarm.findings.file, JSON.stringify({ id: 'F-900', time: '2000-01-01T00:00:00.000Z', author: 'lead', type: 'question', scope: 'owner', message: 'Old stage question' }) + '\n');
  const long = `Information needed: ${'x'.repeat(1500)}`;
  swarm.findings.append({ author: 'lead', type: 'question', scope: 'owner', message: 'Approval: Do you approve the visual direction?' });
  swarm.findings.append({ author: 'lead', type: 'question', scope: 'coordinator', message: 'Which folder holds the logo?' });
  swarm.findings.append({ author: 'lead', type: 'question', scope: 'owner/images', message: long });
  const result = await swarm.result();
  assert.deepEqual(result.ownerQuestions.map((q) => q.n), [1, 2]);
  assert.equal(result.ownerQuestions[0].text, 'Approval: Do you approve the visual direction?');
  assert.equal(result.ownerQuestions[1].text, long, 'long questions are not cut at 500 characters');
  assert.ok(result.openQuestions.every((q) => !q.includes('visual direction')), 'owner questions stay out of the coordinator list');
  assert.ok(result.openQuestions.some((q) => q.includes('logo')));
  assert.match(fs.readFileSync(result.handoff, 'utf8'), /Questions for the owner[\s\S]*1\. Approval: Do you approve/);
});
