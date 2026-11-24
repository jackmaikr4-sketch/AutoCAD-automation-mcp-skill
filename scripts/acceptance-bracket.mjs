import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..'),
  run = new Date().toISOString().replace(/[:.]/g, '-'),
  folder = path.join(root, 'output', 'bracket-' + run);
await fs.mkdir(folder, { recursive: true });
const client = new Client({ name: 'bracket-real-mcp-acceptance', version: '1' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'src/server.mjs')],
    stderr: 'inherit',
  }),
);
const audit = [];
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  const text = r.content.find((c) => c.type === 'text').text;
  const result = JSON.parse(text);
  audit.push({ name, args, result, ok: !r.isError });
  await fs.writeFile(path.join(folder, 'acceptance.json'), JSON.stringify(audit, null, 2));
  console.log(
    name,
    r.isError ? 'FAIL ' + text : 'OK',
    name === 'execute_modeling_plan' ? result.status : '',
  );
  if (r.isError) throw Error(text);
  return result;
}
const steps = [];
const add = (id, tool, args, checks) =>
  steps.push({ id, tool, args, ...(checks ? { checks } : {}) });
const ref = (id) => '$' + id + '.handles.0';
const dims = (x, y, z) => [{ path: 'entities.0.size', expected: [x, y, z] }];
const assumptions = [
  '毫米。底板120×80×8；支撑板沿后侧y=72..80，宽120，厚8，净高60，从底板上表面z=8起算，总高68。',
  '底板孔直径10，中心距边15（测试假设，避开支撑板）：(15,15),(105,15),(15,65),(105,65)。',
  '支撑板两孔直径10，轴沿Y，中心X=35/85、Z=38。',
  '底板右上侧边及支撑板右上侧边采用1×1 mm等距倒角。',
];
let recording = false;
try {
  await call('connect_autocad');
  await call('start_recording', {
    path: path.join(root, 'artifacts', '05-bracket-' + run + '.mp4'),
  });
  recording = true;
  await call('create_new_drawing');
  add('layer', 'create_layer', { name: 'BRACKET_SOLID', color: 4 });
  add('current', 'set_layer', { name: 'BRACKET_SOLID' });
  add(
    'base',
    'create_3d_box',
    { origin: [0, 0, 0], length: 120, width: 80, height: 8 },
    dims(120, 80, 8),
  );
  add(
    'baseChamfer',
    'chamfer_3d',
    { handle: ref('base'), indices: [12], face_index: 1, distance: 1 },
    [{ path: 'volume', expected: 76760, tolerance: 1e-6 }],
  );
  add(
    'wall',
    'create_3d_box',
    { origin: [0, 72, 8], length: 120, width: 8, height: 60 },
    dims(120, 8, 60),
  );
  add(
    'wallChamfer',
    'chamfer_3d',
    { handle: ref('wall'), indices: [12], face_index: 1, distance: 1 },
    [{ path: 'volume', expected: 57596, tolerance: 1e-6 }],
  );
  add('join', 'union_3d', { handles: [ref('base'), ref('wall')] }, [
    { path: 'volume', expected: 134356, tolerance: 1e-6 },
  ]);
  const holes = [];
  for (const [i, [x, y]] of [
    [15, 15],
    [105, 15],
    [15, 65],
    [105, 65],
  ].entries()) {
    add('bh' + i, 'create_3d_cylinder', { origin: [x, y, -1], radius: 5, height: 10 });
    holes.push(ref('bh' + i));
  }
  for (const [i, x] of [35, 85].entries()) {
    add('wh' + i, 'create_3d_cylinder', { origin: [0, 0, 0], radius: 5, height: 10 });
    add('wr' + i, 'rotate_3d', {
      handles: [ref('wh' + i)],
      center: [0, 0, 0],
      axis: [1, 0, 0],
      angle: -90,
    });
    add('wm' + i, 'move_3d', { handles: [ref('wh' + i)], vector: [x, 71, 38] });
    holes.push(ref('wh' + i));
  }
  const volume = 134356 - 1200 * Math.PI;
  add('holes', 'subtract_3d', { handles: [ref('base'), ...holes] }, [
    { path: 'volume', expected: volume, tolerance: 1e-5 },
    { path: 'size', expected: [120, 80, 68] },
    { path: 'valid', expected: true },
  ]);
  add('inspection', 'inspect_3d_model', {}, [
    { path: 'solid_count', expected: 1 },
    { path: 'count', expected: 1 },
    { path: 'invalid_solids', expected: [] },
  ]);
  add('view', 'set_view', { view: 'isometric', target: [60, 40, 30], height: 130 });
  const plan = await call('create_modeling_plan', {
    request:
      '创建120×80×8机械安装支架，支撑板高60厚8，底板四个直径10安装孔、支撑板两个孔，并倒角；真实AutoCAD建模验证后交付DWG和STL。',
    assumptions,
    steps,
  });
  await fs.writeFile(path.join(folder, 'design-plan.json'), JSON.stringify(plan, null, 2));
  const execution = await call('execute_modeling_plan', { planId: plan.planId });
  assert.equal(execution.status, 'completed');
  const solid = execution.results.base.handles[0];
  // Independent native-kernel checks: a 9.98mm diameter probe must fit, a 10.02mm probe must intersect material.
  const holeProof = [];
  for (const [i, hole] of [
    ...[
      [15, 15],
      [105, 15],
      [15, 65],
      [105, 65],
    ].map(([x, y]) => ({ axis: 'z', origin: [x, y, 0], height: 8 })),
    ...[35, 85].map((x) => ({ axis: 'y', origin: [x, 72, 38], height: 8 })),
  ].entries()) {
    for (const radius of [4.99, 5.01]) {
      const probe = await call('create_3d_cylinder', {
        origin: hole.axis === 'z' ? hole.origin : [0, 0, 0],
        radius,
        height: hole.height,
      });
      const handle = probe.handles[0];
      if (hole.axis === 'y') {
        await call('rotate_3d', {
          handles: [handle],
          center: [0, 0, 0],
          axis: [1, 0, 0],
          angle: -90,
        });
        await call('move_3d', { handles: [handle], vector: hole.origin });
      }
      const check = await call('check_interference', { first: solid, second: handle });
      assert.equal(check.interferes, radius > 5);
      holeProof.push({ hole: i + 1, ...hole, radius, ...check });
      await call('delete_entities', { handles: [handle] });
    }
  }
  await fs.writeFile(
    path.join(folder, 'hole-verification.json'),
    JSON.stringify(holeProof, null, 2),
  );
  const inspected = await call('inspect_3d_model');
  assert.equal(inspected.count, 1);
  assert.equal(inspected.solid_count, 1);
  assert.ok(Math.abs(inspected.entities[0].volume - volume) < 1e-5);
  await call('execute_command', { command: '(setvar "VSCURRENT" "Conceptual")' });
  for (const view of ['isometric', 'top', 'front', 'side']) {
    await call('set_view', { view, target: [60, 40, 30], height: 140 });
    await call('screenshot', { path: path.join(folder, view + '.png') });
  }
  await call('set_view', { view: 'isometric', target: [60, 40, 30], height: 130 });
  await call('save_drawing', { path: path.join(folder, 'mechanical-bracket.dwg') });
  await call('export_stl', { path: path.join(folder, 'mechanical-bracket.stl'), handles: [solid] });
  await call('export_dxf', { path: path.join(folder, 'mechanical-bracket.dxf') });
  await call('save_drawing', {
    path: path.join(folder, 'mechanical-bracket.dwg'),
    overwrite: true,
  });
  await call('close_drawing');
  await call('open_drawing', { path: path.join(folder, 'mechanical-bracket.dwg') });
  const reopened = await call('inspect_3d_model');
  assert.equal(reopened.count, 1);
  assert.equal(reopened.solid_count, 1);
  assert.deepEqual(reopened.size, [120, 80, 68]);
  assert.ok(Math.abs(reopened.entities[0].volume - volume) < 1e-5);
  await fs.writeFile(
    path.join(folder, 'reopened-verification.json'),
    JSON.stringify(reopened, null, 2),
  );
  // A separate editable 2D dimension sheet retains a clean one-solid 3D drawing.
  await call('create_new_drawing');
  await call('draw_rectangle', { origin: [0, 0, 0], width: 120, height: 80 });
  for (const [x, y] of [
    [15, 15],
    [105, 15],
    [15, 65],
    [105, 65],
  ])
    await call('draw_circle', { center: [x, y, 0], radius: 5 });
  await call('draw_rectangle', { origin: [0, 110, 0], width: 120, height: 60 });
  for (const x of [35, 85]) await call('draw_circle', { center: [x, 140, 0], radius: 5 });
  for (const a of [
    { first: [0, 0, 0], second: [120, 0, 0], position: [60, -12, 0] },
    { first: [0, 0, 0], second: [0, 80, 0], position: [-15, 40, 0] },
    { first: [0, 110, 0], second: [0, 170, 0], position: [-15, 140, 0] },
  ])
    await call('add_aligned_dimension', a);
  await call('add_text', { position: [0, 185, 0], height: 5, text: 'MECHANICAL BRACKET - mm' });
  await call('add_mtext', {
    position: [140, 160, 0],
    height: 3,
    width: 95,
    text: 'Base: 120 x 80 x 8\\PWall: 120 x 60 x 8 above base\\PBase holes: 4 x DIA 10\\PEdge offsets: 15 (assumed)\\PWall holes: 2 x DIA 10\\PCentres X=35/85, Z=38\\PChamfer: 1 x 1, two outer edges\\PNative 3D solid supplied separately',
  });
  await call('set_view', { view: 'top', target: [100, 85, 0], height: 250 });
  await call('save_drawing', { path: path.join(folder, 'dimension-sheet.dwg') });
  await call('export_image', { path: path.join(folder, 'dimension-sheet.png') });
  await call('export_pdf', { path: path.join(folder, 'dimension-sheet.pdf') });
  await call('open_drawing', { path: path.join(folder, 'mechanical-bracket.dwg') });
  await call('set_view', { view: 'isometric', target: [60, 40, 30], height: 130 });
  await call('stop_recording');
  recording = false;
  await fs.writeFile(
    path.join(root, 'artifacts/final-delivery.json'),
    JSON.stringify(
      {
        folder,
        run,
        planId: plan.planId,
        solid,
        volume,
        bounds: [120, 80, 68],
        holes: 6,
        holeToleranceMm: 0.01,
        assumptions,
        recording: path.join(root, 'artifacts', '05-bracket-' + run + '.mp4'),
        verified: true,
      },
      null,
      2,
    ),
  );
  console.log('DELIVERY', folder);
} finally {
  if (recording)
    try {
      await call('stop_recording');
    } catch {}
  await client.close();
}
