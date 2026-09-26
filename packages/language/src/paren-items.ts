/** The payload, settings and flags share one list, told apart by node type. */

import {
  DECLARED_CODE_TRIGGERS,
  EVENT_BINDING_FIELD_SET,
  EVENT_CODE_FIELD,
  namesACode,
  TIMER_PARTICLE_BY_KIND,
  type TimerParticle,
} from './vocabulary.js';
import type { AstNode } from 'langium';
import {
  isErrorMapping,
  isLiteralString,
  isOnHandler,
  isRawExpr,
  isVarRef,
  isFlag,
  isParenValue,
  isSetting,
  type CodeDecl,
  type ErrorMapping,
  type Expr,
  type Flag,
  type ParenItem,
  type ParenValue,
  type Setting,
} from './generated/ast.js';

export function settingsOf(items: ParenItem[]): Setting[] {
  return items.filter(isSetting);
}

export function flagsOf(items: ParenItem[]): Flag[] {
  return items.filter(isFlag);
}

/** A second one is a duplicate the validator reports. */
export function payloadItemOf(items: ParenItem[]): ParenValue | undefined {
  return items.find(isParenValue);
}

/** Only a bare name declares a variable; `code: "LITERAL"` reads rather than binds. */
interface CaughtBinding {
  readonly field: string;
  readonly variable: string | undefined;
  readonly node: Setting;
}

export function caughtBindingsOf(items: ParenItem[]): CaughtBinding[] {
  return settingsOf(items)
    .filter((setting) => EVENT_BINDING_FIELD_SET.has(setting.key))
    .map((setting) => ({
      field: setting.key,
      variable: isVarRef(setting.value)
        ? setting.value.ref.$refText
        : undefined,
      node: setting,
    }));
}

/** Catch bindings on a handler and timer keys on a timer; unknown keys anywhere else. */
export function isStructuralParenKey(owner: AstNode, key: string): boolean {
  if (isOnHandler(owner) && EVENT_BINDING_FIELD_SET.has(key)) return true;
  return (
    'trigger' in owner &&
    TIMER_PARTICLE_KEYS.some((particle) => particle === key)
  );
}

const TIMER_PARTICLE_KEYS: readonly TimerParticle[] = [
  TIMER_PARTICLE_BY_KIND.date,
  TIMER_PARTICLE_BY_KIND.cycle,
];

export function configuredSettingsOf(
  owner: AstNode & { items?: ParenItem[] },
): Setting[] {
  return settingsOf(owner.items ?? []).filter(
    (setting) => !isStructuralParenKey(owner, setting.key),
  );
}

/**
 * Every identifier parses as the same reference, so this separates
 * `error(OUT_OF_STOCK)` from `condition(ready)`. A nested operand is contained
 * by its operator, so it answers `undefined`.
 */
function payloadTriggerOf(node: AstNode): string | undefined {
  // Langium's completion stand-in sits in a `ref` slot under the caret's node.
  if (node.$containerProperty === 'ref' && node.$container !== undefined) {
    const caret = node.$container;
    return payloadTriggerOf(caret) ?? triggerWordOf(caret);
  }
  const item = node.$container;
  return item !== undefined && isParenValue(item)
    ? triggerWordOf(item.$container)
    : undefined;
}

export function triggerWordOf(owner: AstNode): string | undefined {
  return 'trigger' in owner && typeof owner.trigger === 'string'
    ? owner.trigger
    : undefined;
}

/** The unkeyed value of an `error` or `escalation`, or a mapping's code slot. */
export function codeTriggerOf(node: AstNode): string | undefined {
  const trigger = isErrorMapping(node)
    ? mappingTriggerOf(node)
    : payloadTriggerOf(node);
  return trigger !== undefined && DECLARED_CODE_TRIGGERS.has(trigger)
    ? trigger
    : undefined;
}

/**
 * The completion stand-in is held by the mapping being typed, not an element,
 * hence the widening.
 */
function mappingTriggerOf(mapping: ErrorMapping): string | undefined {
  const holder: AstNode | undefined = mapping.$container;
  if (
    mapping.trigger === undefined &&
    mapping.$containerProperty === 'code' &&
    isErrorMapping(holder)
  ) {
    return holder.trigger;
  }
  return mapping.trigger;
}

/** A message or signal keys its subscription by text, so a bare word there is missing quotes. */
export function nameTriggerOf(node: AstNode): string | undefined {
  const trigger = payloadTriggerOf(node);
  return trigger !== undefined &&
    namesACode(trigger) &&
    !DECLARED_CODE_TRIGGERS.has(trigger)
    ? trigger
    : undefined;
}

export function isCodePosition(node: AstNode): boolean {
  return codeTriggerOf(node) !== undefined;
}

/**
 * The `code` setting, else the name. `undefined` for an empty or unquoted
 * setting, which the validator reports.
 */
export function declaredCodeOf(decl: CodeDecl): string | undefined {
  const setting = settingsOf(decl.items).find(
    (item) => item.key === EVENT_CODE_FIELD,
  );
  if (setting === undefined) return decl.name;
  if (!isLiteralString(setting.value) || setting.value.value.length === 0) {
    return undefined;
  }
  return setting.value.value;
}

/** A code reads back as the same text a quoted one would; a condition is no text. */
export function payloadTextOf(items: ParenItem[]): string | undefined {
  const value = payloadItemOf(items)?.value;
  if (value === undefined) return undefined;
  if (isLiteralString(value)) return value.value;
  if (isVarRef(value)) return value.ref.$refText;
  if (isRawExpr(value)) return value.raw;
  return undefined;
}

/** A word names a declaration and a `${...}` is an expression, so only quoted text counts. */
export function hasQuotedPayload(items: ParenItem[]): boolean {
  const value = payloadItemOf(items)?.value;
  return value !== undefined && isLiteralString(value);
}

export interface TimerPayload {
  readonly particle: TimerParticle;
  readonly time: string;
  readonly node: Setting | ParenValue;
}

export function timerParticleOf(
  items: ParenItem[],
): (TimerPayload & { node: Setting }) | undefined {
  for (const setting of settingsOf(items)) {
    const particle = TIMER_PARTICLE_KEYS.find((key) => key === setting.key);
    if (particle === undefined) continue;
    const time = timeTextOf(setting.value);
    if (time !== undefined) {
      return { particle, time, node: setting };
    }
  }
  return undefined;
}

/** A bare duration answers the `after` particle, so callers read one shape. */
export function timerPayloadOf(items: ParenItem[]): TimerPayload | undefined {
  const keyed = timerParticleOf(items);
  if (keyed !== undefined) return keyed;
  const bare = payloadItemOf(items);
  if (bare === undefined) return undefined;
  const time = timeTextOf(bare.value);
  return time === undefined
    ? undefined
    : { particle: TIMER_PARTICLE_BY_KIND.duration, time, node: bare };
}

function timeTextOf(value: Expr): string | undefined {
  if (isLiteralString(value)) return value.value;
  if (isRawExpr(value)) return value.raw;
  return undefined;
}

export function flagOf(items: ParenItem[], word: string): Flag | undefined {
  return flagsOf(items).find((flag) => flag.flag === word);
}

export function hasFlag(items: ParenItem[], word: string): boolean {
  return flagOf(items, word) !== undefined;
}

export function hasExpressionPayload(items: ParenItem[]): boolean {
  return (
    payloadItemOf(items) !== undefined && payloadTextOf(items) === undefined
  );
}
