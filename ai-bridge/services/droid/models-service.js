/**
 * Droid model catalog for the picker.
 *
 * The list comes only from the CLI (`listModels({includeDisabled: true})`):
 * exactly the models the user's Factory plan and org policy allow, plus BYOK
 * custom models from ~/.factory/settings.json. No static fallback list.
 */

import { createDroidTransport, readDefaultDroidModelId } from './droid-runtime.js';

const CATALOG_TTL_MS = 5 * 60 * 1000;

let catalogCache = null; // {models: RawModel[], at: number}
let catalogInFlight = null;

const PROVIDER_GROUPS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
};

export function modelGroup(model) {
  if (model?.isCustom) return 'BYOK';
  if (model?.kind === 'router' || model?.id === 'auto') return 'Auto';
  return PROVIDER_GROUPS[String(model?.modelProvider || '').toLowerCase()] || 'Factory';
}

/** 1.6 → "1.6×", 0.04 → "0.04×", 12 → "12×". */
export function formatMultiplier(multiplier) {
  const n = Number(multiplier);
  if (!Number.isFinite(n)) return '';
  return `${Number(n.toFixed(3))}×`;
}

function reasoningRange(efforts) {
  const list = Array.isArray(efforts) ? efforts.filter((e) => e && e !== 'none') : [];
  if (list.length === 0) return '';
  if (list.length === 1) return `reasoning ${list[0]}`;
  return `reasoning ${list[0]}–${list[list.length - 1]}`;
}

export function describeModel(model) {
  const parts = [];
  if (model?.isCustom) {
    parts.push('BYOK custom model');
  } else if (Number.isFinite(Number(model?.tokenMultiplier))) {
    parts.push(`${formatMultiplier(model.tokenMultiplier)} Factory token rate`);
  }
  const range = reasoningRange(model?.supportedReasoningEfforts);
  if (range) parts.push(range);
  if (model?.disabled && model?.disabledReason) parts.push(String(model.disabledReason));
  return parts.join(' · ');
}

/** Raw SDK ModelInfo → picker row. */
export function toPickerModel(model) {
  const efforts = Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map(String) : [];
  const multiplier = model?.isCustom ? null : (Number.isFinite(Number(model?.tokenMultiplier)) ? Number(model.tokenMultiplier) : null);
  return {
    id: String(model.id),
    label: String(model.displayName || model.shortDisplayName || model.id),
    shortLabel: String(model.shortDisplayName || model.displayName || model.id),
    description: describeModel(model),
    multiplier,
    group: modelGroup(model),
    modelProvider: model?.modelProvider || '',
    disabled: model?.disabled === true,
    disabledReason: model?.disabled ? (model.disabledReason || null) : null,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: typeof model?.defaultReasoningEffort === 'string' ? model.defaultReasoningEffort : (efforts[0] || ''),
    noImageSupport: model?.noImageSupport === true,
    isCustom: model?.isCustom === true,
  };
}

/**
 * Pure catalog mapping (testable).
 * @param {object[]} rawModels SDK ModelInfo[]
 * @param {string} [defaultModelId] CLI default from settings
 */
export function mapModelCatalog(rawModels, defaultModelId = '') {
  const models = (Array.isArray(rawModels) ? rawModels : [])
    .filter((m) => m && typeof m.id === 'string' && m.id)
    .map(toPickerModel);
  const enabled = models.filter((m) => !m.disabled);
  const preferred = models.find((m) => m.id === defaultModelId && !m.disabled);
  const defaultModel = preferred?.id || enabled.find((m) => m.id !== 'auto')?.id || enabled[0]?.id || '';
  return { models, defaultModel };
}

/**
 * Reasoning effort to apply for a model: the requested one when supported,
 * otherwise the model's default (models differ: off/low/…/max, none, minimal).
 */
export function resolveReasoningEffort(model, requested) {
  const efforts = Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
  const wanted = String(requested || '').trim().toLowerCase();
  if (wanted && efforts.includes(wanted)) return wanted;
  return model?.defaultReasoningEffort || undefined;
}

/** Fetch (or reuse) the raw catalog. */
export async function getRawCatalog({ force = false, cwd, execPath } = {}) {
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.models;
  }
  if (catalogInFlight) return catalogInFlight;
  catalogInFlight = (async () => {
    const { sdk, transport } = await createDroidTransport({ cwd, execPath });
    let models;
    try {
      models = await sdk.listModels({ includeDisabled: true, transport });
    } catch (err) {
      try { await transport.close(); } catch { /* already closed */ }
      throw err;
    }
    catalogCache = { models: Array.isArray(models) ? models : [], at: Date.now() };
    return catalogCache.models;
  })().finally(() => {
    catalogInFlight = null;
  });
  return catalogInFlight;
}

/** Cached lookup used by the session service for reasoning validation. */
export function findCachedModel(modelId) {
  if (!catalogCache || !modelId) return null;
  const raw = catalogCache.models.find((m) => m?.id === modelId);
  return raw ? toPickerModel(raw) : null;
}

/** Seed the cache from a live session's catalog (testing / warm daemons). */
export function primeCatalogCache(models) {
  catalogCache = { models: Array.isArray(models) ? models : [], at: Date.now() };
}

/**
 * Print {success, provider, models, defaultModel} for listModels.
 */
export async function listModels(params = {}) {
  try {
    const raw = await getRawCatalog({ force: params.force === true, cwd: params.cwd, execPath: params.execPath });
    const { models, defaultModel } = mapModelCatalog(raw, readDefaultDroidModelId());
    const payload = { success: true, provider: 'droid', models, defaultModel };
    console.log(JSON.stringify(payload));
    return payload;
  } catch (err) {
    const message = err?.message || String(err);
    const payload = { success: false, provider: 'droid', error: message, models: [], defaultModel: '' };
    console.log(JSON.stringify(payload));
    return payload;
  }
}
