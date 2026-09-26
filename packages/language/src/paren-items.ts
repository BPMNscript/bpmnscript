/**
 * Readers over an element's parenthesised items. The payload, the settings
 * and the flags share one list and are told apart by node type, so every
 * reader lives here rather than spelling that union again at each site.
 */

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

/**
 * The unkeyed value: an event's payload, or a `condition`'s expression. A
 * second one is a duplicate the validator reports, so this reads the first.
 */
export function payloadItemOf(items: ParenItem[]): ParenValue | undefined {
  return items.find(isParenValue);
}

/**
 * A `code:`/`message:` setting on a handler, told from an engine setting by
 * its key alone. Only a bare name declares a variable, so `code: "LITERAL"`
 * leaves `variable` undefined and reads rather than binds.
 */
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

/**
 * A key that is a catch binding or a timer clause rather than a setting, so
 * the key check passes over it. Only a handler catches a code or a message and
 * only a timer names a date or a cycle; anywhere else the words are unknown
 * keys.
 */
export function isStructuralParenKey(owner: AstNode, key: string): boolean {
  if (isOnHandler(owner) && EVENT_BINDING_FIELD_SET.has(key)) return true;
  return (
    'trigger' in owner &&
    TIMER_PARTICLE_KEYS.some((particle) => particle === key)
  );
}

/** A timer says a duration by writing it bare, and a date or a cycle by key. */
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
 * The trigger word of the event whose bare payload slot `node` sits in, else
 * `undefined`. Every identifier in every expression parses as the same
 * reference, so this is what separates `error(OUT_OF_STOCK)` from
 * `condition(ready)` for the scope provider, the linker, the validator and the
 * suppression alike. An operand of `error(a > b)` is contained by the operator
 * node, not the `ParenValue`, so a nested identifier answers `undefined` on
 * its own.
 */
function payloadTriggerOf(node: AstNode): string | undefined {
  // Only the stand-in Langium's `completionForCrossReference` builds is held
  // in a `ref` slot; its container is where the caret sits, the `VarRef` a
  // typed prefix has built or the event itself where nothing is written yet.
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

/**
 * The trigger word under which `node` names a declared code, else
 * `undefined`: the unkeyed value of an `error` or `escalation` event, or a
 * mapping's code slot, `error E when ...`, whose own trigger word heads the
 * line.
 */
export function codeTriggerOf(node: AstNode): string | undefined {
  const trigger = isErrorMapping(node)
    ? mappingTriggerOf(node)
    : payloadTriggerOf(node);
  return trigger !== undefined && DECLARED_CODE_TRIGGERS.has(trigger)
    ? trigger
    : undefined;
}

/**
 * The completion stand-in for the code slot is a mapping with no trigger of
 * its own, held by the parsed mapping being typed, so its word is read off
 * that holder. The generated type says a mapping is held by an element, which
 * only the stand-in departs from, hence the widening.
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

/**
 * The trigger word under which `node` writes a name rather than a code: a
 * message or a signal keys the engine's subscription by text, so a bare word
 * there is a missing pair of quotes.
 */
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
 * The code a declaration keys by: its `code` setting, which carries a code no
 * name could spell (`error OrderFailed(code: "order.failed")`), else its own
 * name. `undefined` for a written setting that is empty or not quoted text,
 * both of which the validator reports on its own.
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

/**
 * The payload as text: a message or signal name, a code, or a timer duration.
 * A code is a plain word naming its declaration and reads back as the same
 * text a quoted one would; a condition is an expression, not text, and is read
 * through {@link payloadItemOf} instead.
 */
export function payloadTextOf(items: ParenItem[]): string | undefined {
  const value = payloadItemOf(items)?.value;
  if (value === undefined) return undefined;
  if (isLiteralString(value)) return value.value;
  if (isVarRef(value)) return value.ref.$refText;
  if (isRawExpr(value)) return value.raw;
  return undefined;
}

/** Only quoted text is a value written where the position wants something else: a word names a declaration and a `${...}` template is an expression. */
export function hasQuotedPayload(items: ParenItem[]): boolean {
  const value = payloadItemOf(items)?.value;
  return value !== undefined && isLiteralString(value);
}

/** A timer clause, and the item a diagnostic about it belongs on. */
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

/** A bare duration answers the `after` particle it would carry elsewhere, so every caller reads one shape. */
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

/** Only a condition's payload is an expression rather than text, which is what separates `condition(a > b)` from `error(OUT_OF_STOCK)`. */
export function hasExpressionPayload(items: ParenItem[]): boolean {
  return (
    payloadItemOf(items) !== undefined && payloadTextOf(items) === undefined
  );
}
