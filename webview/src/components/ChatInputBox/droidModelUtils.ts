/**
 * Droid model catalog helpers: rate badges, descriptions and the fixed
 * vendor grouping used by the model dropdown.
 */
import { DROID_MODEL_GROUP_ORDER, formatDroidMultiplier, type ModelInfo } from './types';
import type { ModelGroup } from './modelSelectUtils';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function isDroidByokModel(model: ModelInfo | undefined): boolean {
  return !!model && (model.isCustom === true || model.group === 'BYOK');
}

/** "1.6×" / "BYOK" badge text for a catalog entry; '' when the rate is unknown. */
export function droidModelRateLabel(model: ModelInfo | undefined, t: Translate): string {
  if (!model) return '';
  if (isDroidByokModel(model)) return t('droid.byok', { defaultValue: 'BYOK' });
  if (model.group === 'Auto') return t('droid.dynamicRate', { defaultValue: 'Dynamic' });
  return formatDroidMultiplier(model.multiplier);
}

function formatEffortRange(efforts: string[] | undefined): string {
  if (!efforts || efforts.length === 0) return '';
  if (efforts.length === 1) return efforts[0];
  return `${efforts[0]}–${efforts[efforts.length - 1]}`;
}

/**
 * Description line for a Droid row: the payload's description when present,
 * otherwise "<rate> Factory token rate · reasoning <min>–<max>".
 */
