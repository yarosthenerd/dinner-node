/**
 * The win32 branches, exercised on whatever platform the suite runs on.
 *
 * These are the two functions that were broken on Windows and produced no
 * error while being broken, so the tests assert the mechanism rather than the
 * result: which lookup command is spawned, and what shape of path comes back.
 */
import { describe, it, expect, vi } from 'vitest';
import { hasCommand, repoEnvPath } from '../platform.js';

/** A spawnSync stand-in that records its call and returns a fixed status. */
function fakeSpawn(status: number | null, error?: NodeJS.ErrnoException) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { status, error } as any;
  }) as any;
  return { fn, calls };
}

const onWin = process.platform === 'win32';

describe('hasCommand', () => {
  it('uses the platform lookup tool, never `command -v` on win32', () => {
    const { fn, calls } = fakeSpawn(0);
    hasCommand('ollama', fn);
    expect(calls).toHaveLength(1);
    if (onWin) {
      expect(calls[0].cmd).toBe('where');
      expect(calls[0].args).toEqual(['ollama']);
    } else {
      expect(calls[0].cmd).toBe('/bin/sh');
      expect(calls[0].args).toEqual(['-c', 'command -v "$1"', 'sh', 'ollama']);
    }
  });

  it('is true on status 0 and false on anything else', () => {
    expect(hasCommand('x', fakeSpawn(0).fn)).toBe(true);
    expect(hasCommand('x', fakeSpawn(1).fn)).toBe(false);
    expect(hasCommand('x', fakeSpawn(null).fn)).toBe(false);
  });

  it('claims nothing when the lookup tool itself is missing', () => {
    // `where` absent from a stripped Windows, or no shell. The old code could
    // not tell this apart from "the command is not installed", which is how it
    // reported every command on win32 as missing.
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    expect(hasCommand('ollama', fakeSpawn(null, err).fn)).toBe(false);
  });

  it('finds a command that really is on this machine', () => {
    // An end-to-end check against the real spawnSync, so the branch that runs
    // in production is the one under test at least once. node is running us.
    expect(hasCommand('node')).toBe(true);
    expect(hasCommand('dinnernode-no-such-binary-9f3a')).toBe(false);
  });
});

describe('repoEnvPath', () => {
  it('returns a native absolute path, not a URL pathname', () => {
    const p = repoEnvPath(import.meta.url);
    expect(p.endsWith('.env')).toBe(true);
    if (onWin) {
      // The bug: `new URL(...).pathname` gives `/C:/Users/x/.env`, which
      // existsSync reports as absent, so setup read no config and generated a
      // fresh wallet on every run.
      expect(p).not.toMatch(/^\//);
      expect(p).toMatch(/^[A-Za-z]:\\/);
    } else {
      expect(p.startsWith('/')).toBe(true);
    }
  });

  it('resolves to the repo root, one level above the module', () => {
    // Called with a URL inside src/__tests__, so two levels up rather than one.
    const p = repoEnvPath(import.meta.url);
    expect(p).toContain('src');
  });
});
