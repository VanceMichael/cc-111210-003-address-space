import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { startService } from './service.mjs';

const directory = await mkdtemp(join(tmpdir(), 'capture-demo-'));
const source = await startFixture();
let service;
try {
  service = await startService({ source: source.url, directory });
  const single = await (await fetch(service.url + '/receive?key=demo')).json();
  const root = encodeURIComponent('nsu=urn:port;s=Root');
  const baseline = await (await fetch(service.url + `/inventory/receive?key=inventory&root=${root}`)).json();
  await fetch(source.url + '/reorder'); // 模拟厂商维护后的命名空间编号重排
  const drill = await (await fetch(service.url + `/inventory/diff?key=inventory&root=${root}`)).json();
  console.log(JSON.stringify({
    source: source.url,
    service: service.url,
    single,
    points: baseline.value.points,
    reorderDrill: drill.diff.summary,
  }, null, 2));
} finally {
  await service?.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
