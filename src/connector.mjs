import { get } from './http.mjs';
export function canonicalNode(namespaces, node) {
  const match = /^ns=(\d+);([is])=(.+)$/.exec(node);
  if (!match || !namespaces[Number(match[1])]) throw new Error('节点命名空间未知');
  return JSON.stringify([namespaces[Number(match[1])], match[2], match[3]]);
}
export async function inspect(base, options = {}) {
  return (await get(base, '/browse?node=' + encodeURIComponent(options.node ?? 'ns=1;s=Root'))).json();
}
