/**
 * Readers over an element's parenthesised settings.
 *
 * The payload, the settings and the flags share one list, so which of them an
 * item is comes from its node type rather than from a property per kind.
 * Reading them anywhere else would spell the union a second time.
 */

import {
  DECLARED_CODE_TRIGGERS,
  EVENT_BINDING_FIELDS,
  namesACode,
  TIMER_PARTICLE_BY_KIND,
} from './vocabulary.js';
import type { AstNode } from 'langium';
import { unquoteRaw } from './expression-render.js';
import {
  isLiteralString,
  isOnHandler,
  isRawExpr,
  isVarRef,
  isFlag,
  isParenValue,
  isSetting,
  type CodeDecl,
  type Expr,
  type Flag,
  type ParenItem,
  type ParenValue,
  type Setting,
} from './generated/ast.js';

/** The `key: value` settings, in source order. */
export function settingsOf(items: ParenItem[]): Setting[] {
  return items.filter(isSetting);
}

/** The bare flag words, in source order. */
export function flagsOf(items: ParenItem[]): Flag[] {
  return items.filter(isFlag);
}

/**
 * The unkeyed value: an event's payload, and the expression a `condition`
 * carries. A second one is a duplicate the validator reports rather than a
 * shape the grammar rejects, so this reads the first.
 */
export function payloadItemOf(items: ParenItem[]): ParenValue | undefined {
  return items.find(isParenValue);
}

/**
 * A catch binding: a `code:`/`message:` setting on a handler, told from an
 * engine setting by its key rather than by its shape. Only a bare name declares
 * anything, so a value that is not one leaves `variable` undefined, which is
 * what makes `code: "LITERAL"` a setting that reads rather than a binding.
 */
export interface CaughtBinding {
  readonly field: string;
  readonly variable: string | undefined;
  readonly node: Setting;
}

const EVENT_BINDING_FIELD_SET: ReadonlySet<string> = new Set(
  EVENT_BINDING_FIELDS,
);

/** Every catch binding on a handler, in source order. */
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
 * A paren key that carries a catch binding or a timer clause rather than a
 * setting, so the key check passes over it. Only a handler catches a code or a
 * message, and there {@link caughtBindingsOf} has already read it; only a timer
 * names a date or a cycle. Anywhere else those words are ordinary unknown keys.
 */
function isStructuralParenKey(owner: AstNode, key: string): boolean {
  if (isOnHandler(owner) && EVENT_BINDING_FIELD_SET.has(key)) return true;
  return 'trigger' in owner && TIMER_PARTICLE_KEYS.has(key);
}

/** A timer says a duration by writing it bare, and a date or a cycle by key. */
const TIMER_PARTICLE_KEYS: ReadonlySet<string> = new Set([
  TIMER_PARTICLE_BY_KIND.date,
  TIMER_PARTICLE_BY_KIND.cycle,
]);

/** An element's engine settings, which is every setting bar the structural keys. */
export function configuredSettingsOf(
  owner: AstNode & { items?: ParenItem[] },
): Setting[] {
  return settingsOf(owner.items ?? []).filter(
    (setting) => !isStructuralParenKey(owner, setting.key),
  );
}

/**
 * The trigger word of the event whose bare payload slot `node` sits in, or
 * `undefined` where it sits anywhere else. Every identifier in every expression
 * parses as the same reference, so this is the one thing separating
 * `error(OUT_OF_STOCK)` from `condition(ready)`, and the scope provider, the
 * linker, the validator and the suppression all ask it here rather than each
 * deciding for itself.
 *
 * A nested identifier answers `undefined` without a check of its own:
 * `ParenValue` has the payload as its only child, so an operand of
 * `error(a > b)` is contained by the operator node instead.
 */
function payloadTriggerOf(node: AstNode): string | undefined {
  // Completion asks about a stand-in for the reference being typed rather than
  // about a parsed node (`completionForCrossReference` in Langium's
  // `DefaultCompletionProvider` builds one), and the stand-in's container is
  // where the caret sits: the `VarRef` a typed prefix has already built, or the
  // event itself where nothing is written yet. A parsed reference is never held
  // in a `ref` slot, so only the stand-in takes this step.
  if (node.$containerProperty === 'ref' && node.$container !== undefined) {
    const caret = node.$container;
    return payloadTriggerOf(caret) ?? triggerWordOf(caret);
  }
  const item = node.$container;
  return item !== undefined && isParenValue(item)
    ? triggerWordOf(item.$container)
    : undefined;
}

function triggerWordOf(owner: AstNode): string | undefined {
  return 'trigger' in owner && typeof owner.trigger === 'string'
    ? owner.trigger
    : undefined;
}

