import { get } from './http.mjs';
import { canonicalNode } from './connector.mjs';

const DEFAULT_ROOTS = ['ns=1;s=Root'];
const DEFAULT_REFERENCES = ['HasComponent', 'Organizes'];
const VARIABLE_FIELDS = ['displayName', 'dataType', 'valueRank', 'arrayDimensions', 'readable'];
const MAX_PAGES = 1000;

export class Truncated extends Error {
  constructor(message) { super(message); this.name = 'Truncated'; }
}

// 节点身份 = 命名空间 URI + 标识符类型 + 标识符。ns= 编号只是当前会话的索引，
// 厂商维护后编号可能重排，因此根节点也支持 nsu=<URI> 形式，重排后仍可复用。
export function parseNodeSpec(namespaces, spec) {
  const match = /^(?:ns=(\d+)|nsu=([^;]+));([is])=(.+)$/.exec(spec ?? '');
  if (!match) throw new Error(`节点标识格式无效: ${spec}`);
  const [, indexText, uriText, type, identifier] = match;
  let index;
  if (indexText !== undefined) {
    index = Number(indexText);
    if (!namespaces[index]) throw new Error(`命名空间编号未知: ns=${indexText}`);
  } else {
    index = namespaces.indexOf(uriText);
    if (index < 0) throw new Error(`命名空间URI未注册: ${uriText}`);
  }
  const node = `ns=${index};${type}=${identifier}`;
  return { node, id: canonicalNode(namespaces, node), uri: namespaces[index], type, identifier };
}

async function releaseHandle(base, handle) {
  try {
    await get(base, '/release?handle=' + encodeURIComponent(handle));
  } catch {
    // 释放失败不掩盖遍历的原始错误
  }
}

// 顺序拉取一个节点的全部引用。网关句柄有限，任何分页中断或取消都要尽力释放续读句柄。
export async function browseAll(base, node) {
  const first = await (await get(base, '/browse?node=' + encodeURIComponent(node))).json();
  const references = [...(first.references ?? [])];
  let continuation = first.continuation ?? null;
  try {
    for (let pages = 0; continuation; pages += 1) {
      if (pages >= MAX_PAGES) throw new Error('分页页数超出上限');
      const page = await (await get(base, '/next?handle=' + encodeURIComponent(continuation))).json();
      references.push(...(page.references ?? []));
      continuation = page.continuation ?? null;
    }
  } catch (error) {
    if (continuation) await releaseHandle(base, continuation);
    throw error;
  }
  return references;
}

async function readNode(base, node) {
  return (await get(base, '/read?node=' + encodeURIComponent(node))).json();
}

// 解析变量的继承类型约束：沿 HasTypeDefinition 找到类型，再沿 HasSubtype 逐级向上。
// 读不到的字段保持 null 并列入 missing，不填默认值；单位取链上最近一级声明，
// 没有任何一级声明时 unit 为 null（未知），而不是"无单位"之类的默认值。
async function resolveVariable(base, namespaces, meta, references) {
  const variable = {
    dataType: meta.dataType ?? null,
    valueRank: meta.valueRank ?? null,
    arrayDimensions: meta.arrayDimensions ?? null,
    readable: typeof meta.readable === 'boolean' ? meta.readable : null,
    missing: VARIABLE_FIELDS.filter(field => meta[field] === undefined),
    unit: null,
    unitSource: null,
    type: null,
    typeChain: [],
  };
  const typeReference = references.find(reference => reference.type === 'HasTypeDefinition');
  if (!typeReference) return variable;
  try {
    let current = parseNodeSpec(namespaces, typeReference.node);
    const seen = new Set();
    while (current) {
      if (seen.has(current.id)) {
        variable.typeChainCycle = current.id;
        break;
      }
      seen.add(current.id);
      let typeMeta;
      try {
        typeMeta = await readNode(base, current.node);
      } catch (error) {
        variable.typeChainError = error.message;
        break;
      }
      const entry = {
        id: current.id,
        node: current.node,
        name: typeof typeMeta.displayName === 'string' && typeMeta.displayName.length ? typeMeta.displayName : null,
        unit: typeof typeMeta.unit === 'string' ? typeMeta.unit : null,
      };
      variable.typeChain.push(entry);
      if (variable.unit === null && entry.unit !== null) {
        variable.unit = entry.unit;
        variable.unitSource = entry.id;
      }
      const typeReferences = await browseAll(base, current.node);
      const superReference = typeReferences.find(reference => reference.type === 'HasSubtype');
      current = superReference ? parseNodeSpec(namespaces, superReference.node) : null;
    }
    variable.type = variable.typeChain[0]?.id ?? null;
  } catch (error) {
    variable.typeError = error.message;
  }
  return variable;
}

