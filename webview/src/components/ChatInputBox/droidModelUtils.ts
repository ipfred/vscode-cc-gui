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
 * Groups a Droid catalog by its `group` field in DROID_MODEL_GROUP_ORDER;
 * unknown groups follow in first-seen order, ungrouped rows go last. Falls
 * back to one flat section when no row carries a group (static placeholder).
 */
export function buildDroidModelSections(
  models: ModelInfo[],
  visibleLimit: number,
): { sections: ModelGroup[]; hiddenCount: number } {
  const hasGroups = models.some((model) => !!model.group);
  if (!hasGroups) {
    const slice = models.slice(0, visibleLimit);
    return {
      sections: slice.length > 0 ? [{ id: 'all', label: '', models: slice }] : [],
      hiddenCount: Math.max(0, models.length - slice.length),
    };
  }

  const buckets = new Map<string, ModelInfo[]>();
  const seenOrder: string[] = [];
  for (const model of models) {
    const key = model.group || 'Other';
    if (!buckets.has(key)) {
      buckets.set(key, []);
      seenOrder.push(key);
    }
    buckets.get(key)!.push(model);
  }
  const known = DROID_MODEL_GROUP_ORDER.filter((group) => buckets.has(group));
  const unknown = seenOrder.filter(
    (group) => group !== 'Other' && !(DROID_MODEL_GROUP_ORDER as readonly string[]).includes(group),
  );
  const order = [...known, ...unknown, ...(buckets.has('Other') ? ['Other'] : [])];

  const sections: ModelGroup[] = [];
  let remaining = visibleLimit;
  for (const key of order) {
    if (remaining <= 0) break;
    const slice = (buckets.get(key) ?? []).slice(0, remaining);
    remaining -= slice.length;
    if (slice.length > 0) sections.push({ id: key, label: key, models: slice });
  }
  const shown = sections.reduce((n, section) => n + section.models.length, 0);
  return { sections, hiddenCount: Math.max(0, models.length - shown) };
}