/**
 * The trigger word under which `node` names a declared code, or `undefined`
 * where it names none: only the unkeyed value of an `error` or `escalation`
 * event does.
 */
export function codeTriggerOf(node: AstNode): string | undefined {
  const trigger = payloadTriggerOf(node);
  return trigger !== undefined && DECLARED_CODE_TRIGGERS.has(trigger)
    ? trigger
    : undefined;
}

/**
 * The trigger word under which `node` writes a name of its own instead: a
 * message or a signal keys the subscription the engine correlates on, so its
 * payload carries text rather than referring to a declaration the way a code
 * does, and a bare word there is a missing pair of quotes.
 */
export function nameTriggerOf(node: AstNode): string | undefined {
  const trigger = payloadTriggerOf(node);
  return trigger !== undefined &&
    namesACode(trigger) &&
    !DECLARED_CODE_TRIGGERS.has(trigger)
    ? trigger
    : undefined;
}

/** {@link codeTriggerOf} where the word itself does not matter. */
export function isCodePosition(node: AstNode): boolean {
  return codeTriggerOf(node) !== undefined;
}

/**
 * The code a declaration keys by: its `code` setting, or its own name where
 * none is written. The setting is what carries a code no name could spell,
 * `error OrderFailed(code: "order.failed")`. `undefined` where a `code` setting
 * is written but is not quoted text, or is empty, both of which the validator
 * reports on their own.
 */
export function declaredCodeOf(decl: CodeDecl): string | undefined {
  const setting = settingsOf(decl.items).find((item) => item.key === 'code');
  if (setting === undefined) return decl.name;
  if (!isLiteralString(setting.value) || setting.value.value.length === 0) {
    return undefined;
  }
  return setting.value.value;
}

/**
 * The trigger payload written bare in the parens: a message or signal name, an
 * error or escalation code, or a timer duration. A code may be written as a
 * plain word so it can name an error declaration, so both spellings read back
 * as the same text. A condition is an expression rather than text and is read
 * through {@link payloadItemOf} instead.
 */
export function payloadTextOf(items: ParenItem[]): string | undefined {
  const value = payloadItemOf(items)?.value;
  if (value === undefined) return undefined;
  if (isLiteralString(value)) return value.value;
  if (isVarRef(value)) return value.ref.$refText;
  if (isRawExpr(value)) return unquoteRaw(value.raw);
  return undefined;
}

/**
 * Whether the parens lead with quoted text. A word names a declaration and a
 * `${...}` template is an expression, so only this shape is the author writing
 * a value where the position wants something else.
 */
export function hasQuotedPayload(items: ParenItem[]): boolean {
  const value = payloadItemOf(items)?.value;
  return value !== undefined && isLiteralString(value);
}

/** A timer clause, and the item a diagnostic about it belongs on. */
export interface TimerPayload {
  readonly particle: string;
  readonly time: string;
  readonly node: Setting | ParenValue;
}

/** The timer particle a keyed payload names, with the text it carries. */
export function timerParticleOf(
  items: ParenItem[],
): (TimerPayload & { node: Setting }) | undefined {
  for (const setting of settingsOf(items)) {
    if (!TIMER_PARTICLE_KEYS.has(setting.key)) continue;
    const time = timeTextOf(setting.value);
    if (time !== undefined) {
      return { particle: setting.key, time, node: setting };
    }
  }
  return undefined;
}

/**
 * The whole timer clause: a duration written bare, or the date or cycle a key
 * names. A bare duration answers the `after` particle it would be written with
 * elsewhere, so every caller reads one shape.
 */
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

/** A time is quoted text; a raw template carries its quotes and is stripped here. */
function timeTextOf(value: Expr): string | undefined {
  if (isLiteralString(value)) return value.value;
  if (isRawExpr(value)) return unquoteRaw(value.raw);
  return undefined;
}

/** The bare flag word `word`, where it is written, for a diagnostic on it. */
export function flagOf(items: ParenItem[], word: string): Flag | undefined {
  return flagsOf(items).find((flag) => flag.flag === word);
}

/** Whether a bare flag word is written in the parens. */
export function hasFlag(items: ParenItem[], word: string): boolean {
  return flagOf(items, word) !== undefined;
}

/**
 * Whether the parens hold a payload that is an expression rather than text.
 * Only a condition takes one, so this is what separates `condition(a > b)` from
 * `error(OUT_OF_STOCK)` now that both are written the same way.
 */
export function hasExpressionPayload(items: ParenItem[]): boolean {
  return (
    payloadItemOf(items) !== undefined && payloadTextOf(items) === undefined
  );
}
