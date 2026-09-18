import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { adaptComposerSource } from '../lib/vscode-adapter.mjs';

function harness(info, initial = false) {
  const slots = [], effects = [], listeners = new Map();
  let cursor = 0, enabled = initial, fail = false, clears = 0, writes = 0;
  const context = vm.createContext({ window: {
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
    setInterval: fn => { listeners.set('poll', fn); return 1; }, clearInterval: () => listeners.delete('poll'),
  } });
  vm.runInContext(fs.readFileSync(new URL('../src/inject/composer-ui.js', import.meta.url), 'utf8'), context);
  const React = {
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], value => { slots[index] = value; }]; },
    useRef(value) { const index = cursor++; return slots[index] ||= { current: value }; },
    useEffect(effect) { const index = cursor++; if (!slots[index]) { slots[index] = true; effects.push(effect); } },
  };
  const deps = { React, jsx: (type, props) => ({ type, props }), Original: 'original',
    context: () => ({ hostId: 'local', ...info, clearPrewarmed: () => { clears++; } }),
    readMode: async () => ({ enabled }), writeMode: async value => { writes++; if (fail) throw Error('write failed'); enabled = value; return { enabled }; },
  };
  return {
    render() { cursor = 0; return context.tempCodexComposer({ children: 'input' }, deps); },
    async mount() { this.render(); this.cleanup = effects[0](); await new Promise(resolve => setImmediate(resolve)); },
    setFail(value) { fail = value; }, setEnabled(value) { enabled = value; },
    get clears() { return clears; }, get writes() { return writes; }, listeners, deps,
  };
}
function find(tree, type) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.type === type) return tree;
  for (const child of [].concat(tree.props?.children || [])) { const result = find(child, type); if (result) return result; }
  return null;
}

test('new-chat switch waits for confirmation, clears prewarms, and highlights confirmed mode', async () => {
  const h = harness({ kind: 'new' });
  assert.equal(find(h.render(), 'button').props.disabled, true);
  await h.mount();
  assert.equal(find(h.render(), 'button').props['aria-checked'], false);
  const pending = find(h.render(), 'button').props.onClick();
  assert.equal(find(h.render(), 'original').props.inert, true);
  await pending;
  const tree = h.render();
  assert.equal(tree.props['data-temp-codex-active'], 'true');
  assert.equal(find(tree, 'button').props.role, 'switch');
  assert.equal(h.clears, 2);
  assert.equal(h.writes, 1);
  await find(tree, 'button').props.onClick();
  assert.equal(h.render().props['data-temp-codex-active'], 'false');
  h.cleanup();
  assert.equal(h.listeners.size, 0);
});

test('existing chat highlight follows thread mode and cannot convert the chat', async () => {
  for (const ephemeral of [true, false]) {
    const h = harness({ kind: 'local', ephemeral }, !ephemeral);
    await h.mount();
    const tree = h.render();
    assert.equal(tree.props['data-temp-codex-active'], String(ephemeral));
    assert.equal(find(tree, 'button'), null);
    assert.equal(h.writes, 0);
    h.cleanup();
  }
});

test('failed setting update keeps normal appearance and shows a retryable error', async () => {
  const h = harness({ kind: 'new' });
  await h.mount(); h.setFail(true);
  await find(h.render(), 'button').props.onClick();
  const tree = h.render();
  assert.equal(tree.props['data-temp-codex-active'], 'false');
  assert.equal(find(tree, 'button').props.disabled, false);
  const original = find(tree, 'original');
  assert.equal(original.props.children[1].props.role, 'alert');
  h.cleanup();
});

test('cloud and remote composers retain original rendering', async () => {
  for (const info of [{ kind: 'cloud' }, { kind: 'new', hostId: 'remote-host' }]) {
    const h = harness(info, true); await h.mount();
    assert.equal(h.render().type, 'original'); h.cleanup();
  }
});

test('composer adapter rejects duplicate injection and unknown layouts', () => {
  const patched = adaptComposerSource('function zKn(e){return e;}');
  new vm.Script(patched);
  assert.throws(() => adaptComposerSource(patched), /Unsupported/);
  assert.throws(() => adaptComposerSource('function changed(e){return e;}'), /Unsupported/);
});
