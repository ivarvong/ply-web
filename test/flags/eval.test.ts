import { describe, expect, it } from 'vitest';
import { applyRollout, applyTargeting, encodeDocument, parseDocumentText } from '../../src/flags/document.ts';
import { evaluateDocument, evaluateFlag } from '../../src/flags/eval.ts';
import { bucketOf, inBucket } from '../../src/flags/hash.ts';
import { BASIS_POINTS } from '../../src/flags/ttl.ts';
import { EMPTY_DOCUMENT, basisPointsOf, type FlagDocument, type Unit } from '../../src/flags/types.ts';
import { DEFAULT_POLICY_PATH, loadPolicy } from '../../scripts/cd/policy.ts';

const unit = (id: string, attributes: Record<string, string> = {}): Unit => ({ id, attributes });

function ramp(basisPoints: number): FlagDocument {
  const edited = applyRollout(EMPTY_DOCUMENT, 'ply.usage.note', basisPoints);
  if (edited.kind !== 'ok') throw new Error(edited.reason);
  return edited.document;
}

describe('rollout allocation', () => {
  it('accepts any basis point from 0 through 10000, including values that are not policy steps', () => {
    expect(ramp(7).flags[0]!.rollout).toEqual({ kind: 'ramping', basisPoints: 7 });
    expect(basisPointsOf(ramp(1).flags[0]!.rollout)).toBe(1);
    expect(ramp(BASIS_POINTS).flags[0]!.rollout).toEqual({ kind: 'complete' });
    expect(basisPointsOf(ramp(BASIS_POINTS).flags[0]!.rollout)).toBe(BASIS_POINTS);
    const back = applyRollout(ramp(50), 'ply.usage.note', 0);
    if (back.kind !== 'ok') throw new Error(back.reason);
    expect(back.document.flags[0]!.rollout).toEqual({ kind: 'rolled-back', reason: 'basis points 0' });
    expect(basisPointsOf(back.document.flags[0]!.rollout)).toBe(0);
    expect(applyRollout(EMPTY_DOCUMENT, 'ply.usage.note', -1).kind).toBe('invalid');
    expect(applyRollout(EMPTY_DOCUMENT, 'ply.usage.note', BASIS_POINTS + 1).kind).toBe('invalid');
    expect(applyRollout(EMPTY_DOCUMENT, 'ply.usage.note', 1.5).kind).toBe('invalid');
  });

  it('can apply each step of the checked-in CD policy as basis points', () => {
    const { policy } = loadPolicy(DEFAULT_POLICY_PATH);
    expect(policy.steps.length).toBeGreaterThan(0);
    for (const step of policy.steps) {
      const basisPoints = step.percent * 100;
      const flag = ramp(basisPoints).flags[0]!;
      expect(basisPointsOf(flag.rollout)).toBe(basisPoints);
    }
  });
});

describe('evaluation precedence', () => {
  it('is deny, then allow, then rule, then bucket, then default', () => {
    const base = ramp(BASIS_POINTS);
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

  it('keeps a bucketed unit in as the allocation grows, and out until it crosses', () => {
    const id = 'user-2';
    const bucket = bucketOf('ply.usage.note', 'v1', id);
    let entered = false;
    for (let basisPoints = 0; basisPoints <= BASIS_POINTS; basisPoints += 250) {
      const flag = ramp(basisPoints).flags[0]!;
      const evaluation = evaluateFlag(flag, flag.key, unit(id));
      const inside = inBucket(bucket, basisPoints);
      expect(evaluation.bucket).toBe(bucket);
      expect(evaluation.reason === 'bucket').toBe(inside);
      if (entered) expect(inside).toBe(true);
      if (inside) entered = true;
    }
    expect(entered).toBe(true);
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
