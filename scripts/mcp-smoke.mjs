import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const client = new Client({ name: 'vintage-story-smoke', version: '0.1.0' });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/mcp/server.mjs', import.meta.url))],
    env: { ...process.env },
  }));
  const { tools } = await client.listTools();
  console.log('MCP tools:', tools.map(tool => tool.name).join(', '));
  const result = await client.callTool({ name: 'observe', arguments: {} });
  console.log(JSON.stringify(result, null, 2));
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
