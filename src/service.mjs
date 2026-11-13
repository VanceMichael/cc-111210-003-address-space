import { listen } from './http.mjs';
import { inspect } from './connector.mjs';
import { collectInventory, diffInventory } from './inventory.mjs';
import { ReceiptStore } from './store.mjs';

function inventoryOptions(searchParams) {
  const options = {};
  const roots = searchParams.getAll('root').filter(Boolean);
  const references = searchParams.getAll('reference').filter(Boolean);
  if (roots.length) options.roots = roots;
  if (references.length) options.references = references;
  for (const key of ['maxDepth', 'maxNodes']) {
    const raw = searchParams.get(key);
    if (raw !== null) {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) throw new Error(`参数无效: ${key}`);
      options[key] = value;
    }
  }
  return options;
}

export async function startService({ source, directory, port = 0 }) {
  const store = new ReceiptStore(directory);
  return listen(async url => {
    if (url.pathname === '/health') return { body: { state: 'ready' } };
    if (url.pathname === '/inspect') {
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: result };
    }
    if (url.pathname === '/receive') {
      const key = url.searchParams.get('key') ?? 'single';
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: await store.save(key, result) };
    }
    if (url.pathname === '/inventory') {
      return { body: await collectInventory(source, inventoryOptions(url.searchParams)) };
    }
    if (url.pathname === '/inventory/receive') {
      const key = url.searchParams.get('key') ?? 'inventory';
      const manifest = await collectInventory(source, inventoryOptions(url.searchParams));
      return { body: await store.save(key, manifest) };
    }
    if (url.pathname === '/inventory/diff') {
      const key = url.searchParams.get('key') ?? 'inventory';
      let baseline;
      try {
        baseline = await store.read(key);
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`基线不存在: ${key}，请先通过 /inventory/receive 留存`);
        throw error;
      }
      const current = await collectInventory(source, inventoryOptions(url.searchParams));
      // 当前采集若有失败或截断，diff 可能把未到达的节点误报为删除，一并返回以便解释
      return { body: { key, baselineDigest: baseline.digest, diff: diffInventory(baseline.value, current), errors: current.errors, truncated: current.truncated } };
    }
    if (url.pathname.startsWith('/receipts/')) return { body: await store.read(url.pathname.split('/').pop()) };
    return { status: 404, body: { error: '接口不存在' } };
  }, port);
}
