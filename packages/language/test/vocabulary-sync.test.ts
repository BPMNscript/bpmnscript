/**
 * Two lists that have to agree with a list they cannot import.
 *
 * A TextMate grammar cannot read TypeScript, so its keyword alternation is a
 * second derivation of the keywords the parser reserves. It is generated into
 * `syntaxes/`, which is gitignored, so a stale copy never shows up in a diff.
 *
 * A trigger word and a listener event both follow `on`, so one word appearing
 * in both vocabularies would give `on <word>` two meanings.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import {
  CATCH_TRIGGERS,
  EMIT_TRIGGERS,
  END_TRIGGERS,
  EXECUTION_LISTENER_EVENTS,
  ON_TRIGGERS,
  START_TRIGGERS,
  TASK_LISTENER_EVENTS,
  THROW_TRIGGERS,
  createBpmnScriptServices,
  reservedWordsOf,
} from '@bpmn-script/language';

const TEXTMATE_GRAMMAR = fileURLToPath(
  new URL('../syntaxes/bpmn-script.tmLanguage.json', import.meta.url),
);

/** `\b(a|b|c)\b` from the generated `keyword.control` pattern. */
const ALTERNATION = /^\\b\((.*)\)\\b$/;

function textMateKeywords(): string[] {
  let raw;
  try {
    raw = readFileSync(TEXTMATE_GRAMMAR, 'utf8');
  } catch {
    throw new Error(
      `${TEXTMATE_GRAMMAR} is missing. It is generated and gitignored; run \`npm run langium:generate\`.`,
    );
  }
  const grammar = JSON.parse(raw) as {
    patterns: { name?: string; match?: string }[];
  };
  const keywordPattern = grammar.patterns.find((p) =>
    p.name?.startsWith('keyword.control'),
  );
  const match = keywordPattern?.match?.match(ALTERNATION);
  if (!match) {
    throw new Error(
      'No `keyword.control` alternation in the generated TextMate grammar.',
    );
  }
  return match[1]!.split('|').sort();
}

describe('lists that must not drift apart', () => {
  test('the editor highlights exactly the words the parser reserves', () => {
    const services = createBpmnScriptServices(EmptyFileSystem);
    const reserved = [...reservedWordsOf(services.BpmnScript.Grammar)].sort();
    expect(textMateKeywords()).toEqual(reserved);
  });

  test('no word is both a trigger a handler catches and an event a listener fires on', () => {
    const triggers = new Set<string>([
      ...ON_TRIGGERS,
      ...THROW_TRIGGERS,
      ...EMIT_TRIGGERS,
      ...CATCH_TRIGGERS,
      ...START_TRIGGERS,
      ...END_TRIGGERS,
    ]);
    const listenerEvents = [
      ...EXECUTION_LISTENER_EVENTS,
      ...TASK_LISTENER_EVENTS,
    ];
    expect(listenerEvents.filter((event) => triggers.has(event))).toEqual([]);
  });
});
