import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiagnostic } from '../src/diagnostics.ts';

test('relative compiler error and fatal error become navigable diagnostics', () => {
  assert.deepEqual(parseDiagnostic('src/main.cpp:12:7: fatal error: missing header', '/workspace'), {
    path: '/workspace/src/main.cpp', line: 12, column: 7, severity: 'error', message: 'missing header',
  });
});
test('absolute paths, spaces, Windows drive letters and missing column', () => {
  assert.equal(parseDiagnostic('C:\\My Project\\main.cpp:2: warning: unused', '/workspace')?.path, 'C:\\My Project\\main.cpp');
  assert.equal(parseDiagnostic('/My Project/main.cpp:2: warning: unused', '/workspace')?.column, 1);
  assert.equal(parseDiagnostic('Writing at 0x0001000 (42 %)', '/workspace'), null);
});
