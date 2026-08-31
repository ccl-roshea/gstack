/**
 * gstack-config explain_level round-trip + validation tests.
 *
 * Coverage:
 * - `set explain_level default` persists, `get` returns "default"
 * - `set explain_level terse` persists, `get` returns "terse"
 * - `set explain_level garbage` warns + writes "default"
 * - `get explain_level` with unset key returns empty (preamble bash defaults)
 * - Annotated config header documents explain_level
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_CONFIG = path.join(ROOT, 'bin', 'gstack-config');

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cfg-test-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  // gstack-config precedence is `${GSTACK_HOME:-${GSTACK_STATE_DIR:-$HOME/.gstack}}`,
  // so GSTACK_HOME from the developer's parent env wins over the test's
  // GSTACK_STATE_DIR. Override both to isolate from the real ~/.gstack.
  const res = spawnSync(BIN_CONFIG, args, {
    env: { ...process.env, GSTACK_STATE_DIR: tmpHome, GSTACK_HOME: tmpHome },
    encoding: 'utf-8',
    cwd: ROOT,
  });
  return {
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    status: res.status ?? -1,
  };
}

describe('gstack-config explain_level', () => {
  test('set + get default round-trip', () => {
    expect(run('set', 'explain_level', 'default').status).toBe(0);
    expect(run('get', 'explain_level').stdout).toBe('default');
  });

  test('set + get terse round-trip', () => {
    expect(run('set', 'explain_level', 'terse').status).toBe(0);
    expect(run('get', 'explain_level').stdout).toBe('terse');
  });

  test('unknown value warns and defaults to default', () => {
    const result = run('set', 'explain_level', 'garbage');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('not recognized');
    expect(result.stderr).toContain('default, terse');
    expect(run('get', 'explain_level').stdout).toBe('default');
  });

  test('get with unset explain_level returns the documented default', () => {
    // gstack-config returns the documented default ("default") when the
    // key is absent from config.yaml — see bin/gstack-config:103. Earlier
    // versions of this test expected "" (preamble shell substitution),
    // but the script ships defaults inline so callers always get a
    // usable value without bash fallback gymnastics.
    expect(run('get', 'explain_level').stdout).toBe('default');
  });

  test('config header documents explain_level', () => {
    // Trigger file creation with any set
    run('set', 'explain_level', 'default');
    const cfg = fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8');
    expect(cfg).toContain('explain_level');
    expect(cfg).toContain('default');
    expect(cfg).toContain('terse');
  });

  test('set terse, then set garbage restores default', () => {
    run('set', 'explain_level', 'terse');
    expect(run('get', 'explain_level').stdout).toBe('terse');
    const garbage = run('set', 'explain_level', 'nonsense');
    expect(garbage.stderr).toContain('not recognized');
    expect(run('get', 'explain_level').stdout).toBe('default');
  });
});

describe('gstack-config values with spaces', () => {
  test('workspace_root preserves internal spaces on set/get/list', () => {
    const value = path.join(os.tmpdir(), 'Conductor Workspaces');
    expect(run('set', 'workspace_root', value).status).toBe(0);

    expect(run('get', 'workspace_root').stdout).toBe(value);

    const listed = run('list');
    expect(listed.status).toBe(0);
    expect(
      listed.stdout
        .split('\n')
        .some((line) => line.includes('workspace_root:') && line.includes(value) && line.includes('(set)')),
    ).toBe(true);
  });
});

describe('gen-skill-docs honors explain_level for user-local installs', () => {
  // The config key round-trips (above) and the preamble echoes it at runtime,
  // but the generator only ever read --explain-level from argv — so a user who
  // set `explain_level: terse` still got the verbose Writing Style block baked
  // into every tier-2+ SKILL.md. Gated on --respect-detection so committed
  // artifacts and CI stay on 'default'.
  const MARKER = 'Gloss curated jargon'; // present only in the default render

  function generate(args: string[], home: string): number {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gen-out-'));
    const res = spawnSync('bun', ['run', 'scripts/gen-skill-docs.ts', '--host', 'claude', '--out-dir', outDir, ...args], {
      env: { ...process.env, GSTACK_HOME: home, GSTACK_STATE_DIR: home },
      encoding: 'utf-8',
      cwd: ROOT,
    });
    if (res.status !== 0) throw new Error(`gen-skill-docs failed: ${res.stderr}`);
    const hits = fs
      .readdirSync(outDir, { recursive: true })
      .filter((f) => String(f).endsWith('SKILL.md'))
      .filter((f) => fs.readFileSync(path.join(outDir, String(f)), 'utf-8').includes(MARKER)).length;
    fs.rmSync(outDir, { recursive: true, force: true });
    return hits;
  }

  test('terse config + --respect-detection strips the verbose block', () => {
    fs.writeFileSync(path.join(tmpHome, 'config.yaml'), 'explain_level: terse\n');
    expect(generate(['--respect-detection'], tmpHome)).toBe(0);
  });

  test('terse config WITHOUT the flag still renders default (committed artifacts + CI stay stable)', () => {
    fs.writeFileSync(path.join(tmpHome, 'config.yaml'), 'explain_level: terse\n');
    expect(generate([], tmpHome)).toBeGreaterThan(0);
  });

  test('default config + --respect-detection renders default', () => {
    fs.writeFileSync(path.join(tmpHome, 'config.yaml'), 'explain_level: default\n');
    expect(generate(['--respect-detection'], tmpHome)).toBeGreaterThan(0);
  });

  test('explicit --explain-level still wins over config', () => {
    fs.writeFileSync(path.join(tmpHome, 'config.yaml'), 'explain_level: default\n');
    expect(generate(['--respect-detection', '--explain-level', 'terse'], tmpHome)).toBe(0);
  });
});