// 按指定根与引用白名单生成有界清单。组织/组件引用是层级遍历关系，类型引用只用于
// 变量元数据解析，两者不混为同一种父子关系。节点身份去重：多个父节点只记录一次节点，
// 展示路径只是首次发现时到达该节点的一条路径；环记录为回边，不再重复展开。
// 单个根或单条边失败只记入 errors / edgeErrors，不影响其他根与已采集节点。
export async function collectInventory(base, options = {}) {
  const namespaces = await (await get(base, '/namespaces')).json();
  const rootSpecs = options.roots?.length ? options.roots : DEFAULT_ROOTS;
  const whitelist = new Set(options.references?.length ? options.references : DEFAULT_REFERENCES);
  const maxDepth = options.maxDepth ?? 32;
  const maxNodes = options.maxNodes ?? 1000;
  const nodes = new Map();
  const errors = [];
  const truncated = [];
  const visited = new Set();

  function noteTruncated(entry) {
    if (!truncated.some(item => item.node === entry.node && item.reason === entry.reason)) truncated.push(entry);
  }

  async function visit(spec, parentEdge, parentPath, stack, depth) {
    if (visited.has(spec.id)) {
      const existing = nodes.get(spec.id);
      if (parentEdge && !existing.parents.some(edge => edge.id === parentEdge.id && edge.reference === parentEdge.reference)) {
        existing.parents.push(parentEdge);
      }
      return;
    }
    if (nodes.size >= maxNodes) throw new Truncated(`节点数量达到上限 ${maxNodes}`);
    visited.add(spec.id);
    const references = await browseAll(base, spec.node);
    let meta = null;
    let readError = null;
    try {
      meta = await readNode(base, spec.node);
    } catch (error) {
      readError = error.message;
    }
    const name = typeof meta?.displayName === 'string' && meta.displayName.length ? meta.displayName : null;
    // 匿名显示名回退到节点标识符，路径仍可解释
    const segment = name ?? `(${spec.type}=${spec.identifier})`;
    const record = {
      id: spec.id,
      node: spec.node,
      name,
      anonymous: name === null,
      nodeClass: meta?.nodeClass ?? null,
      depth,
      path: parentPath ? `${parentPath}/${segment}` : segment,
      parents: parentEdge ? [parentEdge] : [],
      cycles: [],
    };
    if (readError) record.readError = readError;
    nodes.set(spec.id, record);
    if (meta?.nodeClass === 'Variable') {
      record.variable = await resolveVariable(base, namespaces, meta, references);
    }
    const nextStack = [...stack, spec.id];
    for (const reference of references) {
      let target;
      try {
        target = parseNodeSpec(namespaces, reference.node);
      } catch (error) {
        (record.edgeErrors ??= []).push({ reference: reference.type, node: reference.node, message: error.message });
        continue;
      }
      if (!whitelist.has(reference.type)) {
        (record.otherReferences ??= []).push({ reference: reference.type, target: target.id });
        continue;
      }
      if (target.id === spec.id || stack.includes(target.id)) {
        if (!record.cycles.some(edge => edge.reference === reference.type && edge.target === target.id)) {
          record.cycles.push({ reference: reference.type, target: target.id });
        }
        continue;
      }
      if (depth + 1 > maxDepth) {
        noteTruncated({ node: spec.id, reason: `遍历深度达到上限 ${maxDepth}` });
        continue;
      }
      try {
        await visit(target, { id: spec.id, reference: reference.type }, record.path, nextStack, depth + 1);
      } catch (error) {
        if (error instanceof Truncated) throw error;
        (record.edgeErrors ??= []).push({ reference: reference.type, node: reference.node, message: error.message });
      }
    }
  }

  const roots = [];
  for (const specText of rootSpecs) {
    let spec;
    try {
      spec = parseNodeSpec(namespaces, specText);
    } catch (error) {
      errors.push({ root: specText, message: error.message });
      continue;
    }
    roots.push({ node: spec.node, id: spec.id });
    try {
      await visit(spec, null, '', [], 0);
    } catch (error) {
      if (error instanceof Truncated) noteTruncated({ node: spec.id, reason: error.message });
      else errors.push({ root: spec.node, id: spec.id, message: error.message });
    }
  }

  const records = [...nodes.values()];
  const points = records
    .filter(record => record.variable?.readable === true)
    .map(record => ({
      id: record.id,
      node: record.node,
      path: record.path,
      dataType: record.variable.dataType,
      valueRank: record.variable.valueRank,
      unit: record.variable.unit,
    }));
  return {
    version: 1,
    namespaces,
    roots,
    references: [...whitelist],
    bounds: { maxDepth, maxNodes },
    nodes: Object.fromEntries(nodes),
    points,
    errors,
    truncated,
    stats: {
      nodes: nodes.size,
      variables: records.filter(record => record.variable).length,
      points: points.length,
      errors: errors.length,
      truncated: truncated.length,
    },
  };
}

