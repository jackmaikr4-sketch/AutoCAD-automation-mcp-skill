import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { contracts, validate, readOnly } from './contracts.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, 'artifacts/plans'), { recursive: true });
const worker = spawn(
  process.env.AICAD_PYTHON || 'python',
  ['-u', path.join(root, 'src/worker.py')],
  { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
);
let sequence = 0,
  queue = Promise.resolve(),
  cancelled = false,
  failed = false;
const pending = new Map();
worker.stderr.on('data', (d) => process.stderr.write(d));
readline.createInterface({ input: worker.stdout }).on('line', (line) => {
  try {
    const r = JSON.parse(line),
      p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    clearTimeout(p.timer);
    r.ok ? p.resolve(r.result) : p.reject(Error(r.error));
  } catch (e) {
    process.stderr.write(String(e) + '\n');
  }
});
let workerFailure = 'Worker unavailable';
function stopWorker(error) {
  failed = true;
  workerFailure = error.message;
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(error);
  }
  pending.clear();
}
worker.on('error', (error) =>
  stopWorker(Error(`Cannot start AutoCAD Python worker: ${error.message}`)),
);
worker.stdin.on('error', (error) =>
  stopWorker(Error(`AutoCAD worker input failed: ${error.message}`)),
);
worker.on('exit', () =>
  stopWorker(Error('AutoCAD worker exited; inspect application before retrying')),
);
function raw(op, args) {
  if (failed) throw Error(workerFailure);
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      failed = true;
      pending.delete(id);
      reject(Error('Operation timed out; execution state unknown. Do not automatically retry.'));
    }, 150000);
    pending.set(id, { resolve, reject, timer });
    worker.stdin.write(JSON.stringify({ id, op, args }) + '\n');
  });
}
const destructive =
  /^(delete_entities|repair_entity|union_3d|subtract_3d|intersect_3d|slice_3d|shell_3d|fillet_3d|chamfer_3d|trim_geometry|extend_geometry|fillet_geometry|chamfer_geometry|move_3d|rotate_3d|mirror_3d|rotate_geometry|mirror_geometry|scale_geometry|execute_command)$/;
async function call(op, args) {
  const checked = validate(op, args);
  const start = Date.now();
  try {
    const checkpoint = destructive.test(op) ? await raw('checkpoint', {}) : undefined;
    const result = await raw(op, checked);
    if (checkpoint && result && typeof result === 'object') result.checkpoint = checkpoint;
    if (result?.entities && /^inspect_|^get_drawing_bounds$/.test(op)) {
      const seen = new Map(),
        duplicates = [];
      for (const e of result.entities) {
        let key;
        if (e.type === 'Line') key = JSON.stringify([e.type, e.layer, [e.start, e.end].sort()]);
        if (e.type === 'Circle' && e.normal)
          key = JSON.stringify([e.type, e.layer, e.center, e.radius, e.normal]);
        if (e.type === 'Polyline' && e.bulges)
          key = JSON.stringify([e.type, e.layer, e.vertices, e.closed, e.bulges]);
        if (key) {
          if (seen.has(key))
            duplicates.push({
              original: seen.get(key),
              duplicate: e.handle,
              criteria: 'exact supported geometry on same layer',
            });
          else seen.set(key, e.handle);
        }
      }
      result.confirmed_duplicates = duplicates;
      const bounded = result.entities.filter((e) => e.min && e.max);
      if (bounded.length) {
        result.min = [0, 1, 2].map((i) => Math.min(...bounded.map((e) => e.min[i])));
        result.max = [0, 1, 2].map((i) => Math.max(...bounded.map((e) => e.max[i])));
        result.size = result.max.map((v, i) => v - result.min[i]);
      }
    }
    await log({ op, args: checked, result, ok: true, ms: Date.now() - start });
    return result;
  } catch (e) {
    await log({ op, args: checked, error: e.message, ok: false, ms: Date.now() - start });
    throw e;
  }
}
async function log(r) {
  await fs.appendFile(
    path.join(root, 'artifacts/audit.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...r }) + '\n',
  );
}
function serial(fn) {
  const r = queue.then(fn);
  queue = r.catch(() => {});
  return r;
}
async function content(result) {
  const out = [{ type: 'text', text: JSON.stringify(result) }];
  if (result?.mime === 'image/png')
    out.push({
      type: 'image',
      mimeType: 'image/png',
      data: (await fs.readFile(result.path)).toString('base64'),
    });
  return { content: out };
}
const server = new McpServer({ name: 'autocad-ai-mcp', version: '0.1.0' });
for (const [name, c] of Object.entries(contracts))
  server.registerTool(name, { description: c.description, inputSchema: c.schema }, async (a) => {
    try {
      return await content(await serial(() => call(name, a)));
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: e.message, verified: false }) }],
      };
    }
  });
