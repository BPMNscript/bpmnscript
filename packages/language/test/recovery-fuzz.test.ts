/**
 * Validation stays total on a broken document: no check crashes, and none
 * reports an element by a name the parser never filled in. A hand-written
 * table varies one axis per row (a keyword in an identifier slot reaches
 * different empty slots than a deleted token), so the corpus is mutated
 * mechanically instead: tokenized by the language's own lexer, then
 * substituted, duplicated and deleted at a fixed seed. Changing `SEED`
 * explores elsewhere; past roughly 150_000 mutants the documents the
 * validation helper retains exhaust the default heap, so a wider run wants
 * `NODE_OPTIONS=--max-old-space-size=8192`.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { AstUtils, EmptyFileSystem, GrammarAST } from 'langium';
import { validationHelper, type ValidationResult } from 'langium/test';
import type { Model } from '@bpmn-script/language';
import { createBpmnScriptServices } from '@bpmn-script/language';

import { withTextMessages } from './helpers/diagnostics.js';

const SEED = 0x5eed;
const MUTANTS = 2000;

/**
 * A mutant costs about 0.5ms warm and fifteen times that on a cold, contended
 * CPU; the budget only catches a runaway.
 */
const TIMEOUT_MS = MUTANTS * 30;

const FENCE = '`' + '`' + '`';

/**
 * Well-formed sources covering every construct a check reads a slot off. Where
 * the reader is a second construct referring to the first (a handler's trigger
 * is only printed when a `goto` crosses its boundary, a field's type only when
 * a `var` of the same name disagrees), the corpus carries the pair. A
 * substitution draws from the grammar's vocabulary and never reproduces an
 * identifier the source spells, so the last entry collides outright on all
 * three process-scoped duplicates, and its mutants reach the duplicate walks
 * with one half of each pair torn up.
 */
const CORPUS = [
  `process p { error E(code: "c", message: "m") start S throw error(E) }`,
  `process p { var a: number start S user U(label: "L", assignee: "x") { form { a: number } } end E }`,
  `process p { start S message("M") script K ${FENCE}js\nwork()\n${FENCE} end E terminate }`,
  `process p { error E start S user U on error(E, code: c) { step T } end E }`,
  `process p { start S call C(label: "L", process: "q") { in x out y } end E }`,
  `process p { var ls: json start S user U for 2 each l in ls sequentially until (a > 1) end E }`,
  `process p { escalation E start S throw escalation(E) }`,
  `process p { start S emit signal("S") await timer(at: "t") end E }`,
  `process p { start S user U { on start(class: "C") input a = [1] output b = { k: "v" } } end E }`,
  `process p { start S subprocess B { user U } goto U end E }`,
  `process p { start S subprocess B { goto Fin } user U end Fin }`,
  `process p { start S on error { step T } goto T end E }`,
  `process p { error E start S user U on error(E) { goto Fin } end Fin }`,
  `process p { start S if (a > 1) { user U } else { goto Fin } while (b) { step T } end Fin }`,
  `process p { start S parallel { { user U } { service V(topic: "t") } } end E }`,
  `process p { start S if (a) (asyncBefore: true, joinJobPriority: 20) { user U } parallel (jobPriority: 5, joinAsyncAfter: true) { { user V } { user W } } end E }`,
  `process p { start S send N(class: "C") receive R(message: "M") decide D(decision: "d") end E }`,
  `process p { start S { form { plan: enum "P" = "a" (required: true, validator: "V") { a "A" b property k = "v" } n: number (min: 1, max: "5") d: date (pattern: "yyyy") } } end E }`,
  `process p { error E start S service V(topic: "t", taskPriority: 42) { property k = "v" property j = "w" error E when externalTask.retries == 0 error E when "\${x}" } end F }`,
  `process p(label: "x", label: "y") { var a: number var a: number start S user U user U end E }`,
];

/** Park-Miller, so a failure names a mutant that replays, and free of the bitwise operators the lint config bans. */
function seededRandom(seed: number): () => number {
  const modulus = 2147483647;
  let state = seed % modulus;
  return () => {
    state = (state * 16807) % modulus;
    return state / modulus;
  };
}

let validate: (input: string) => Promise<ValidationResult<Model>>;
let vocabulary: string[];
let tokenize: (text: string) => string[];

beforeAll(() => {
  const services = createBpmnScriptServices(EmptyFileSystem).BpmnScript;
  validate = validationHelper<Model>(services);
  tokenize = (text) =>
    services.parser.Lexer.tokenize(text).tokens.map((t) => t.image);
  // Every keyword the grammar declares; the three terminal samples cannot be
  // read out of a regular expression, so they are the one hand-written part.
  const keywords = new Set<string>(['name', '"s"', '1']);
  for (const node of AstUtils.streamAllContents(services.Grammar)) {
    if (GrammarAST.isKeyword(node)) keywords.add(node.value);
  }
  vocabulary = [...keywords];
});

describe('Validation - recovery fuzz', () => {
  test(
    `survives ${MUTANTS} mutants of the corpus`,
    async () => {
      const random = seededRandom(SEED);
      const pick = <T>(xs: readonly T[]): T =>
        xs[Math.floor(random() * xs.length)]!;

      const failures: string[] = [];
      for (let i = 0; i < MUTANTS; i++) {
        const tokens = tokenize(pick(CORPUS));
        // Sometimes twice: a duplicate key built from two slots only collides
        // with itself once both halves are gone, which one edit cannot do.
        const edits = random() < 0.3 ? 2 : 1;
        for (let edit = 0; edit < edits; edit++) {
          const at = Math.floor(random() * tokens.length);
          const operation = random();
          if (operation < 0.5) {
            tokens[at] = pick(vocabulary);
          } else if (operation < 0.75) {
            tokens.splice(at, 0, tokens[at]!);
          } else {
            tokens.splice(at, 1);
          }
        }
        const mutant = tokens.join(' ');

        for (const { message } of withTextMessages(
          (await validate(mutant)).diagnostics,
        )) {
          if (
            message.startsWith('An error occurred during validation') ||
            message.includes('undefined')
          ) {
            failures.push(`${message}\n  <- ${mutant}`);
          }
        }
      }
      expect(failures).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
