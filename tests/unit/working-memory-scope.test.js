/**
 * BrainX V5 — CROSS_PROJECT_FIX_20260608 working-memory project scoping.
 * Run with: node --test tests/unit/working-memory-scope.test.js
 *
 * Regression for the reasoning-agent Tower -> UniLife silent drift: the writer
 * only recognized /projects/<name>/ paths, so repos under /home/clawd/<repo> or
 * workspace-<agent>/<repo> collapsed into the shared `_none` bucket and bled
 * facts across unrelated projects.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

const { projectKeyFromPath, resolveProjectKey, resolveProjectKeyFromText } = require('../../lib/working-memory');

describe('working-memory project scoping', () => {
  describe('projectKeyFromPath', () => {
    it('scopes repos under agent-specific workspaces', () => {
      assert.strictEqual(
        projectKeyFromPath('/home/clawd/.openclaw/workspace-writer/UnilifeAppMDX/lib/configuration.dart'),
        'unilifeappmdx',
      );
    });
    it('scopes repos directly under the home dir', () => {
      assert.strictEqual(projectKeyFromPath('/home/clawd/TowerGarageMDX/src/x.ts'), 'towergaragemdx');
    });
    it('scopes /projects/<name>/ paths (legacy behavior preserved)', () => {
      assert.strictEqual(
        projectKeyFromPath('/home/clawd/projects/svelte-kite-closer-academy/src/a.ts'),
        'svelte-kite-closer-academy',
      );
    });
    it('scopes the bare workspace container one level down', () => {
      assert.strictEqual(projectKeyFromPath('/home/clawd/.openclaw/workspace/mdx-space/api/foo.ts'), 'mdx-space');
    });
    it('NEVER returns the home owner as a project (clawd catch-all bug)', () => {
      assert.strictEqual(projectKeyFromPath('/home/clawd'), '_none');
      assert.strictEqual(projectKeyFromPath('/home/clawd/somefile.txt'), '_none');
      assert.strictEqual(projectKeyFromPath('/tmp'), '_none');
    });
    it('does not treat workspace-internal dirs as projects', () => {
      assert.strictEqual(projectKeyFromPath('/home/clawd/.openclaw/workspace-reasoning/memory/2026-06-08.md'), '_none');
    });
    it('returns _none for a bare file under a generic dir', () => {
      assert.strictEqual(projectKeyFromPath('/tmp/tower-fea-shop-smoke.log'), '_none');
    });
    it('scopes a worktree/repo-root directory cwd to its own bucket (never mixed)', () => {
      // Distinct from towergaragemdx (skill has no git) but crucially isolated.
      assert.strictEqual(projectKeyFromPath('/tmp/tower-fea-shop-build-20260608'), 'tower-fea-shop-build-20260608');
    });
  });

  describe('resolveProjectKey (tool params)', () => {
    it('derives the project from a file path param', () => {
      assert.strictEqual(
        resolveProjectKey({ filePath: '/home/clawd/TowerGarageMDX/front/shop.ts' }),
        'towergaragemdx',
      );
    });
    it('derives the project from a cwd param', () => {
      assert.strictEqual(
        resolveProjectKey({ cwd: '/home/clawd/.openclaw/workspace-writer/UnilifeAppMDX' }),
        'unilifeappmdx',
      );
    });
    it('returns _none for command-only params (no path)', () => {
      assert.strictEqual(resolveProjectKey({ command: 'git status' }), '_none');
    });
  });

  describe('resolveProjectKeyFromText', () => {
    it('returns _none for a contextless continuation prompt', () => {
      assert.strictEqual(resolveProjectKeyFromText('procede pero no seria mejor que cosas asi vengan de un env?'), '_none');
    });
    it('derives the project from a repo path mentioned in the prompt', () => {
      assert.strictEqual(resolveProjectKeyFromText('revisa /home/clawd/TowerGarageMDX/front'), 'towergaragemdx');
    });
  });
});
