import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..'),
  run = Date.now().toString(),
  events = [];
const client = new Client({ name: 'autocad-real-acceptance', version: '1' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'src/server.mjs')],
    stderr: 'inherit',
  }),
);
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 160000 });
  const text = r.content.find((x) => x.type === 'text').text;
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { text };
  }
  events.push({ name, args, ok: !r.isError, result });
  console.log(name, r.isError ? 'FAIL ' + text : 'OK');
  await fs.writeFile(
    path.join(root, 'artifacts/tool-tests-' + run + '.json'),
    JSON.stringify(events, null, 2),
  );
  if (r.isError) throw Error(name + ': ' + text);
  return result;
}
const handle = (r) => r.handles[0];
async function test(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.log('TEST FAILED', label, e.message);
  }
}
const box = async (origin = [0, 0, 0]) =>
  handle(await call('create_3d_box', { origin, length: 20, width: 20, height: 20 }));
try {
  await call('connect_autocad');
  await call('start_recording', { path: path.join(root, 'artifacts', '04-tools-' + run + '.mp4') });
  await call('create_new_drawing');
  const manifest = await client.listTools();
  await fs.writeFile(
    path.join(root, 'artifacts/tool-manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  await test('2D', async () => {
    const line = handle(await call('draw_line', { start: [0, 0, 0], end: [20, 0, 0] }));
    const rect = handle(
      await call('draw_rectangle', { origin: [0, 10, 0], width: 20, height: 10 }),
    );
    await call('draw_polyline', {
      points: [
        [30, 0, 0],
        [40, 0, 0],
        [40, 10, 0],
      ],
      closed: true,
    });
    const circle = handle(await call('draw_circle', { center: [50, 0, 0], radius: 5 }));
    await call('draw_arc', { center: [60, 0, 0], radius: 5, start_angle: 0, end_angle: 180 });
    await call('draw_polygon', { center: [70, 0, 0], sides: 6, radius: 5 });
    await call('draw_ellipse', { center: [80, 0, 0], major_axis: [8, 0, 0], ratio: 0.5 });
    await call('draw_spline', {
      points: [
        [0, 40, 0],
        [10, 45, 0],
        [20, 40, 0],
        [30, 45, 0],
      ],
    });
    await call('draw_hatch', { handles: [rect] });
    await call('offset_geometry', { handle: circle, distance: 2 });
    await call('extend_geometry', { handle: line, point: [25, 0, 0] });
    await call('trim_geometry', { handle: line, parameters: [10], keep_segment: 0 });
    await call('mirror_geometry', {
      handles: [rect],
      start: [0, 0, 0],
      end: [0, 1, 0],
      copy: true,
    });
    await call('rotate_geometry', { handles: [rect], center: [0, 0, 0], angle: 15, copy: true });
    await call('scale_geometry', { handles: [circle], center: [50, 0, 0], factor: 2, copy: true });
    await call('array_geometry', { handles: [circle], rows: 2, columns: 2, dx: 15, dy: 15 });
  });
  for (const op of ['fillet_geometry', 'chamfer_geometry'])
    await test(op, async () => {
      const first = handle(await call('draw_line', { start: [100, 0, 0], end: [120, 0, 0] })),
        second = handle(await call('draw_line', { start: [100, 0, 0], end: [100, 20, 0] }));
      await call(op, {
        first,
        second,
        corner: [100, 0, 0],
        keep_first: [120, 0, 0],
        keep_second: [100, 20, 0],
        radius: 2,
        distance: 2,
      });
    });
  await test('annotations', async () => {
    for (const name of ['add_dimension', 'add_linear_dimension', 'add_aligned_dimension'])
      await call(name, { first: [0, 0, 0], second: [20, 0, 0], position: [10, -10, 0] });
    await call('add_radius_dimension', { center: [50, 0, 0], point: [55, 0, 0] });
    await call('add_diameter_dimension', { first: [45, 0, 0], second: [55, 0, 0] });
    await call('add_angular_dimension', {
      first_start: [0, 0, 0],
      first_end: [20, 0, 0],
      second_start: [0, 0, 0],
      second_end: [0, 20, 0],
      position: [10, 10, 0],
    });
    await call('add_text', { position: [0, -20, 0], text: 'AutoCAD MCP real API test', height: 3 });
    await call('add_mtext', {
      position: [0, -30, 0],
      text: 'Native geometry / millimetres',
      height: 3,
      width: 80,
    });
    await call('create_layer', { name: 'MCP_TEST', color: 3 });
    await call('set_layer', { name: 'MCP_TEST' });
    const h = handle(await call('draw_circle', { center: [0, 60, 0], radius: 5 }));
    await call('set_line_type', { handles: [h], name: 'Continuous' });
    await call('set_line_width', { handles: [h], hundredths_mm: 25 });
    await call('set_color', { handles: [h], color: 1 });
    await call('create_block', { handles: [h], name: 'TEST_BLOCK', origin: [0, 60, 0] });
    await call('insert_block', { name: 'TEST_BLOCK', position: [20, 60, 0] });
  });
  await call('set_view', { view: 'top', target: [40, 20, 0], height: 150 });
  await call('screenshot', { path: path.join(root, 'artifacts', '04-2d.png') });
  await call('save_drawing', { path: path.join(root, 'output', 'tool-tests-2d-' + run + '.dwg') });
  for (const name of [
    'get_entities',
    'get_entity_count',
    'get_drawing_bounds',
    'get_layer_information',
    'inspect_drawing',
    'checkpoint',
    'regenerate_drawing',
    'get_autocad_status',
    'get_active_document',
  ])
    await test(name, () => call(name));
  await call('create_new_drawing');
  let solid;
  for (const [op, args] of [
    ['create_3d_box', { origin: [0, 0, 0], length: 20, width: 10, height: 5 }],
    ['create_3d_cylinder', { origin: [30, 0, 0], radius: 5, height: 10 }],
    ['create_3d_sphere', { origin: [50, 0, 5], radius: 5 }],
    ['create_3d_cone', { origin: [70, 0, 0], radius: 5, height: 10 }],
    ['create_3d_wedge', { origin: [90, 0, 0], length: 10, width: 10, height: 10 }],
    ['create_3d_torus', { origin: [120, 0, 0], major_radius: 8, minor_radius: 2 }],
  ])
    await test(op, async () => {
      const r = await call(op, args);
      solid = handle(r);
      assert.ok(r.entities[0].volume > 0);
    });
  for (const op of ['union_3d', 'subtract_3d', 'intersect_3d'])
    await test(op, async () => {
      const a = await box([0, 40, 0]),
        b = await box([10, 40, 0]);
      const r = await call(op, { handles: [a, b] });
      assert.ok(
        Math.abs(r.volume - { union_3d: 12000, subtract_3d: 4000, intersect_3d: 4000 }[op]) < 1e-6,
      );
    });
  await test('extrude', async () => {
    let h = handle(await call('draw_rectangle', { origin: [0, 80, 0], width: 10, height: 10 }));
    await call('extrude_3d', { handle: h, height: 15 });
  });
  await test('revolve', async () => {
    let h = handle(await call('draw_rectangle', { origin: [30, 80, 0], width: 5, height: 10 }));
    await call('revolve_3d', { handle: h, axis_point: [20, 80, 0], axis: [0, 1, 0], angle: 360 });
  });
  await test('sweep', async () => {
    let h = handle(await call('draw_circle', { center: [60, 80, 0], radius: 2 }));
    let p = handle(await call('draw_line', { start: [60, 80, 0], end: [60, 80, 20] }));
    await call('sweep_3d', { handle: h, path_handle: p });
  });
  await test('loft', async () => {
    const a = handle(await call('draw_circle', { center: [90, 80, 0], radius: 5 })),
      b = handle(await call('draw_circle', { center: [90, 80, 15], radius: 3 }));
    await call('loft_3d', { handles: [a, b] });
  });
  await test('slice', async () => {
    const h = await box([0, 120, 0]);
    await call('slice_3d', { handle: h, point: [0, 120, 10], normal: [0, 0, 1], keep_both: true });
  });
  for (const op of ['fillet_3d', 'chamfer_3d', 'shell_3d'])
    await test(op, async () => {
      const h = await box([40, 120, 0]);
      const topology = await call('get_topology', { handle: h });
      if (op === 'shell_3d')
        await call(op, { handle: h, indices: [topology.faces[0].id], thickness: -1 });
      else if (op === 'fillet_3d')
        await call(op, { handle: h, indices: [topology.edges[0].id], radius: 1 });
      else {
        let success = false;
        for (const f of topology.faces) {
          try {
            await call(op, {
              handle: h,
              indices: [topology.edges[0].id],
              face_index: f.id,
              distance: 1,
            });
            success = true;
            break;
          } catch {}
        }
        assert.ok(success);
      }
    });
  await test('transforms', async () => {
    const h = await box([100, 120, 0]);
    solid = h;
    await call('move_3d', { handles: [h], vector: [5, 0, 0] });
    await call('rotate_3d', { handles: [h], center: [105, 120, 0], axis: [1, 0, 0], angle: 30 });
    await call('mirror_3d', { handles: [h], point: [130, 0, 0], normal: [1, 0, 0], copy: true });
  });
  for (const op of [
    'get_entity_properties',
    'get_entity_coordinates',
    'get_entity_dimensions',
    'get_3d_solid_information',
  ])
    await test(op, () => call(op, { handle: solid }));
  await call('inspect_3d_model');
  await call('set_view', { view: 'isometric', target: [65, 65, 0], height: 220 });
  await call('save_drawing', { path: path.join(root, 'output', 'tool-tests-3d-' + run + '.dwg') });
  await call('export_image', { path: path.join(root, 'artifacts', '04-3d.png') });
  await test('dxf', () =>
    call('export_dxf', { path: path.join(root, 'output', 'tool-tests-' + run + '.dxf') }));
  await test('pdf', () =>
    call('export_pdf', { path: path.join(root, 'output', 'tool-tests-' + run + '.pdf') }));
  await test('stl', () =>
    call('export_stl', {
      path: path.join(root, 'output', 'tool-tests-' + run + '.stl'),
      handles: [solid],
    }));
  await test('repair', () => call('repair_entity', { handle: solid, action: 'clean_solid' }));
  await call('stop_recording');
} finally {
  await client.close();
}
console.log(
  JSON.stringify(
    {
      run,
      passed: events.filter((e) => e.ok).length,
      failed: events.filter((e) => !e.ok).map((e) => ({ name: e.name, result: e.result })),
    },
    null,
    2,
  ),
);
if (events.some((e) => !e.ok)) process.exitCode = 1;
