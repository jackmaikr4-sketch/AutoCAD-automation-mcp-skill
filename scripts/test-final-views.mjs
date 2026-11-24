import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..'),
  delivery = JSON.parse(
    await fs.readFile(path.join(root, 'artifacts/final-delivery.json'), 'utf8'),
  ),
  events = [];
const client = new Client({ name: 'final-views', version: '1' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'src/server.mjs')],
    stderr: 'inherit',
  }),
);
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  assert.ok(!r.isError, r.content[0].text);
  const result = JSON.parse(r.content[0].text);
  events.push({ name, args, result, ok: true });
  await fs.writeFile(
    path.join(root, 'artifacts/final-views-tests.json'),
    JSON.stringify(events, null, 2),
  );
  console.log(name, 'OK');
  return result;
}
let recording = false;
try {
  await call('connect_autocad');
  await call('start_recording', {
    path: path.join(root, 'artifacts', `07-final-views-${Date.now()}.mp4`),
  });
  recording = true;
  await call('create_new_drawing');
  await call('api_info');
  await call('draw_line', { start: [0, 0, 0], end: [10, 0, 0] });
  await call('undo_operation');
  assert.equal((await call('get_entity_count')).count, 0);
  await call('open_drawing', { path: path.join(delivery.folder, 'mechanical-bracket.dwg') });
  for (const view of ['top', 'front', 'side', 'isometric']) {
    await call('set_view', { view, target: [60, 40, 34], height: 160 });
    await new Promise((r) => setTimeout(r, 1500));
    await call('screenshot', { path: path.join(delivery.folder, view + '.png') });
  }
  const model = await call('inspect_3d_model');
  assert.equal(model.solid_count, 1);
  assert.deepEqual(model.size, [120, 80, 68]);
  await call('save_drawing', {
    path: path.join(delivery.folder, 'mechanical-bracket.dwg'),
    overwrite: true,
  });
  await call('stop_recording');
  recording = false;
} finally {
  if (recording) await call('stop_recording');
  await client.close();
}
