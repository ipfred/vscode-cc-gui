import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from './persistent-droid-service.js';

const { applySettings, mapImages, addUsage } = __testing;

function fakeRuntime(settings) {
  const calls = [];
  const session = {
    settings: { ...settings },
    async updateSettings(update) {
      calls.push(['update', update]);
      Object.assign(this.settings, update);
      return {};
    },
    async enterSpecMode() {
      calls.push(['enterSpec']);
      this.settings.interactionMode = 'spec';
      return {};
    },
  };
  return { runtime: { session }, calls };
}

test('Spec is independent of the autonomy level', async () => {
  const { runtime, calls } = fakeRuntime({ modelId: 'm', interactionMode: 'auto', autonomyLevel: 'off' });
  await applySettings(runtime, { permissionMode: 'auto' });
  await applySettings(runtime, { permissionMode: 'auto' });
  await applySettings(runtime, { permissionMode: 'auto', specMode: true });
  // Changing the level while in Spec keeps Spec on.
  await applySettings(runtime, { permissionMode: 'bypassPermissions' });
  await applySettings(runtime, { permissionMode: 'bypassPermissions', specMode: false });
  assert.deepEqual(calls, [
    ['update', { autonomyLevel: 'medium' }],
    ['enterSpec'],
    ['update', { autonomyLevel: 'high' }],
    ['update', { interactionMode: 'auto' }],
  ]);
});

test('the legacy plan mode enters Spec without touching the autonomy level', async () => {
  const { runtime, calls } = fakeRuntime({ modelId: 'm', interactionMode: 'auto', autonomyLevel: 'low' });
  await applySettings(runtime, { permissionMode: 'plan' });
  assert.deepEqual(calls, [['enterSpec']]);
});

test('model switch is skipped for the default placeholder and retried without a rejected effort', async () => {
  const { runtime, calls } = fakeRuntime({ modelId: 'a', reasoningEffort: 'high' });
  await applySettings(runtime, { model: 'default' });
  assert.deepEqual(calls, []);

  let failOnce = true;
  const original = runtime.session.updateSettings.bind(runtime.session);
  runtime.session.updateSettings = async (update) => {
    if (failOnce && update.reasoningEffort) {
      failOnce = false;
      calls.push(['rejected', update]);
      throw new Error('unsupported effort');
    }
    return original(update);
  };
  await applySettings(runtime, { model: 'unknown-model', reasoningEffort: 'ultra' });
  assert.deepEqual(calls, [
    ['rejected', { modelId: 'unknown-model', reasoningEffort: 'ultra' }],
    ['update', { modelId: 'unknown-model' }],
  ]);
  assert.equal(runtime.session.settings.modelId, 'unknown-model');
});

test('image attachments become SDK base64 images', () => {
  assert.equal(mapImages(undefined), undefined);
  assert.deepEqual(mapImages([
    { data: 'AAA', mediaType: 'image/jpeg' },
    { data: 'BBB' },
    { data: 'CCC', mediaType: 'application/pdf' },
    { data: '' },
  ]), [
    { type: 'base64', data: 'AAA', mediaType: 'image/jpeg' },
    { type: 'base64', data: 'BBB', mediaType: 'image/png' },
  ]);
});

test('session usage accumulates numeric counters', () => {
  const total = addUsage(addUsage(null, { input_tokens: 10, factory_credits: 2, model: 'x' }), { input_tokens: 5, output_tokens: 3 });
  assert.deepEqual(total, { input_tokens: 15, factory_credits: 2, output_tokens: 3 });
});
