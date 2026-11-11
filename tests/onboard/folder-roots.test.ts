// Place project with several browse roots (RLT_FS_ROOTS=a,b): the top of one root offers the others, because there is
// no "Up one level" there and the second root could not be reached otherwise.
import { describe, expect, test } from 'bun:test';
import { otherRoots } from '../../web/src/ui/folder-browser';

describe('otherRoots', () => {
  test('at the top of one root: the other roots', () => {
    expect(otherRoots('/srv/files', true, ['/srv/files', '/srv/ws'])).toEqual(['/srv/ws']);
    expect(otherRoots('/srv/ws', true, ['/srv/files/', '/srv/ws', '/home/me'])).toEqual(['/srv/files', '/home/me']);
  });
  test('nothing inside a root, with one root, or before the first listing', () => {
    expect(otherRoots('/srv/files/app', false, ['/srv/files', '/srv/ws'])).toEqual([]);
    expect(otherRoots('/home/me', true, ['/home/me'])).toEqual([]);
    expect(otherRoots(null, true, ['/a', '/b'])).toEqual([]);
    expect(otherRoots('/a', true, undefined)).toEqual([]);
  });
  test('a root listed twice is offered once', () => {
    expect(otherRoots('/a', true, ['/a', '/b', '/b/'])).toEqual(['/b']);
  });
});
