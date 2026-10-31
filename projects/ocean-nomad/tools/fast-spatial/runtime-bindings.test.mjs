import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHookBindings } from './runtime-bindings.mjs';

const questSource = await readFile(new URL('./quest-click-frame.cs.txt', import.meta.url), 'utf8');
const selectedUiSource = await readFile(new URL('./selected-control.cs.txt', import.meta.url), 'utf8');
const observerSource = await readFile(new URL('./hook-observer.cs.txt', import.meta.url), 'utf8');

async function harness(t, { observerStatus = 'prepared' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hook-bindings-'));
  t.after(async () => {
    const target = resolve(dir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('hook-bindings-')) {
      throw new Error('Refusing cleanup outside the dedicated temporary test directory');
    }
    await rm(target, { recursive: true, force: true });
  });
  const questParameterFile = join(dir, 'quest.params');
  const calls = [];
  const session = {
    active: true,
    instrument: code => {
      assert.ok(code.includes('__ERROR_WATCH_SETUP__'), 'the exact source retains its watcher marker');
      return code.replace('__ERROR_WATCH_SETUP__', '// passive watcher stub');
    },
    batch: async (commands, options) => {
      assert.notEqual(options?.checkErrors, false, 'default session error checking stays enabled');
      const values = [];
      for (const { params: { code } } of commands) {
        calls.push(code);
        if (code.includes('const string key = "QaAgent.HookObserver.v1";')) {
          assert.ok(code.includes('var mode = "prepare";') || code.includes('var mode = "read";') || code.includes('var mode = "stop";'));
          assert.ok(!code.includes('__MODE__'));
          values.push({ status: observerStatus });
        } else if (code.includes('var role=lines[0];')) {
          const text = await readFile(questParameterFile, 'utf8');
          assert.ok(text.includes('\n'), 'parameters contain real LF, not literal backslash-n');
          assert.ok(!text.includes('\\n'));
          const [role] = text.split('\n');
          values.push(role === 'observe' ? { status: 'idle', open: false, panel: 'None' } : { status: 'click_queued' });
        } else if (code.includes('var role="observe";')) values.push({ status: 'sent', open: true, panel: 'Quests' });
        else if (code.includes('const string role = "selected_ui";')) values.push({ status: 'compiled_only', input_sent: false });
        else if (code.includes('return old;')) values.push(false);
        else if (code.includes('return UnityEditor.SessionState.GetString("QaAgent.QuestUi.status"')) values.push('sent');
        else if (code.includes('return UnityEditor.SessionState.GetString("QaAgent.QuestUi.frames"')) values.push('10,11,12');
        else values.push({ input_sent: false });
      }
      return values;
    },
  };
  const bindings = createHookBindings({ session, questSource, selectedUiSource, observerSource, questParameterFile });
  return { bindings, calls, session, questParameterFile };
}

test('creating hook bindings sends no Unity command and does not write runtime parameters', async t => {
  const { bindings, questParameterFile, calls } = await harness(t);
  assert.equal(typeof bindings.questUi,'function');
  assert.equal(Object.hasOwn(bindings,'prepare'),false);
  assert.deepEqual(calls,[]);
  await assert.rejects(readFile(questParameterFile),{code:'ENOENT'});
});

test('read-only quest observation cannot repeat the input role', async t => {
  const { bindings, calls, questParameterFile } = await harness(t);
  const { state } = await bindings.observeQuestUi('observe');
  assert.equal(state.panel, 'Quests');
  assert.equal(await readFile(questParameterFile, 'utf8'), 'observe\n');
  assert.ok(calls[0].includes('var role="observe";'));
  assert.ok(!calls[0].includes('var role=lines[0];'));
});

test('quest parameters separate role/target and wait for terminal frame status', async t => {
  const { bindings, calls, questParameterFile } = await harness(t);
  const result = await bindings.questUi('quest', 'hook_use');
  assert.equal(await readFile(questParameterFile, 'utf8'), 'quest\nhook_use');
  assert.equal(result.frames, '10,11,12');
  assert.ok(calls.some(code => code.includes('return UnityEditor.SessionState.GetString("QaAgent.QuestUi.status"')));
});

test('actual observer setup preserves an unresolved source outcome', async t => {
  const { bindings } = await harness(t, { observerStatus: 'quest_source_unknown' });
  assert.equal((await bindings.observe('prepare')).status,'quest_source_unknown');
});

test('inactive session cannot send UI input or overwrite the parameter file', async t => {
  const { bindings, session, calls, questParameterFile } = await harness(t);
  session.active = false;
  await assert.rejects(bindings.questUi('quest', 'hook_use'), /Begin the single MCP session first/);
  await assert.rejects(bindings.click('Canvas/Button'), /Begin the single MCP session first/);
  assert.deepEqual(calls, []);
  await assert.rejects(readFile(questParameterFile), { code: 'ENOENT' });
});

test('default session error rejection propagates before any retry', async t => {
  const { bindings, session } = await harness(t);
  let calls = 0;
  session.batch = async () => { calls++; throw Object.assign(new Error('new Unity error'), { code: 'UNITY_NEW_ERROR' }); };
  await assert.rejects(bindings.click('Canvas/Button'), { code: 'UNITY_NEW_ERROR' });
  assert.equal(calls, 1);
});
