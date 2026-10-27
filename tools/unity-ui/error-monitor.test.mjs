import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExpectedErrors, armErrorMonitorCode } from './error-monitor.mjs';
test('expected errors require explicit matching text and a reason',()=>{
  assert.throws(()=>validateExpectedErrors([{contains:''}]),/explicit/);
  assert.throws(()=>validateExpectedErrors([{contains:'known error'}]),/explicit/);
  assert.deepEqual(validateExpectedErrors([]),[]);
  assert.deepEqual(validateExpectedErrors([{contains:'known error',reason:'human warned',phase:'open_settings'}]),
    [{contains:'known error',reason:'human warned',phase:'open_settings'}]);
});
test('a new test gets a fresh baseline and only its requested exceptions',()=>{
  const code=armErrorMonitorCode([{contains:'error "quoted"',reason:'human warned'}]);
  assert.ok(code.includes('watch["baseline_total"] = (long)watch["total"]'));
  assert.ok(code.includes('error \\"quoted\\"'));
  assert.ok(armErrorMonitorCode([]).includes('new object[] {}'));
});
