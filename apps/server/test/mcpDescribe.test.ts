import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createPerson, createPipeline } from '../src/actions/index.js';
import { packageRoot } from '../src/paths.js';
import { getPersonDetail } from '../src/queries/people.js';
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


it('applies a versioned MCP record edit and custom attribute immediately without an approval', async () => {
  const person = createPerson(env.ctx, { firstName: 'Ada', lastName: 'Quill' });
  const client = new Client({ name: 'edit-authority-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(packageRoot, 'src', 'cli.ts'), 'mcp'],
    cwd: packageRoot,
    env: { ...(process.env as Record<string, string>), AGENTCRM_DB: env.databasePath },
    stderr: 'ignore',
  });
  await client.connect(transport);
  try {
    const changes = [{
      entityType: 'person', id: person.id, expectedVersion: person.version,
      fields: { title: 'Partner', 'attr:fit-notes': 'Reviews seed companies.' },
    }];
    const proposal = await client.callTool({ name: 'crm_propose_changes', arguments: { changes } });
    expect(proposal.isError).toBeFalsy();
    const preview = (proposal.content as { type: string; text: string }[])[0]!.text;
    expect(getPersonDetail(env.db, env.workspaceId, person.id).version).toBe(person.version);

    const args = { changes, proposalHash: (JSON.parse(preview) as { proposalHash: string }).proposalHash };
    const applied = await client.callTool({ name: 'crm_apply_changes', arguments: args });
    expect(applied.isError).toBeFalsy();
    expect(getPersonDetail(env.db, env.workspaceId, person.id)).toMatchObject({
      title: 'Partner', version: person.version + 1,
      attributes: expect.arrayContaining([expect.objectContaining({ key: 'fit-notes', value: 'Reviews seed companies.' })]),
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM approval WHERE workspace_id = ?').get(env.workspaceId)).toEqual({ n: 0 });

    const stale = await client.callTool({ name: 'crm_apply_changes', arguments: args });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain('version_conflict');
  } finally {
    await client.close();
  }
});