export function droidModelDescription(model: ModelInfo, t: Translate): string | undefined {
  if (model.description && model.description.trim()) return model.description;
  const parts: string[] = [];
  const rate = formatDroidMultiplier(model.multiplier);
  if (rate && !isDroidByokModel(model)) {
    parts.push(t('droid.tokenRate', { multiplier: rate, defaultValue: `${rate} Factory token rate` }));
  }
  const range = formatEffortRange(model.supportedReasoningEfforts);
  if (range) {
    parts.push(t('droid.reasoningRange', { range, defaultValue: `reasoning ${range}` }));
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Models the desktop app pins above the vendor groups, in display order.
 * The catalog API exposes no "popular/pinned" flag, so this is a curated list;
 * ids missing from the user's catalog are skipped.
 */
export const DROID_FEATURED_MODEL_IDS: readonly string[] = [
  'claude-opus-5-5',
  'gpt-6.1-sol',
  'kimi-k3',
  'glm-5.3',
];

const FAST_VARIANT_RE = /\b(ultra fast|fast mode|fast)\b/gi;
const VERSION_RE = /\d+(?:\.\d+)*/;

interface ModelFamily {
  family: string;
  version: number[];
}

/**
 * "GPT-6.1 Sol Ultra Fast" → { family: "gpt sol", version: [6, 1] }.
 * Fast variants share their base model's family, so they follow its version.
 */
function parseModelFamily(label: string): ModelFamily {
  const cleaned = label.replace(/\[[^\]]*\]/g, '').replace(FAST_VARIANT_RE, ' ');
  const match = VERSION_RE.exec(cleaned);
  const version = match ? match[0].split('.').map(Number) : [];
  const rest = match ? cleaned.replace(match[0], ' ') : cleaned;
  const family = rest.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return { family, version };
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isDeprecated(model: ModelInfo): boolean {
  return /\[deprecated\]/i.test(model.label);
}

/** Keeps only the newest generation of each model family (BYOK is never trimmed). */
function latestPerFamily(models: ModelInfo[], keepId: string | undefined): ModelInfo[] {
  const parsed = models.map((model) => ({ model, ...parseModelFamily(model.label) }));
  const newest = new Map<string, number[]>();
  for (const { model, family, version } of parsed) {
    if (isDeprecated(model)) continue;
    const best = newest.get(family);
    if (!best || compareVersions(version, best) > 0) newest.set(family, version);
  }
  return parsed
    .filter(({ model, family, version }) => {
      if (model.id === keepId) return true;
      if (isDeprecated(model)) return false;
      return compareVersions(version, newest.get(family) ?? []) === 0;
    })
    .map(({ model }) => model);
}

export interface DroidModelSections {
  sections: ModelGroup[];
  /** Rows cut by the visible-count cap (not the same as `legacy`). */
  hiddenCount: number;
  /** Older generations, deprecated models and other rows tucked behind "Show legacy models". */
  legacy: ModelInfo[];
}

export interface DroidSectionOptions {
  /** Active search: show every match, grouped by vendor, without the curated subset. */
  searching?: boolean;
  /** Currently selected model id; always stays visible. */
  selectedId?: string;
}

function groupByVendor(models: ModelInfo[]): Map<string, ModelInfo[]> {
  const buckets = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const key = model.group || 'Other';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(model);
  }
  return buckets;
}

function orderGroups(keys: string[]): string[] {
  const known = DROID_MODEL_GROUP_ORDER.filter((group) => keys.includes(group));
  const unknown = keys.filter(
    (group) => group !== 'Other' && !(DROID_MODEL_GROUP_ORDER as readonly string[]).includes(group),
  );
  return [...known, ...unknown, ...(keys.includes('Other') ? ['Other'] : [])];
}

function applyLimit(
  sections: ModelGroup[],
  visibleLimit: number,
  total: number,
): { sections: ModelGroup[]; hiddenCount: number } {
  const limited: ModelGroup[] = [];
  let remaining = visibleLimit;
  for (const section of sections) {
    if (remaining <= 0) break;
    const slice = section.models.slice(0, remaining);
    remaining -= slice.length;
    if (slice.length > 0) limited.push({ ...section, models: slice });
  }
  const shown = limited.reduce((n, section) => n + section.models.length, 0);
  return { sections: limited, hiddenCount: Math.max(0, total - shown) };
}

/**
 * Builds the Droid dropdown the way the desktop app lays it out:
 * a header-less top block (Auto router + featured models), then one section per
 * vendor in DROID_MODEL_GROUP_ORDER showing only the newest generation of each
 * model family; everything else goes to `legacy`. While searching, every match
 * is listed under its vendor and `legacy` is empty.
 * Falls back to one flat section when no row carries a group.
 */
export function buildDroidModelSections(
  models: ModelInfo[],
  visibleLimit: number,
  options: DroidSectionOptions = {},
): DroidModelSections {
  const hasGroups = models.some((model) => !!model.group);
  if (!hasGroups) {
    const slice = models.slice(0, visibleLimit);
    return {
      sections: slice.length > 0 ? [{ id: 'all', label: '', models: slice }] : [],
      hiddenCount: Math.max(0, models.length - slice.length),
      legacy: [],
    };
  }

  if (options.searching) {
    const buckets = groupByVendor(models);
    const sections = orderGroups([...buckets.keys()]).map((key) => ({
      id: key,
      label: key,
      models: buckets.get(key)!,
    }));
    return { ...applyLimit(sections, visibleLimit, models.length), legacy: [] };
  }

  const featured: ModelInfo[] = models.filter((model) => model.group === 'Auto');
  for (const id of DROID_FEATURED_MODEL_IDS) {
    const model = models.find((m) => m.id === id);
    if (model && !featured.includes(model)) featured.push(model);
  }
  const pinned = new Set(featured.map((model) => model.id));

  const buckets = groupByVendor(models.filter((model) => model.group !== 'Auto'));
  const sections: ModelGroup[] = [];
  if (featured.length > 0) sections.push({ id: 'featured', label: '', models: featured });
  const legacy: ModelInfo[] = [];
  for (const key of orderGroups([...buckets.keys()])) {
    const all = buckets.get(key)!;
    const subset = key === 'BYOK' ? all : latestPerFamily(all, options.selectedId);
    const shown = new Set(subset.map((model) => model.id));
    const visible = subset.filter((model) => !pinned.has(model.id));
    if (visible.length > 0) sections.push({ id: key, label: key, models: visible });
    legacy.push(...all.filter((model) => !shown.has(model.id) && !pinned.has(model.id)));
  }
  const limited = applyLimit(sections, visibleLimit, models.length - legacy.length);
  return { ...limited, legacy };
}
