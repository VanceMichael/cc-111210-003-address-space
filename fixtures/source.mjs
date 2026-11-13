import { listen } from '../src/http.mjs';

const GRAPH = {
  Root: [['HasComponent', 'Pump'], ['Organizes', 'Alias'], ['HasComponent', 'Shared']],
  Pump: [['HasComponent', 'Value'], ['HasComponent', 'Shared'], ['HasComponent', 'Samples']],
  Alias: [['Organizes', 'Pump']],
  Shared: [['Organizes', 'Root']],
  Value: [['HasTypeDefinition', 'PressureType']],
  Samples: [['HasTypeDefinition', 'PressureType']],
  PressureType: [['HasSubtype', 'BaseVariableType']],
  BaseVariableType: [],
};

const METADATA = {
  Root: { nodeClass: 'Object', displayName: 'Root' },
  Pump: { nodeClass: 'Object', displayName: 'Pump' },
  Alias: { nodeClass: 'Object', displayName: 'Alias' },
  Shared: { nodeClass: 'Object', displayName: 'Shared' },
  Value: { nodeClass: 'Variable', displayName: '', dataType: 'Double', valueRank: -1, readable: true },
  Samples: { nodeClass: 'Variable', displayName: 'Samples', dataType: 'Double', valueRank: 1, arrayDimensions: [4], readable: false },
  PressureType: { nodeClass: 'VariableType', displayName: 'PressureType', inherited: true, unit: 'kPa' },
  BaseVariableType: { nodeClass: 'VariableType', displayName: 'BaseVariableType', inherited: false, unit: null },
};

export async function startFixture() {
  let swap = false; let next = 0; const handles = new Map();
  return listen(async url => {
    const ns = swap ? 2 : 1;
    if (url.pathname === '/namespaces') return { body: swap ? ['urn:base', 'urn:unrelated', 'urn:port'] : ['urn:base', 'urn:port'] };
    if (url.pathname === '/reorder') { swap = !swap; handles.clear(); return { body: { changed: true } }; }
    if (url.pathname === '/release') { handles.delete(url.searchParams.get('handle')); return { body: { active: handles.size } }; }
    if (url.pathname === '/read') {
      const name = url.searchParams.get('node')?.split(';s=')[1];
      if (!(name in METADATA)) throw new Error('节点不存在');
      return { body: METADATA[name] };
    }
    if (!['/browse', '/next'].includes(url.pathname)) return { status: 404, body: {} };
    let refs;
    if (url.pathname === '/next') { const handle = url.searchParams.get('handle'); refs = handles.get(handle); handles.delete(handle); if (!refs) throw new Error('浏览句柄失效'); }
    else { const node = url.searchParams.get('node') ?? ''; if (!node.startsWith(`ns=${ns};s=`)) throw new Error('命名空间编号不匹配'); const name = node.split(';s=')[1]; if (!(name in GRAPH)) throw new Error('节点不存在'); refs = GRAPH[name].map(([type, target]) => ({ type, node: `ns=${ns};s=${target}` })); }
    const page = refs.slice(0, 2); const remaining = refs.slice(2); let continuation = null;
    if (remaining.length) { if (handles.size >= 2) throw new Error('浏览句柄已满'); continuation = 'h' + (++next); handles.set(continuation, remaining); }
    return { body: { references: page, continuation, active: handles.size } };
  });
}
