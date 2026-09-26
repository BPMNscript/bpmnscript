// Validation stays total on mutated documents: no check crashes and none names
// an element the parser never filled in. Past roughly 150_000 mutants the
// retained documents exhaust the default heap
// (`NODE_OPTIONS=--max-old-space-size=8192`).

import { beforeAll, describe, expect, test } from 'vitest';
import { AstUtils, EmptyFileSystem, GrammarAST } from 'langium';
import { validationHelper, type ValidationResult } from 'langium/test';
import type { Model } from '@bpmn-script/language';
import { createBpmnScriptServices } from '@bpmn-script/language';

import { withTextMessages } from './helpers/diagnostics.js';

const SEED = 0x5eed;
const MUTANTS = 2000;

/** Only catches a runaway: a mutant costs about 0.5ms warm, fifteen times that cold. */
const TIMEOUT_MS = MUTANTS * 30;

const FENCE = '`' + '`' + '`';

/**
 * Where a slot is only read back through a second construct (a `goto` crossing
 * a handler, a disagreeing `var`), the corpus carries the pair; the last entry
 * collides on all three process-scoped duplicates.
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

/** Park-Miller: seeded so a failure replays, and free of the bitwise operators the lint bans. */
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
  // The terminal samples cannot be read out of a regular expression.
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
