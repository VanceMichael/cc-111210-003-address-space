import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listen } from '../src/http.mjs';
import { browseAll, collectInventory, diffInventory, parseNodeSpec } from '../src/inventory.mjs';
import { startService } from '../src/service.mjs';
import { startFixture } from '../fixtures/source.mjs';

const ROOT_ID = JSON.stringify(['urn:port', 's', 'Root']);
const PUMP_ID = JSON.stringify(['urn:port', 's', 'Pump']);
const ALIAS_ID = JSON.stringify(['urn:port', 's', 'Alias']);
const SHARED_ID = JSON.stringify(['urn:port', 's', 'Shared']);
const VALUE_ID = JSON.stringify(['urn:port', 's', 'Value']);
const SAMPLES_ID = JSON.stringify(['urn:port', 's', 'Samples']);
const PRESSURE_TYPE_ID = JSON.stringify(['urn:port', 's', 'PressureType']);
const BASE_TYPE_ID = JSON.stringify(['urn:port', 's', 'BaseVariableType']);

test('节点标识解析支持URI形式并拒绝未知命名空间', () => {
  assert.equal(parseNodeSpec(['urn:base', 'urn:port'], 'nsu=urn:port;s=Root').node, 'ns=1;s=Root');
  assert.equal(parseNodeSpec(['urn:base', 'urn:port'], 'ns=1;s=Root').id, ROOT_ID);
  assert.throws(() => parseNodeSpec(['urn:base'], 'nsu=urn:missing;s=Root'), /未注册/);
  assert.throws(() => parseNodeSpec(['urn:base'], 'ns=5;s=Root'), /未知/);
  assert.throws(() => parseNodeSpec(['urn:base'], 'junk'), /格式无效/);
});

test('清单按URI身份去重，多父节点、环与匿名显示名可解释', async () => {
  const source = await startFixture();
  try {
    const manifest = await collectInventory(source.url, { roots: ['ns=1;s=Root'] });
    assert.equal(manifest.stats.nodes, 6);
    const shared = manifest.nodes[SHARED_ID];
    assert.deepEqual(shared.parents.map(edge => edge.id).sort(), [PUMP_ID, ROOT_ID].sort());
    assert.deepEqual(shared.cycles, [{ reference: 'Organizes', target: ROOT_ID }]);
    const pump = manifest.nodes[PUMP_ID];
    assert.ok(pump.parents.some(edge => edge.id === ALIAS_ID && edge.reference === 'Organizes'));
    const value = manifest.nodes[VALUE_ID];
    assert.equal(value.name, null);
    assert.equal(value.anonymous, true);
    assert.equal(value.path, 'Root/Pump/(s=Value)');
    assert.equal(manifest.errors.length, 0);
  } finally { await source.close(); }
});

test('变量解析继承类型约束，读不到的元数据不填默认值', async () => {
  const source = await startFixture();
  try {
    const manifest = await collectInventory(source.url, { roots: ['ns=1;s=Root'] });
    const value = manifest.nodes[VALUE_ID].variable;
    assert.equal(value.dataType, 'Double');
    assert.equal(value.valueRank, -1);
    assert.equal(value.arrayDimensions, null);
    assert.ok(value.missing.includes('arrayDimensions'));
    assert.equal(value.readable, true);
    assert.equal(value.unit, 'kPa');
    assert.equal(value.unitSource, PRESSURE_TYPE_ID);
    assert.deepEqual(value.typeChain.map(entry => entry.id), [PRESSURE_TYPE_ID, BASE_TYPE_ID]);
    const samples = manifest.nodes[SAMPLES_ID].variable;
    assert.deepEqual(samples.arrayDimensions, [4]);
    assert.equal(samples.readable, false);
    assert.equal(samples.unit, 'kPa');
    assert.deepEqual(manifest.points.map(point => point.id), [VALUE_ID]);
  } finally { await source.close(); }
});

test('分页结束后句柄释放，重复采集不触发句柄上限', async () => {
  const source = await startFixture();
  try {
    await collectInventory(source.url, { roots: ['ns=1;s=Root'] });
    const probe = async () => (await (await fetch(source.url + '/release?handle=probe')).json()).active;
    assert.equal(await probe(), 0);
    await collectInventory(source.url, { roots: ['ns=1;s=Root'] });
    assert.equal(await probe(), 0);
  } finally { await source.close(); }
});

test('分页中断时释放续读句柄', async () => {
  const released = [];
  const gateway = await listen(async url => {
    if (url.pathname === '/browse') return { body: { references: [{ type: 'HasComponent', node: 'ns=1;s=A' }], continuation: 'h1' } };
    if (url.pathname === '/next') throw new Error('网关故障');
    if (url.pathname === '/release') { released.push(url.searchParams.get('handle')); return { body: { active: 0 } }; }
    return { status: 404, body: {} };
  });
  try {
    await assert.rejects(browseAll(gateway.url, 'ns=1;s=Root'), /400/);
    assert.deepEqual(released, ['h1']);
  } finally { await gateway.close(); }
});

