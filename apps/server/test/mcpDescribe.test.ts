import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createPipeline } from '../src/actions/index.js';
import { packageRoot } from '../src/paths.js';
import { getTemplate } from '../src/templates.js';
import path from 'node:path';
import { createTestEnvironment } from './helpers.js';

const env = createTestEnvironment();

afterAll(() => {
  env.cleanup();
});

describe('crm_describe', () => {
  it('lists the pipelines with names, templates, and ordered stage names, and no single workspace template', async () => {
    createPipeline(env.ctx, { name: 'UK investor pipeline', template: 'fund-lp' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), 'mcp'],
      cwd: packageRoot,
      env: { ...(process.env as Record<string, string>), AGENTCRM_DB: env.databasePath },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'describe-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'crm_describe', arguments: {} });
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      const described = JSON.parse(text);
      // Contract change: the workspace no longer reports a template; each pipeline does.
      expect(described.workspace).toEqual({ id: env.workspaceId, name: 'Demo workspace' });
      expect(described.pipelines).toHaveLength(2);
      expect(described.pipelines[0]).toMatchObject({ name: 'Fundraising', template: 'startup-fundraising' });
      expect(described.pipelines[0].stageNames).toEqual([...getTemplate('startup-fundraising')!.stageNames]);
      expect(described.pipelines[1]).toMatchObject({ name: 'UK investor pipeline', template: 'fund-lp' });
      expect(described.pipelines[1].stageNames).toEqual([...getTemplate('fund-lp')!.stageNames]);
      expect(described).toHaveProperty('counts');
      expect(described).toHaveProperty('modelProvider');
    } finally {
      await client.close();
    }
  }, 30_000);
});