server.registerTool(
  'cancel_task',
  {
    description:
      'Request cooperative cancellation between plan steps. Does not terminate AutoCAD or interrupt an atomic kernel operation.',
    inputSchema: {},
  },
  async () => {
    cancelled = true;
    return content({ cancel_requested: true, scope: 'between_steps' });
  },
);
const step = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  tool: z.string(),
  args: z.record(z.unknown()),
  checks: z
    .array(
      z.object({
        path: z.string(),
        expected: z.unknown(),
        tolerance: z.number().nonnegative().optional(),
      }),
    )
    .optional(),
});
function resolve(v, results) {
  if (typeof v === 'string' && v.startsWith('$')) {
    const parts = v.slice(1).split('.');
    let out = results;
    for (const p of parts) {
      if (out == null || !Object.hasOwn(out, p)) throw Error('Unresolved reference ' + v);
      out = out[p];
    }
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => resolve(x, results));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, results)]));
  return v;
}
server.registerTool(
  'create_modeling_plan',
  {
    description:
      'Persist a concrete AI-generated plan before any modeling. AI extracts dimensions and explicitly lists assumptions. References use $stepId.handles.0.',
    inputSchema: {
      request: z.string(),
      assumptions: z.array(z.string()),
      steps: z.array(step).min(1).max(300),
    },
  },
  async (a) => {
    try {
      const ids = new Set();
      for (const s of a.steps) {
        if (ids.has(s.id)) throw Error('Duplicate step ID');
        ids.add(s.id);
        if (!contracts[s.tool]) throw Error('Unknown tool ' + s.tool);
      }
      const planId = randomUUID();
      await fs.writeFile(
        path.join(root, 'artifacts/plans', planId + '.json'),
        JSON.stringify({ ...a, planId, status: 'prepared' }, null, 2),
      );
      return content({ planId, status: 'prepared', ...a });
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  },
);
server.registerTool(
  'execute_modeling_plan',
  {
    description:
      'Execute a saved plan once with per-step receipts, assertions and cooperative cancellation. Stops on error without blindly retrying writes.',
    inputSchema: { planId: z.string().uuid() },
  },
  async ({ planId }) =>
    serial(async () => {
      const file = path.join(root, 'artifacts/plans', planId + '.json');
      const plan = JSON.parse(await fs.readFile(file, 'utf8'));
      if (plan.status !== 'prepared')
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Plan already attempted. Read receipt; create a revised plan to continue.',
            },
          ],
        };
      cancelled = false;
      plan.status = 'running';
      plan.results = {};
      plan.events = [];
      await fs.writeFile(file, JSON.stringify(plan, null, 2));
      let activeStep = null,
        activeArgs = null;
      try {
        plan.checkpoint = await call('checkpoint', {});
        for (const s of plan.steps) {
          if (cancelled) {
            plan.status = 'cancelled';
            break;
          }
          activeStep = s;
          activeArgs = null;
          const args = resolve(s.args, plan.results);
          activeArgs = args;
          const result = await call(s.tool, args);
          plan.results[s.id] = result;
          for (const c of s.checks || []) {
            let actual = result;
            for (const part of c.path.split('.')) actual = actual?.[part];
            const ok =
              typeof c.expected === 'number'
                ? typeof actual === 'number' &&
                  Math.abs(actual - c.expected) <= (c.tolerance ?? 1e-7)
                : JSON.stringify(actual) === JSON.stringify(c.expected);
            if (!ok)
              throw Error(
                `Check failed ${s.id}.${c.path}: ${JSON.stringify(actual)} != ${JSON.stringify(c.expected)}`,
              );
          }
          plan.events.push({ id: s.id, tool: s.tool, args, status: 'passed', result });
          await fs.writeFile(file, JSON.stringify(plan, null, 2));
        }
        if (plan.status === 'running') plan.status = 'completed';
      } catch (e) {
        plan.status = 'failed';
        plan.error = e.message;
        if (activeStep)
          plan.events.push({
            id: activeStep.id,
            tool: activeStep.tool,
            args: activeArgs ?? activeStep.args,
            status: 'failed',
            result: plan.results[activeStep.id],
            error: e.message,
          });
      } finally {
        await fs.writeFile(file, JSON.stringify(plan, null, 2));
      }
      const r = await content({
        planId,
        status: plan.status,
        error: plan.error,
        receipt: file,
        results: plan.results,
        checkpoint: plan.checkpoint,
      });
      return { ...r, isError: plan.status === 'failed' };
    }),
);
server.registerTool(
  'get_modeling_plan',
  {
    description: 'Read persisted plan, step results, checks and failure/cancellation state.',
    inputSchema: { planId: z.string().uuid() },
  },
  async ({ planId }) =>
    content(
      JSON.parse(await fs.readFile(path.join(root, 'artifacts/plans', planId + '.json'), 'utf8')),
    ),
);
process.stdin.on('end', () => worker.stdin.end());
await server.connect(new StdioServerTransport());
