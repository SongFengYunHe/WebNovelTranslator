import { describe, expect, it } from 'vitest';
import { compareVersions, isNewerVersion } from '../version';

describe('compareVersions', () => {
  it('orders plain semantic versions', () => {
    expect(compareVersions('3.0.1', '3.0.0')).toBeGreaterThan(0);
    expect(compareVersions('3.0.0', '3.0.1')).toBeLessThan(0);
    expect(compareVersions('3.0.1', '3.0.1')).toBe(0);
  });

  it('compares numerically, not lexicographically', () => {
    expect(compareVersions('3.10.0', '3.9.0')).toBeGreaterThan(0);
    expect(compareVersions('3.0.10', '3.0.9')).toBeGreaterThan(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('2', '1.9.9')).toBeGreaterThan(0);
  });

  it('treats non-numeric segments as zero', () => {
    expect(compareVersions('3.0.0-beta', '3.0.0')).toBe(0);
  });
});

describe('isNewerVersion', () => {
  it('is true only for a strictly newer candidate', () => {
    expect(isNewerVersion('3.0.2', '3.0.1')).toBe(true);
    expect(isNewerVersion('3.0.1', '3.0.1')).toBe(false);
    expect(isNewerVersion('2.9.9', '3.0.1')).toBe(false);
  });
});