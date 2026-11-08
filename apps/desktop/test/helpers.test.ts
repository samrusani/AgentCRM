import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAppOrigin, isOpenableExternally, loopbackUrl, resolveDatabasePath, resolveWebDist } from '../src/helpers.js';

describe('resolveDatabasePath', () => {
  it('defaults to Application Support under the home folder', () => {
    expect(resolveDatabasePath({ env: {}, home: '/Users/x' })).toBe('/Users/x/Library/Application Support/AgentCRM/agentcrm.db');
  });
  it('lets AGENTCRM_DB win, resolved to an absolute path', () => {
    expect(resolveDatabasePath({ env: { AGENTCRM_DB: '/tmp/a.db' }, home: '/Users/x' })).toBe('/tmp/a.db');
    expect(resolveDatabasePath({ env: { AGENTCRM_DB: 'rel.db' }, home: '/Users/x' })).toBe(path.resolve('rel.db'));
    expect(resolveDatabasePath({ env: { AGENTCRM_DB: ':memory:' }, home: '/Users/x' })).toBe(':memory:');
  });
  it('ignores an empty override', () => {
    expect(resolveDatabasePath({ env: { AGENTCRM_DB: '' }, home: '/h' })).toBe('/h/Library/Application Support/AgentCRM/agentcrm.db');
  });
});

describe('resolveWebDist', () => {
  it('uses the sibling web build from source and the resources folder when packaged', () => {
    expect(resolveWebDist({ packaged: false, resourcesPath: '/r', appDirectory: '/repo/apps/desktop' })).toBe('/repo/apps/web/dist');
    expect(resolveWebDist({ packaged: true, resourcesPath: '/App/Contents/Resources', appDirectory: '/x' })).toBe('/App/Contents/Resources/web');
  });
});

describe('port and origin helpers', () => {
  it('builds the loopback url', () => {
    expect(loopbackUrl(5)).toBe('http://127.0.0.1:5');
  });
  it('accepts only the exact loopback origin', () => {
    expect(isAppOrigin('http://127.0.0.1:5000/leads', 5000)).toBe(true);
    expect(isAppOrigin('http://127.0.0.1:5001/', 5000)).toBe(false);
    expect(isAppOrigin('https://127.0.0.1:5000/', 5000)).toBe(false);
    expect(isAppOrigin('http://localhost:5000/', 5000)).toBe(false);
    expect(isAppOrigin('http://127.0.0.1.evil.com:5000/', 5000)).toBe(false);
    expect(isAppOrigin('nonsense', 5000)).toBe(false);
  });
  it('opens only web and mail links externally', () => {
    expect(isOpenableExternally('https://example.com')).toBe(true);
    expect(isOpenableExternally('mailto:a@b.co')).toBe(true);
    expect(isOpenableExternally('file:///etc/passwd')).toBe(false);
    expect(isOpenableExternally('javascript:alert(1)')).toBe(false);
  });
});
