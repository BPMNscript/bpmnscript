import { describe, it, expect } from 'vitest';
import { astToIr } from '@bpmn-script/transform';
import { compareModels, type ModelComparison } from './model-equivalence.js';
import { parseToAst } from './pipeline.js';

const compile = async (source: string) => astToIr(await parseToAst(source));

// Each `changed` row swaps one part of this baseline.
const ifA = (then: string, otherwise: string): string => `  if (a) {
    step ${then}
  } else {
    step ${otherwise}
  }`;
const ifB = `  if (b) {
    step W
  }`;
const PARTS = [
  ifA('X', 'Y'),
  `  parallel {
    {
      step P1
    }
    {
      step P2
    }
  }`,
  '  step Z(asyncBefore: true)',
  ifB,
];
const withPart = (index: number, part: string): string =>
  `process p {
  var a: any
  var b: any
${PARTS.map((p, i) => (i === index ? part : p)).join('\n')}
}`;
const base = withPart(-1, '');

const joinSource = `process p {
  if (true) (joinAsyncAfter: true) {
  } else {
    await timer Wait(at: "2027-01-01T00:00:00")
  }
  receive Pay
  goto Pay
}`;

const swappedGotos = (then: string, otherwise: string): string => `process p {
  var a: any
  step X
  step Y
  if (a) {
    await signal("Foo")
    goto ${then}
  } else {
    await signal("Foo")
    goto ${otherwise}
  }
}`;

const table: [title: string, a: string, b: string, want: ModelComparison][] = [
  [
    'a single-quoted and a double-quoted JUEL string are canonical',
    `process p {
  var x: any
  if ("\${x == 'a'}") {
    step A
  }
}`,
    `process p {
  var x: any
  if (x == "a") {
    step A
  }
}`,
    'canonical',
  ],
  [
    'two unnamed events printed in the other order are canonical',
    `process p {
  parallel {
    {
      await signal("A")
    }
    {
      await signal("B")
    }
  }
}`,
    `process p {
  parallel {
    {
      await signal("B")
    }
    {
      await signal("A")
    }
  }
}`,
    'canonical',
  ],
  [
    'two event handlers printed in the other order are canonical',
    `process p {
  step A
  on signal("A") {
    step HA
  }
  on signal("B") {
    step HB
  }
}`,
    `process p {
  step A
  on signal("B") {
    step HB
  }
  on signal("A") {
    step HA
  }
}`,
    'canonical',
  ],
  [
    'a branch printed after its block and reached by goto is restructured',
    `process p {
  if (true) {
    receive Approve
    emit signal("Shutdown")
    end Done
  } else if (true) {
    emit signal("Shutdown")
  }
  emit link("Skip")
  await link("Skip")
  end Done19
  on signal("Ready") {
    step Handle
  }
}`,
    `process p {
  if (true) {
    goto Approve
  } else if (true) {
    emit signal("Shutdown")
  }
  emit link("Skip")
  receive Approve
  emit signal("Shutdown")
  end Done
  await link("Skip")
  end Done19
  on signal("Ready") {
    step Handle
  }
}`,
    'restructured',
  ],
  [
    'a do-while printed as an if with a backward goto is restructured',
    `process p {
  var x: any
  var y: any
  if (x) {
    step A
  } else if (y) {
    do {
      step B
      call Call(process: "run")
    } while (y)
    call Call8(process: "run")
  } else {
    goto Call
  }
}`,
    `process p {
  var x: any
  var y: any
  if (x) {
    step A
  } else if (y) {
    step B
    call Call(process: "run")
    if (y) {
      goto B
    } else {
      call Call8(process: "run")
    }
  } else {
    goto Call
  }
}`,
    'restructured',
  ],
  [
    'swapped if and else bodies are changed',
    base,
    withPart(0, ifA('Y', 'X')),
    'changed',
  ],
  [
    'a condition replaced by true is changed',
    base,
    withPart(3, ifB.replace('(b)', '(true)')),
    'changed',
  ],
  [
    'asyncBefore dropped from a step is changed',
    base,
    withPart(2, '  step Z'),
    'changed',
  ],
  [
    'a parallel printed as a sequence is changed',
    base,
    withPart(1, '  step P1\n  step P2'),
    'changed',
  ],
  [
    'an added else branch is changed',
    base,
    withPart(3, ifB.replace(/\}$/, '} else {\n    step W2\n  }')),
    'changed',
  ],
  [
    "a route that skips an if's joinAsyncAfter join is changed",
    joinSource,
    `process p {
  if (true) (joinAsyncAfter: true) {
  } else {
    goto Wait
  }
  receive Pay
  goto Pay
  await timer Wait(at: "2027-01-01T00:00:00")
  goto Pay
}`,
    'changed',
  ],
  [
    'two identical unnamed events whose gotos are swapped are changed',
    swappedGotos('X', 'Y'),
    swappedGotos('Y', 'X'),
    'changed',
  ],
];

describe('compareModels', () => {
  it.each(table)('%s', async (_title, a, b, want) => {
    expect(compareModels(await compile(a), await compile(b))).toBe(want);
  });
});
