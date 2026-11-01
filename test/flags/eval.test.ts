import { describe, expect, it } from 'vitest';
import { applyRollout, applyTargeting, encodeDocument, parseDocumentText } from '../../src/flags/document.ts';
import { evaluateDocument, evaluateFlag } from '../../src/flags/eval.ts';
import { bucketOf, inBucket } from '../../src/flags/hash.ts';
import { EMPTY_DOCUMENT, percentOf, type FlagDocument, type Unit } from '../../src/flags/types.ts';
import { ROLLOUT_PERCENTS } from '../../src/flags/types.ts';
import { RAMP_PERCENTS } from '../../scripts/cd/baseline.ts';

const unit = (id: string, attributes: Record<string, string> = {}): Unit => ({ id, attributes });

function ramp(percent: number): FlagDocument {
  const edited = applyRollout(EMPTY_DOCUMENT, 'ply.usage.note', percent);
  if (edited.kind !== 'ok') throw new Error(edited.reason);
  return edited.document;
}

describe('rollout schedule', () => {
  it('uses the CD percent steps', () => {
    expect([...ROLLOUT_PERCENTS]).toEqual([...RAMP_PERCENTS]);
  });

  it('walks ramping, then complete, and 0 is rolled back', () => {
    const at1 = ramp(1).flags[0]!;
    expect(at1.rollout).toEqual({ kind: 'ramping', step: 0, percents: [...ROLLOUT_PERCENTS] });
    expect(percentOf(at1.rollout)).toBe(1);
    const at100 = ramp(100).flags[0]!;
    expect(at100.rollout.kind).toBe('complete');
    expect(percentOf(at100.rollout)).toBe(100);
    const back = applyRollout(ramp(50), 'ply.usage.note', 0);
    if (back.kind !== 'ok') throw new Error(back.reason);
    expect(back.document.flags[0]!.rollout).toEqual({ kind: 'rolled-back', reason: 'percent 0', percents: [...ROLLOUT_PERCENTS] });
  });

  it('rejects a percent that is not a step', () => {
    const edited = applyRollout(EMPTY_DOCUMENT, 'ply.usage.note', 3);
    expect(edited.kind).toBe('invalid');
  });
});

describe('evaluation precedence', () => {
  it('is deny, then allow, then rule, then bucket, then default', () => {
    const base = ramp(100);
    const targeted = applyTargeting(base, 'ply.usage.note', {
      allow: ['kept'],
      deny: ['blocked', 'kept'],
      rules: [{ attribute: 'plan', op: 'eq', value: 'pro', variant: { kind: 'string', value: 'pro' } }],
    });
    if (targeted.kind !== 'ok') throw new Error(targeted.reason);
    const flag = targeted.document.flags[0]!;
    expect(evaluateFlag(flag, flag.key, unit('blocked')).reason).toBe('override');
    expect(evaluateFlag(flag, flag.key, unit('blocked')).variant).toEqual({ kind: 'boolean', value: false });
    expect(evaluateFlag(flag, flag.key, unit('kept')).reason).toBe('override');
    expect(evaluateFlag(flag, flag.key, unit('kept')).variant).toEqual({ kind: 'boolean', value: false });
    const ruled = evaluateFlag(flag, flag.key, unit('other', { plan: 'pro' }));
    expect(ruled.reason).toBe('rule');
    expect(ruled.variant).toEqual({ kind: 'string', value: 'pro' });
    const open = evaluateFlag(flag, flag.key, unit('anonymous'));
    expect(open.reason).toBe('bucket');
    expect(open.variant).toEqual({ kind: 'boolean', value: true });
  });

  it('keeps a bucketed unit in as the percent grows, and out until it crosses', () => {
    const id = 'user-2';
    const bucket = bucketOf('ply.usage.note', 'v1', id);
    let entered = false;
    for (const percent of [0, ...ROLLOUT_PERCENTS]) {
      const flag = ramp(percent).flags[0]!;
      const evaluation = evaluateFlag(flag, flag.key, unit(id));
      const inside = inBucket(bucket, percent);
      expect(evaluation.bucket).toBe(bucket);
      expect(evaluation.reason === 'bucket').toBe(inside);
      if (entered) expect(inside).toBe(true);
      if (inside) entered = true;
    }
  });

  it('round-trips the document and treats a missing flag as default off', () => {
    const document = ramp(5);
    const parsed = parseDocumentText(encodeDocument(document));
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.document).toEqual(document);
    const missing = evaluateDocument(document, unit('anonymous'), ['no.such'])[0]!;
    expect(missing.reason).toBe('default');
    expect(missing.variant).toEqual({ kind: 'boolean', value: false });
  });
});
