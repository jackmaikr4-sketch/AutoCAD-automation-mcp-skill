import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP discovery remains available and returns an actionable error if Python is missing', async () => {
  const client = new Client({ name: 'missing-python-regression', version: '1' });
  const root = path.resolve(import.meta.dirname, '..');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'src/server.mjs')],
    env: { ...process.env, AICAD_PYTHON: path.join(root, 'missing-python-for-test.exe') },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 93);
    const response = await client.callTool({ name: 'connect_autocad', arguments: {} });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /worker|Python/i);
    assert.equal((await client.listTools()).tools.length, 93);
  } finally {
    await client.close();
  }
});