test('单个根失败不影响其他根，白名单与数量上限约束清单范围', async () => {
  const source = await startFixture();
  try {
    const partial = await collectInventory(source.url, { roots: ['ns=1;s=Missing', 'ns=1;s=Root'] });
    assert.equal(partial.errors.length, 1);
    assert.match(partial.errors[0].message, /不存在/);
    assert.ok(partial.nodes[ROOT_ID]);
    const componentsOnly = await collectInventory(source.url, { roots: ['ns=1;s=Root'], references: ['HasComponent'] });
    assert.ok(!componentsOnly.nodes[ALIAS_ID]);
    assert.ok(componentsOnly.nodes[VALUE_ID]);
    const bounded = await collectInventory(source.url, { roots: ['ns=1;s=Root'], maxNodes: 2 });
    assert.equal(Object.keys(bounded.nodes).length, 2);
    assert.ok(bounded.truncated.length >= 1);
    const shallow = await collectInventory(source.url, { roots: ['ns=1;s=Root'], maxDepth: 1 });
    assert.ok(!shallow.nodes[VALUE_ID]);
    assert.ok(shallow.truncated.length >= 1);
  } finally { await source.close(); }
});

test('命名空间重排后测点身份不变且旧编号配置显式失败', async () => {
  const source = await startFixture();
  try {
    const before = await collectInventory(source.url, { roots: ['nsu=urn:port;s=Root'] });
    await fetch(source.url + '/reorder');
    const after = await collectInventory(source.url, { roots: ['nsu=urn:port;s=Root'] });
    assert.equal(before.nodes[VALUE_ID].node, 'ns=1;s=Value');
    assert.equal(after.nodes[VALUE_ID].node, 'ns=2;s=Value');
    assert.deepEqual(Object.keys(after.nodes).sort(), Object.keys(before.nodes).sort());
    assert.equal(diffInventory(before, after).summary.stable, true);
    const stale = await collectInventory(source.url, { roots: ['ns=1;s=Root'] });
    assert.equal(Object.keys(stale.nodes).length, 0);
    assert.equal(stale.errors.length, 1);
  } finally { await source.close(); }
});

test('清单对比只报告真实变化', () => {
  const variable = {
    dataType: 'Double', valueRank: -1, arrayDimensions: null, readable: true,
    missing: ['arrayDimensions'], unit: 'kPa', unitSource: 'T', type: 'T',
    typeChain: [{ id: 'T', node: 'ns=1;s=T', name: 'T', unit: 'kPa' }],
  };
  const before = {
    nodes: {
      A: { id: 'A', node: 'ns=1;s=A', name: 'A', nodeClass: 'Variable', parents: [], cycles: [], path: 'A', variable },
      B: { id: 'B', node: 'ns=1;s=B', name: 'B', nodeClass: 'Object', parents: [{ id: 'A', reference: 'HasComponent' }], cycles: [], path: 'A/B' },
    },
  };
  const reordered = structuredClone(before);
  reordered.nodes.A.node = 'ns=7;s=A';
  reordered.nodes.A.path = 'X/A';
  reordered.nodes.A.variable.typeChain[0].node = 'ns=7;s=T';
  assert.equal(diffInventory(before, reordered).summary.stable, true);
  const changed = structuredClone(before);
  changed.nodes.A.variable.readable = false;
  delete changed.nodes.B;
  changed.nodes.C = { id: 'C', node: 'ns=1;s=C', name: 'C', nodeClass: 'Object', parents: [], cycles: [], path: 'C' };
  const diff = diffInventory(before, changed);
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.removed, 1);
  assert.deepEqual(diff.changed[0].fields['variable.readable'], { before: true, after: false });
  const moved = structuredClone(before);
  moved.nodes.B.parents = [{ id: 'C', reference: 'Organizes' }];
  const movedDiff = diffInventory(before, moved);
  assert.equal(movedDiff.summary.changed, 1);
  assert.ok(movedDiff.changed[0].fields.parents);
});

test('服务端到端：清单采集、留存基线、重排演练对比，逐节点诊断保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    const root = encodeURIComponent('nsu=urn:port;s=Root');
    const inspect = await fetch(service.url + '/inspect');
    assert.equal(inspect.status, 200);
    assert.equal((await inspect.json()).references.length, 2);
    const manifest = await (await fetch(service.url + `/inventory?root=${root}`)).json();
    assert.ok(manifest.nodes[VALUE_ID]);
    const first = await (await fetch(service.url + `/inventory/receive?key=base&root=${root}`)).json();
    const second = await (await fetch(service.url + `/inventory/receive?key=base&root=${root}`)).json();
    assert.equal(first.digest, second.digest);
    await fetch(fixture.url + '/reorder');
    const drill = await (await fetch(service.url + `/inventory/diff?key=base&root=${root}`)).json();
    assert.equal(drill.diff.summary.stable, true);
    assert.equal(drill.errors.length, 0);
    const moved = await fetch(service.url + '/inspect?node=' + encodeURIComponent('ns=2;s=Root'));
    assert.equal(moved.status, 200);
  } finally {
    await service.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
