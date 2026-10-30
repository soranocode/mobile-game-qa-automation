// Shared async actions over the learned inventory motor. No connection or input on import.
const BACKPACK = 'CanvasController/PlayerScreen/SafeArea/UIHudInterfaceButtonsPanel/UIHudInterfaceBackpack';
const CLOSE = 'CanvasInterface/Backpack/SafeArea/RootNavigationWidget/CloseButton';
const CONTINUE = 'CanvasController/DialogWindow/Content/Buttons/DialogChoiceButton(Clone)';
const DIALOG = 'CanvasController/DialogWindow/';
const USE = 'CanvasInterface/Backpack/Container/Main/InventoryExtendable/ActionWithItemsButtons/UseButton';

// Read-only HUD readiness check during the actual mission.
// It confirms actual HUD hit readiness after a close fade; it never clicks the HUD.
export const HUD_READY_CODE = `
var ew=System.AppDomain.CurrentDomain.GetData("QaAgent.ErrorWatch.v1") as System.Collections.Generic.Dictionary<string,object>;
if(ew==null)return new{status="error_watch_missing"};
lock(ew["gate"]){if(!(bool)ew["armed"]||(long)ew["unexpected"]>(long)ew["baseline_unexpected"])return new{status="blocked_new_error"};}
if(!UnityEditor.SessionState.GetBool("QaAgent.FastUi.active",false))return new{status="not_active"};
var test=UnityEngine.GameObject.Find("TestGUI(Clone)");
if(test!=null){var tc=test.GetComponents<UnityEngine.MonoBehaviour>().FirstOrDefault(x=>x!=null&&x.GetType().Name=="TestGUI");if(tc!=null){var f=tc.GetType().GetField("_isTest",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic);if(f!=null&&(bool)f.GetValue(tc))return new{status="unexpected_testgui"};}}
var go=UnityEngine.GameObject.Find("${BACKPACK}");
if(go==null||!go.activeInHierarchy)return new{status="hud_missing"};
var es=UnityEngine.EventSystems.EventSystem.current;var rt=go.GetComponent<UnityEngine.RectTransform>();var c=go.GetComponentInParent<UnityEngine.Canvas>();
if(es==null||rt==null||c==null)return new{status="hud_geometry_missing"};
var pt=UnityEngine.RectTransformUtility.WorldToScreenPoint(c.renderMode==UnityEngine.RenderMode.ScreenSpaceOverlay?null:c.worldCamera,rt.TransformPoint(rt.rect.center));
var d=new UnityEngine.EventSystems.PointerEventData(es){position=pt};var hits=new System.Collections.Generic.List<UnityEngine.EventSystems.RaycastResult>();es.RaycastAll(d,hits);
bool ready=hits.Count>0&&hits[0].gameObject!=null&&hits[0].gameObject.transform.IsChildOf(go.transform);
return new{status=ready?"ready":"covered",frame=UnityEngine.Time.frameCount};`;

const shown = (s, path) => s.controls.find(c => c.path === path);
const hasDialog = s => s.controls.some(c => c.path.startsWith(DIALOG));
const dialogIdentity = s => JSON.stringify(s.texts.filter(t => t.path.startsWith(DIALOG)).map(t => [t.path, t.text]));
const validCells = s => s.cells.filter(c => c.storage);
const itemTotal = (s, uid) => validCells(s).filter(c => c.uid === uid).reduce((n, c) => n + c.q, 0);
const totals = s => Object.fromEntries(Object.entries(validCells(s).filter(c => c.uid).reduce((out, c) => {
  const key = JSON.stringify([c.uid, c.dur]);
  out[key] = (out[key] ?? 0) + c.q;
  return out;
}, {})).sort());
const at = (s, cell) => validCells(s).find(c => c.storage === cell.storage && c.index === cell.index);