// 对比两次清单，只报告真实变化：节点增删、父节点集合、环、变量元数据。
// ns= 编号、展示路径、发现顺序不算变化，因此命名空间重排不会产生伪差异。
export function diffInventory(before, after) {
  const beforeNodes = before?.nodes ?? {};
  const afterNodes = after?.nodes ?? {};
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, record] of Object.entries(afterNodes)) {
    if (!(id in beforeNodes)) added.push({ id, node: record.node, path: record.path });
  }
  for (const [id, record] of Object.entries(beforeNodes)) {
    if (!(id in afterNodes)) removed.push({ id, node: record.node, path: record.path });
  }
  let unchanged = 0;
  for (const [id, current] of Object.entries(afterNodes)) {
    const previous = beforeNodes[id];
    if (!previous) continue;
    const fields = {};
    compareScalar(fields, 'name', previous.name ?? null, current.name ?? null);
    compareScalar(fields, 'nodeClass', previous.nodeClass ?? null, current.nodeClass ?? null);
    compareScalar(fields, 'readError', previous.readError ?? null, current.readError ?? null);
    compareSet(fields, 'parents',
      (previous.parents ?? []).map(edge => `${edge.reference}<-${edge.id}`),
      (current.parents ?? []).map(edge => `${edge.reference}<-${edge.id}`));
    compareSet(fields, 'cycles',
      (previous.cycles ?? []).map(edge => `${edge.reference}->${edge.target}`),
      (current.cycles ?? []).map(edge => `${edge.reference}->${edge.target}`));
    compareVariable(fields, previous.variable ?? null, current.variable ?? null);
    if (Object.keys(fields).length) changed.push({ id, node: current.node, fields });
    else unchanged += 1;
  }
  return {
    added,
    removed,
    changed,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged,
      stable: added.length === 0 && removed.length === 0 && changed.length === 0,
    },
  };
}

function compareScalar(fields, key, before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) fields[key] = { before, after };
}

function compareSet(fields, key, before, after) {
  const b = [...before].sort();
  const a = [...after].sort();
  if (JSON.stringify(b) !== JSON.stringify(a)) fields[key] = { before: b, after: a };
}

function compareVariable(fields, before, after) {
  if (!before && !after) return;
  if (!before || !after) {
    fields.variable = { before: before ? 'present' : null, after: after ? 'present' : null };
    return;
  }
  for (const key of ['dataType', 'valueRank', 'arrayDimensions', 'readable', 'unit', 'type']) {
    compareScalar(fields, `variable.${key}`, before[key] ?? null, after[key] ?? null);
  }
  const beforeChain = (before.typeChain ?? []).map(entry => `${entry.id}:${entry.unit ?? ''}`);
  const afterChain = (after.typeChain ?? []).map(entry => `${entry.id}:${entry.unit ?? ''}`);
  if (JSON.stringify(beforeChain) !== JSON.stringify(afterChain)) {
    fields['variable.typeChain'] = { before: beforeChain, after: afterChain };
  }
}