export function createInventoryActions({motor, guardCode, check = () => {}}) {
  if (!motor?.click || !motor?.snapshot || !motor?.invoke || typeof guardCode !== 'string' || typeof check !== 'function') {
    throw Error('Existing inventory motor, guardCode and check function required');
  }
  let sequence = 0;
  const pause = async ms => { check(); await new Promise(resolve => setTimeout(resolve, ms)); check(); };
  const snapshot = async name => {
    check();
    const s = await motor.snapshot(name);
    check();
    if (!Array.isArray(s?.cells) || !Array.isArray(s.controls) || !Array.isArray(s.texts)) throw Error('Unknown inventory snapshot');
    if (s.error_watch?.blocked) throw Error('New Unity error');
    return s;
  };
  const input = async target => {
    check();
    const result = await motor.click(target);
    check();
    if (!['sent', 'target_changed'].includes(result?.status)) throw Error('Unknown input outcome: ' + result?.status);
    return result;
  };
  const assertNoOtherModal = s => {
    if (s.controls.some(c => /^CanvasController\/(UIPopup|SplitItemView|InfoPanel)/.test(c.path))) {
      throw Error('Unexpected modal in inventory action');
    }
  };
  const until = async (read, accept, label, budgetMs = 1600) => {
    const deadline = performance.now() + budgetMs;
    for (;;) {
      check();
      const value = await read();
      check();
      if (accept(value)) return value;
      if (performance.now() >= deadline) throw Error(label + ' readiness budget exceeded');
      await pause(40);
    }
  };
  const hudReady = async () => {
    await until(async () => {
      check();
      const result = await motor.invoke('inventory_actions_hud_ready', HUD_READY_CODE);
      check();
      if (!['ready', 'covered', 'hud_missing'].includes(result?.status)) throw Error('Unexpected HUD state: ' + result?.status);
      return result;
    }, r => r.status === 'ready', 'HUD');
  };

  async function dismissKnownDialog() {
    let s = await snapshot();
    for (let n = 0; n < 4; n++) {
      assertNoOtherModal(s);
      if (!hasDialog(s)) {
        if (shown(s, CLOSE) || !shown(s, BACKPACK)) throw Error('Expected Game/HUD after dialog');
        await hudReady();
        return {closed: true};
      }
      const button = shown(s, CONTINUE);
      if (!button || button.blocked) throw Error('Unknown dialog without known Continue');
      const oldIdentity = dialogIdentity(s);
      await input(button.id);
      // Read only until a line transition or actual close; do not click a fading old line again.
      s = await until(() => snapshot(), next => !hasDialog(next) || dialogIdentity(next) !== oldIdentity, 'Dialog transition');
    }
    if (hasDialog(s)) throw Error('Known Continue budget exceeded');
    if (shown(s, CLOSE) || !shown(s, BACKPACK)) throw Error('Expected Game/HUD after dialog');
    await hudReady();
    return {closed: true};
  }

  async function consumeOne({uid}) {
    // This current quest composition admits the proved Canned consumable only.
    if (uid !== 'Canned') throw Error('Unsupported consumable for this prepared action');
    const prefix = 'consume-' + uid + '-' + (++sequence);
    let useAttempted = false;
    try {
      let s = await snapshot();
      assertNoOtherModal(s);
      if (hasDialog(s)) throw Error('Dismiss known dialog before consuming');
      if (!shown(s, CLOSE)) {
        const button = shown(s, BACKPACK);
        if (!button || button.blocked) throw Error('Expected HUD Backpack entry');
        await hudReady();
        await input(button.id);
        s = await until(() => snapshot(), next => Boolean(shown(next, CLOSE)) && validCells(next).length > 0, 'Backpack open');
      }
      const before = await snapshot(prefix + '-before');
      assertNoOtherModal(before);
      const cell = validCells(before).find(c => c.uid === uid && c.q > 0);
      if (!cell) throw Error('Current Canned cell unavailable');
      await input(cell.id);
      const selected = await snapshot(prefix + '-selected');
      const selection = validCells(selected).filter(c => c.selected);
      if (selection.length !== 1 || selection[0].uid !== uid || selection[0].storage !== cell.storage ||
          selection[0].index !== cell.index || selection[0].q !== cell.q) throw Error('Fresh selected UID/count mismatch');
      check();
      const guard = await motor.invoke('consume_guard', guardCode);
      check();
      if (guard?.status !== 'ready' || guard.useInLongUnlock !== false) throw Error('Use guard not ready or LongUnlock active');
      const use = shown(selected, USE);
      if (!use || use.blocked) throw Error('Current Use button unavailable');
      const expected = totals(before);
      expected[JSON.stringify([uid, cell.dur])]--;
      if (expected[JSON.stringify([uid, cell.dur])] === 0) delete expected[JSON.stringify([uid, cell.dur])];
      useAttempted = true;
      await input(use.id); // Exactly one dispatch. A delayed count/Done never causes a second Use.
      const after = await until(async () => {
        const next = await snapshot();
        if (!shown(next, CLOSE) || hasDialog(next)) throw Error('Unexpected UI after Use');
        assertNoOtherModal(next);
        const row = at(next, cell);
        if (!row || ![cell.q, cell.q - 1].includes(row.q)) throw Error('Unexpected selected-stack delta');
        if (row.uid && row.uid !== uid) throw Error('Unexpected selected-stack item');
        return next;
      }, next => {
        const row = at(next, cell);
        if (row.q === cell.q) return false;
        if (itemTotal(next, uid) !== itemTotal(before, uid) - 1 || JSON.stringify(totals(next)) !== JSON.stringify(expected)) {
          throw Error('Unexpected item/count/durability delta');
        }
        return true;
      }, 'One Use count');
      // Separate actual before/after evidence; no model setters or item grants.
      const savedAfter = await snapshot(prefix + '-after');
      if (JSON.stringify(totals(savedAfter)) !== JSON.stringify(totals(after))) throw Error('Inventory changed after consumption');
      await input(shown(savedAfter, CLOSE).id);
      const closed = await until(() => snapshot(), next => !shown(next, CLOSE) && Boolean(shown(next, BACKPACK)), 'Backpack close');
      assertNoOtherModal(closed);
      if (hasDialog(closed)) throw Error('Unexpected dialog after Backpack close');
      await hudReady();
      await snapshot(prefix + '-closed');
      return {uid, quantity_before: cell.q, quantity_after: cell.q - 1, uses_sent: 1, closed: true};
    } catch (error) {
      const failure = error instanceof Error ? error : Error(String(error));
      failure.inventory_action = {uid, use_attempted: useAttempted, evidence_prefix: prefix, replay_allowed: false};
      throw failure; // Caller owns observer/session cleanup; no recovery input is sent here.
    }
  }
  return {dismissKnownDialog, consumeOne, setCheck(fn) {
    if (typeof fn !== 'function') throw Error('Check function required');
    check = fn;
  }};
}
