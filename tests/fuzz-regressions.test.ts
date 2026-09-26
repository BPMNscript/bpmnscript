// Minimized shapes from fuzz finds, one row each: a fuzz run reaches a shape
// only while the generator still draws it, so each is pinned here.

import { describe, it, expect } from 'vitest';

import { xmlToIr, irToDsl } from '@bpmn-script/transform';
import type { BpmnProcess, FlowContainer } from '@bpmn-script/transform';

import { bpmnDoc } from './helpers/bpmn-doc.js';
import { printDsl, roundTrip, validate } from './helpers/pipeline.js';
import { compareModels, modelSignature } from './helpers/model-equivalence.js';
import type { ModelComparison } from './helpers/model-equivalence.js';

async function errorMessages(source: string) {
  const { diagnostics } = await validate(source);
  return diagnostics.filter((d) => d.severity === 1).map((d) => d.message);
}

// Shapes whose print depends on the order the model lists its elements and
// flows in: a goto into a loop body enters the cycle a second time, past its
// head, and a chain or a start walked first claims what follows it. The third
// element pins the exact class the reversed-order reread compares back to
// (see `compareModels`); a row with none keeps the model identical.
const ORDER_ROWS: [
  title: string,
  source: string,
  comparison?: ModelComparison,
][] = [
  [
    'a while inside an if branch whose body a goto after the if also enters prints as a while',
    `process order-fulfilment {
  if (true) {
    while (true) {
      emit message Tell4("Quote Received")
    }
  }
  goto Tell4
}`,
  ],
  [
    'a do-while nested in a while whose body a goto after the while also enters keeps its condition',
    `process claim-review {
  while (true) {
    do {
      await condition Wait("x\\"y" != "eu")
      receive Hold6
    } while (true)
  }
  goto Hold6
}`,
  ],
  [
    'a while in an else branch whose body a goto after the if also enters prints as a while',
    `process p {
  var c: any
  var x: any
  if (c) {
    user Z
  } else {
    while (x) {
      user A
      user B
    }
  }
  goto B
}`,
  ],
  [
    'a while in an else branch beside an empty then branch, entered again by a goto to its first task, prints as a while',
    `process p {
  var c: any
  var x: any
  if (c) {
  } else {
    while (x) {
      user A
      user B
    }
  }
  goto A
}`,
  ],
  [
    'a goto in a then branch into the body of a while in the else branch prints as a goto beside the while',
    `process p {
  var c: any
  var x: any
  if (c) {
    goto B
  } else {
    while (x) {
      user A
      user B
    }
  }
}`,
  ],
  [
    'an else-if branch entering a cycle past a step the then branch already printed keeps its chain, outside the await branch that jumps into it',
    `process onboarding {
  if (true) {
    step Archive
  } else if (true) {
    step Pack4
    goto Archive
  }
  await {
    timer(every: "R/PT1H") {
    }
    timer(at: "2027-01-01T00:00:00") {
      goto Pack4
    }
  }
}`,
    'canonical',
  ],
  [
    'a goto after an if back into a step in its nested else-if keeps the step in that branch',
    `process invoice_batch {
  if (true) {
    if (true) {
    } else if (true) {
      emit message Tell6("Cancelled")
    }
  }
  goto Tell6
}`,
  ],
  [
    'an else-if jumping back into a step in an earlier nested else-if leaves both ifs closing at their own joins',
    `process invoice_batch {
  if (true) {
    if (true) {
    } else if (true) {
      emit message Tell6("Cancelled")
    }
  }
  if (true) {
  } else if (true) {
    goto Tell6
  }
}`,
  ],
  [
    'a goto listed before a do-while into its body prints valid and stable',
    `process p {
  var c: any
  var x: any
  if (c) {
    goto B
  }
  do {
    user A
    user B
  } while (x)
}`,
  ],
  [
    'a goto listed before nested whiles into the inner body keeps the outer while as the loop',
    `process p {
  var x: any
  var y: any
  var c: any
  if (c) {
    goto B
  }
  while (x) {
    user A
    while (y) {
      user B
      user C
    }
  }
}`,
  ],
  [
    'a goto after nested whiles into the inner body keeps the inner loop a while',
    `process p {
  var x: any
  var y: any
  while (x) {
    user A
    while (y) {
      user B
      user C
    }
  }
  goto B
}`,
  ],
  [
    'a goto listed before nested do-whiles onto the inner first step keeps the outer do-while as the loop',
    `process p {
  var x: any
  var y: any
  var c: any
  if (c) {
    goto B
  }
  do {
    user A
    do {
      user B
      user C
    } while (y)
  } while (x)
}`,
  ],
  [
    'a goto listed before a do-while into the body of a while nested in it keeps the do-while as the loop',
    `process p {
  var x: any
  var y: any
  var c: any
  if (c) {
    goto B
  }
  do {
    user A
    while (y) {
      user B
      user C
    }
  } while (x)
}`,
  ],
  [
    'a goto listed before a while onto the first step of a do-while nested in it keeps the while as the loop',
    `process p {
  var x: any
  var y: any
  var c: any
  if (c) {
    goto B
  }
  while (x) {
    user A
    do {
      user B
      user C
    } while (y)
  }
}`,
  ],
  [
    'a goto listed before a do-while into an if branch in its body keeps the do-while as the loop',
    `process p {
  var x: any
  var c: any
  if (c) {
    goto B
  }
  do {
    user A
    if (c) {
      user B
    }
  } while (x)
}`,
  ],
  [
    'nested do-whiles whose bodies gotos enter from before and after both loops keep the outer do-while',
    `process p {
  var c: any
  var d: any
  var e: any
  var x: any
  var y: any
  var z: any
  if (c) {
    goto B
  }
  do {
    user A
    do {
      user B
      user C
    } while (y)
  } while (x)
  goto C
}`,
  ],
  [
    'an if whose goto enters a do-while body past its continue does not continue at the step inside the body',
    `process p {
  var c: any
  var d: any
  var x: any
  if (d) {
    goto B
  }
  do {
    user A
    if (c) {
      goto A
    }
    user B
  } while (x)
  user C
}`,
  ],
  [
    'a second start whose chain reaches the implicit end prints after the start ending on its own end',
    `process onboarding {
  start Start1
  end Done
  start Start10 signal("StockLow")
}`,
  ],
  [
    'a link throw and its catch opening the body keep the implicit end unwritten',
    `process invoice_batch {
  emit link("Retry")
  await link("Retry")
}`,
  ],
  [
    'a link throw and its catch opening a sub-process body keep its implicit end unwritten',
    `process invoice_batch {
  subprocess Sub {
    emit link("Rework")
    await link("Rework")
  }
}`,
  ],
  [
    'a branch chain that jumps back to its first step prints from that step',
    `process claim-review {
  if (true) {
  } else if (true) {
    service Release10(expression: order)
    await message("Quote Received")
    goto Release10
  }
  end Done11
}`,
    'canonical',
  ],
  [
    'a branch chain a parallel branch jumps into prints from its first step',
    `process onboarding {
  if (true) {
  } else if (true) {
    step Notify10
    throw message("Cancelled")
  } else {
    parallel {
      {
        goto Notify10
      }
      {
      }
    }
  }
  end Done22
}`,
    'canonical',
  ],
  [
    'a branch chain a later branch jumps into prints from its first step',
    `process onboarding {
  var c: any
  if (true) {
  } else if (true) {
    step Notify10
    throw message("Cancelled")
  } else {
    user Q
    if (c) {
      goto Notify10
    }
  }
  end Done22
}`,
    'canonical',
  ],
  [
    'a link catch two throws reach prints its chain from the catch',
    `process p {
  var c: any
  var x: any
  if (c) {
    emit link("L")
  } else if (x) {
    emit link("L")
  } else {
    end Done
  }
  end Fin
  await link("L")
  await {
    message("M") {
    }
    signal("S") {
    }
  }
  goto Fin
}`,
    'restructured',
  ],
  [
    'a triggered start whose chain ends in its own authored end prints ahead of a plain start whose chain runs on to the implicit one',
    `process p {
  start T message("M")
  step B
  end E2
  start S1
  user A
}`,
  ],
  [
    'two empty boundary handlers on the same host and trigger keep the base id on the first one printed',
    `process p {
  user A
  on A: signal("Ready") {
  }
  on A: signal("Shutdown") {
  }
}
`,
  ],
  [
    'two boundary handlers with bodies on the same host and trigger keep the base id on the first one printed',
    `process p {
  user A
  on A: signal("Ready") {
    user X
  }
  on A: signal("Shutdown") {
    user Y
  }
}
`,
  ],
  [
    'a while whose own exit jumps unconditioned into a nested while, with nothing after that ever reaches an end, prints the nested while inline',
    `process p {
  var c: any
  var x: any
  var y: any
  while (x) {
    user A
    if (c) {
      while (y) {
        user B
        user C
      }
    }
    user D
  }
  goto B
}`,
  ],
  [
    'the same unconditioned jump into a nested while, landing past its first step instead of at it, prints the nested while inline all the same',
    `process p {
  var c: any
  var x: any
  var y: any
  while (x) {
    user A
    if (c) {
      while (y) {
        user B
        user C
      }
    }
    user D
  }
  goto C
}`,
  ],
  [
    'a while whose own exit falls through two further tests before jumping back into its own body, with nothing after that ever reaches an end, prints both tests',
    `process p {
  var x: any
  var c: any
  var d: any
  while (x) {
    if (c) {
      user B
    }
    if (d) {
      user D
    }
    user E
  }
  if (c) {
    goto B
  }
  goto D
}`,
  ],
  [
    "a goto behind a guard after a do-while into the step its own nested if already reaches closes only the loop's exit route, not a nested do-while on the guard",
    `process p {
  var c: any
  var d: any
  var e: any
  var x: any
  do {
    user A
    if (c) {
      user B
      if (d) {
        user C
      }
    }
  } while (x)
  if (e) {
    goto C
  }
}`,
  ],
  [
    "a chain of gotos after three nested do-whiles into each loop's own last step prints as gotos, not further do-whiles nested on their merges",
    `process p {
  var c: any
  var d: any
  var x: any
  var y: any
  var z: any
  do {
    user A
    do {
      user B
      do {
        user C
        user D
      } while (z)
    } while (y)
  } while (x)
  if (c) {
    goto B
  } else if (d) {
    goto C
  }
  goto D
}`,
  ],
  [
    "the same chain with the innermost goto behind a guard still closes only the outer do-while's exit route, not a nested do-while on the guard",
    `process p {
  var c: any
  var d: any
  var e: any
  var x: any
  var y: any
  var z: any
  do {
    user A
    do {
      user B
      do {
        user C
        user D
      } while (z)
    } while (y)
  } while (x)
  if (c) {
    goto B
  } else if (d) {
    goto C
  }
  if (e) {
    goto D
  }
}`,
  ],
  [
    "a goto after a do-while into its own last step, beside the loop's continue back edge, prints as a goto and keeps the do-while's own test",
    `process p {
  var c: any
  var d: any
  var x: any
  do {
    user A
    if (c) {
      goto A
    }
    user B
  } while (x)
  if (d) {
    goto B
  }
}`,
  ],
  [
    "the same goto after a do-while, with a further step following it, still prints as a goto and keeps the do-while's own test",
    `process p {
  var c: any
  var d: any
  var x: any
  do {
    user A
    if (c) {
      goto A
    }
    user B
  } while (x)
  if (d) {
    goto B
  }
  user C
}`,
  ],
  [
    "a goto before a do-while into its continue's target keeps the do-while's own test and the elided end implicit",
    `process p {
  var c: any
  var d: any
  var x: any
  if (d) {
    goto B
  }
  do {
    user A
    if (c) {
      goto A
    }
    user B
  } while (x)
}`,
  ],
  [
    "the same goto before a do-while, with a further step inside the body after the second entry, still keeps the do-while's own test and the elided end implicit",
    `process p {
  var c: any
  var d: any
  var x: any
  if (d) {
    goto B
  }
  do {
    user A
    if (c) {
      goto A
    }
    user B
    user Q
  } while (x)
}`,
  ],
  [
    "a do-while opening its body on a sibling while, with a goto after it into the while's body, keeps its own test",
    `process p {
  var x: any
  var y: any
  do {
    while (y) {
      user B
    }
    user C
  } while (x)
  goto B
}`,
  ],
  [
    "a nested if's true route that skips its own merge and jumps into the outer if's first branch keeps that branch's edge into the outer join",
    `process order-fulfilment {
  if (true) {
    decide Approve(decision: "approve-claim")
  } else if (true) {
    if (true) {
      emit signal("Shutdown")
      goto Approve
    }
  }
  await {
    signal("Ready") {
    }
    condition(true) {
    }
  }
  end Done22
}`,
    'canonical',
  ],
  [
    'a do-while opening an if branch whose body a later goto enters mid-way stays valid and stable when the model is reversed',
    `process p {
  var c: any
  var x: any
  if (c) {
    do {
      user A
      user B
    } while (x)
    throw signal("S")
  }
  if (x) {
    goto B
  }
  end Done
}`,
  ],
  [
    'a do-while opening an if branch whose body an earlier goto enters mid-way stays valid and stable when the model is reversed',
    `process p {
  var c: any
  var d: any
  var x: any
  if (d) {
    goto B
  }
  if (c) {
    do {
      user A
      user B
    } while (x)
    throw signal("S")
  }
  end Done
}`,
  ],
  [
    'an if branch that only a later goto jumps back to prints inside the if, not after the implicit end',
    `process p {
  var c: any
  if (c) {
    user A
    goto Z
  } else if (c) {
    user B
    goto Z
  }
  user K
  if (c) {
    goto A
  }
  user Z
}`,
  ],
  [
    'a do-while opening an if branch that a later goto jumps back into keeps the step after it a goto',
    `process p {
  var c: any
  var x: any
  if (c) {
    do {
      user A
    } while (x)
    goto Z
  } else if (c) {
    user B
    goto Z
  }
  user K
  if (c) {
    goto A
  }
  user Z
}`,
  ],
  [
    'a do-while around a nested do-while that gotos enter from before and after keeps the outer loop',
    `process p {
  var d: any
  var e: any
  var x: any
  var y: any
  if (d) {
    goto C
  }
  do {
    user A
    do {
      user B
      user C
    } while (y)
  } while (x)
  if (e) {
    goto B
  }
}`,
    'restructured',
  ],
  [
    'a do-while around a while that gotos enter from before and after keeps both loops',
    `process p {
  var d: any
  var e: any
  var x: any
  var y: any
  if (d) {
    goto C
  }
  do {
    user A
    while (y) {
      user B
      user C
    }
  } while (x)
  if (e) {
    goto B
  }
}`,
  ],
  [
    'a do-while around a while that gotos enter at its body from before and after keeps both loops',
    `process p {
  var d: any
  var e: any
  var x: any
  var y: any
  if (d) {
    goto B
  }
  do {
    user A
    while (y) {
      user B
      user C
    }
  } while (x)
  if (e) {
    goto B
  }
}`,
  ],
  [
    'a do-while around a while opening an if branch keeps the outer loop when the else branch jumps into the inner body',
    `process p {
  var d: any
  var x: any
  var y: any
  if (d) {
    do {
      user A
      while (y) {
        user B
        user C
      }
    } while (x)
  } else {
    user Z
    goto B
  }
}`,
  ],
  [
    'a goto from a do-while back to the first step of the enclosing while body keeps the inner loop test as a condition',
    `process p {
  var c: any
  var x: any
  var y: any
  while (x) {
    user A
    do {
      user B
      if (c) {
        goto A
      }
      user C
    } while (y)
  }
}`,
    'restructured',
  ],
  [
    'a nested if branch that only a later goto jumps back to prints inside its if, not after the implicit end',
    `process p {
  var c: any
  var d: any
  if (c) {
    user A0
    if (d) {
      user A
      goto Z
    } else {
      user B
    }
    user M
  } else {
    user C
  }
  user K
  if (c) {
    goto A
  }
  user Z
}`,
  ],
  [
    'an if branch jumping to the first step of a while after it leaves that step in the loop',
    `process p {
  var d: any
  var e: any
  var x: any
  var y: any
  if (d) {
    goto A
  }
  while (x) {
    user A
    while (y) {
      user B
      user C
    }
  }
  if (e) {
    goto B
  }
}`,
  ],
  [
    'an if whose routes both reach a do-while head keeps its own merge when a goto after the loop has one too',
    `process p {
  var d: any
  var e: any
  var x: any
  var y: any
  if (d) {
    goto A
  }
  do {
    user A
    do {
      user B
      user C
    } while (y)
  } while (x)
  if (e) {
    goto B
  }
}`,
    'restructured',
  ],
  [
    'an if around a do-while keeps its own merge when a goto after the loop inside it has one too',
    `process p {
  var d: any
  var e: any
  var x: any
  var y: any
  if (d) {
    do {
      user A
      do {
        user B
        user C
      } while (y)
    } while (x)
    if (e) {
      goto B
    }
  }
}`,
    'restructured',
  ],
  [
    'a goto from a nested if into a while head after the if keeps the loop when a later goto enters the inner while',
    `process p {
  var c: any
  var d: any
  var e: any
  var x: any
  var y: any
  if (c) {
    user Q
    if (d) {
      goto A
    }
    user R
  } else {
    user S
  }
  while (x) {
    user A
    while (y) {
      user B
      user C
    }
  }
  if (e) {
    goto B
  }
}`,
  ],
  [
    'a goto from a nested if into a while head after the if keeps the loop when a later goto enters the inner while past its first step',
    `process p {
  var c: any
  var d: any
  var e: any
  var x: any
  var y: any
  if (c) {
    user Q
    if (d) {
      goto A
    }
    user R
  } else {
    user S
  }
  while (x) {
    user A
    while (y) {
      user B
      user C
    }
  }
  if (e) {
    goto C
  }
}`,
  ],
  [
    'a goto from a nested if into a while head after the if keeps the loop when a later goto enters the inner do-while',
    `process p {
  var c: any
  var d: any
  var e: any
  var x: any
  var y: any
  if (c) {
    user Q
    if (d) {
      goto A
    }
    user R
  } else {
    user S
  }
  while (x) {
    user A
    do {
      user B
      user C
    } while (y)
  }
  if (e) {
    goto B
  }
}`,
  ],
  [
    'a goto from a nested if into a while head after the if keeps the loop when a later goto enters the inner do-while past its first step',
    `process p {
  var c: any
  var d: any
  var e: any
  var x: any
  var y: any
  if (c) {
    user Q
    if (d) {
      goto A
    }
    user R
  } else {
    user S
  }
  while (x) {
    user A
    do {
      user B
      user C
    } while (y)
  }
  if (e) {
    goto C
  }
}`,
  ],
  [
    'a nested branch chain that every route out of the enclosing if runs into prints after that if',
    `process p {
  var c: any
  var d: any
  var e: any
  var x: any
  if (c) {
    user A0
    if (d) {
      user A
      user N
      goto Z
    } else {
      user B
    }
    user M
  } else {
    user C
  }
  user K
  goto A
  user Z
}`,
  ],
];

const ROWS: [title: string, source: string, comparison?: ModelComparison][] = [
  [
    'an else branch a boundary handler also jumps into stays owned by the branch, not hoisted behind the implicit end',
    `process claim-review {
  if (true) {
    call Call5(process: "invoice-approval")
  } else {
    service Release10(topic: "shipping")
    end Done
  }
  on Call5: escalation {
    goto Release10
  }
}`,
  ],
  [
    'a link pair inside an if branch prints inside the branch, and the implicit end stays unwritten',
    `process claim-review {
  if (true) {
    emit link("Skip")
    await link("Skip")
  }
}`,
  ],
  [
    "a link pair inside a subprocess's else branch prints inside it, and the subprocess end stays unwritten",
    `process order-fulfilment {
  subprocess Sub {
    if (true) {
    } else {
      emit link("Skip")
      await link("Skip")
    }
  }
}`,
  ],
  [
    "a link pair inside a transaction's branch prints inside it, beside a second link pair after the transaction",
    `process onboarding {
  attempt Try4 {
    if (true) {
      emit link("Rework")
      await link("Rework")
    }
  }
  emit link("Retry")
  await link("Retry")
}`,
  ],
  [
    "a link pair inside an event handler's branch prints inside the handler",
    `process claim-review {
  start Start
  on signal("Ready") {
    if (true) {
      emit link("Rework")
      await link("Rework")
    }
  }
}`,
  ],
  [
    'a link pair inside a boundary handler body prints inside the handler, not after the process end',
    `process p {
  var order: any
  step Host
  on Host: condition(order.paid) {
    emit link("L")
    await link("L")
    step A
  }
}`,
  ],
  [
    'a link pair inside a boundary handler body prints inside the handler when the process ends on an authored end',
    `process p {
  var order: any
  step Host
  end Fin
  on Host: condition(order.paid) {
    emit link("L")
    await link("L")
    step A
  }
}`,
  ],
  [
    'a link pair in the only branch that reaches the join prints inside that branch',
    `process p {
  var c: any
  if (c) {
    emit link("L")
    await link("L")
    step B
  } else {
    end Stop
  }
}`,
  ],
  [
    'a link pair whose catch runs through an await before the join of a branch beside an ending one prints inside that branch',
    `process order-fulfilment {
  if (true) {
    emit link("Retry")
    await link("Retry")
    await {
      message("OrderReceived") {
      }
      condition(urgent && order == null) {
      }
    }
  } else {
    end Done
  }
}`,
  ],
  [
    'a link pair whose catch runs through a while before the join of a branch beside an ending one prints inside that branch',
    `process p {
  var c: any
  var x: any
  if (c) {
    emit link("L")
    await link("L")
    while (x) {
      user A
    }
  } else {
    end Done
  }
}`,
  ],
  [
    'a link pair whose catch runs through a do-while before the join of a branch beside an ending one prints inside that branch',
    `process p {
  var c: any
  var x: any
  if (c) {
    emit link("L")
    await link("L")
    do {
      user A
    } while (x)
  } else {
    end Done
  }
}`,
  ],
  [
    'a link pair whose catch opens an if of its own prints inside the enclosing branch, whose join no goto can name',
    `process p {
  var c: any
  var x: any
  var y: any
  if (c) {
    emit link("L")
    await link("L")
    if (x) {
      step A
    } else {
      step B
    }
  }
  if (y) {
    step Z
  }
  end Done
}`,
  ],
  [
    'a goto back into a step whose only route to its test crosses a link pair prints in its goto form, not as a do-while',
    `process p {
  var c: any
  var x: any
  user Q
  if (c) {
    emit link("L")
    await link("L")
    if (x) {
      goto Q
    }
    user A
  } else {
    end Done
  }
}`,
  ],
  [
    'a parallel whose every branch ends prints as a parallel, not as if (true) jumps',
    `process invoice_batch {
  parallel {
    {
      end Done6
    }
    {
      await signal("Ready")
      end Done7
    }
  }
}`,
  ],
  [
    'a parallel whose ending branch holds a parallel of its own keeps the join the other branch runs into',
    `process claim-review {
  parallel {
    if (true) {
      step Release
    }
    else {
      parallel {
        if (true) {
        }
        {
        }
      }
      end Declined
    }
  }
  call Call(process: "payment-run")
  end Done
}`,
  ],
  [
    "a do-while nested in a do-while keeps the inner loop's back edge",
    `process invoice_batch {
  do {
    do {
      await message("OrderReceived")
    } while (true)
  } while (true)
  throw signal("StockLow")
}`,
  ],
  [
    'a parallel branch jumping to a step an earlier if branch owns prints the goto without entering that branch from outside',
    `process invoice_batch {
  if (true) {
    call Call(process: "payment-run")
    emit link("Rework")
    await link("Rework")
  }
  parallel {
    if (true) {
      call Call11(process: "invoice-approval")
    }
    {
      goto Call
    }
  }
  end Done16
}`,
  ],
  [
    'a conditional start after a parallel whose branches jump back or throw prints with no flow into the start',
    `process invoice_batch {
  error OUT_OF_STOCK(message: "Out of stock")

  call Call4(process: "payment-run")
  parallel {
    if (true) {
      goto Call4
    }
    else {
      throw error(OUT_OF_STOCK)
    }
  }
  start Start16 condition("\${retries > 4}")
}`,
  ],
  [
    'the var block keeps its order when a branch that reads a variable is printed elsewhere on the second pass',
    `process claim-review {
  if (true) {
    step Charge5 for each line in items
    end Done6
  } else if (true) {
    send Pack for each item in lines sequentially(type: "mail") {
      field to = "ops@example.com"
      field text = "Disk usage high"
    }
  }
  end Done16
}`,
  ],
  [
    "an empty if under a race's condition branch stays in that branch on the second pass",
    `process invoice_batch {
  emit link("Rework")
  await link("Rework")
  await {
    condition(order.total < -retries) {
      if (true) {
      }
      end Done11
    }
    signal("StockLow") {
    }
  }
  end Done13
}`,
  ],
  [
    'a loop inside a race branch that ends prints without a hand-repair comment on the second pass',
    `process onboarding {
  await {
    signal("Ready") {
    }
    condition(amount / 1.41 == (score)) {
      do {
        emit message("PaymentDone")
      } while (true)
      end Done3
    }
  }
  end Done
}`,
  ],
  [
    'an if whose branch step is jumped to after the block prints the same on the second pass (no else turning into a goto)',
    `process onboarding {
  if (true) {
    receive check-stock9
  }
  goto check-stock9
}`,
  ],
  [
    'two gotos into the true convergence print no empty else blocks, and the second pass matches the first',
    `process p {
  var x: any
  var y: any
  if (x) {
    goto B
  }
  step C
  if (y) {
    goto B
  }
  step B
  end Fin
}`,
  ],
  [
    'a join setting on an if with an empty branch applies on every route and survives the second print',
    `process onboarding {
  if (true) (joinAsyncAfter: true) {
  } else {
    await timer Wait6(at: "2027-01-01T00:00:00")
  }
  receive pay-out8
  goto pay-out8
}`,
  ],
  [
    'a race branch whose else-if jumps back before the race prints the same on the second pass',
    `process order-fulfilment {
  user Archive1
  await {
    timer("PT2H30M") {
    }
    signal("Shutdown") {
      if (true) {
      } else if (true) {
        send pay-out(type: "mail") {
          field to = "ops@example.com"
          field text = "Disk usage high"
        }
        goto Archive1
      }
    }
  }
  end Done18
}`,
  ],
  [
    'a nested if chain jumping to its own first branch prints no empty else on the second pass',
    `process onboarding {
  if (true) {
  } else if (true) {
    if (true) {
      receive Review13
    } else if (true) {
      service Check(class: "org.acme.Audit")
    }
    goto Review13
  }
  emit link("Retry")
  await link("Retry")
  end Done19
}`,
  ],
  [
    'a goto past a parallel join keeps its goto, so the empty branch does not enter the join',
    `process p {
  var c: any
  parallel {
    {
      if (c) {
        step A
      } else {
        goto X
      }
    }
    {
      step B
    }
  }
  step X
  end E
}`,
  ],
  [
    'a goto past an inclusive join keeps its goto, so the empty branch does not enter the join',
    `process p {
  var c: any
  var d: any
  parallel {
    if (d) {
      if (c) {
        step A
      } else {
        goto X
      }
    }
    {
      step B
    }
  }
  step X
  end E
}`,
  ],
  [
    'an ending race branch holding a nested race keeps its end on the second pass, the nested join is no continuation',
    `process claim-review {
  await {
    condition(6.69 - 4.26 <= amount) {
      await {
        condition(950 >= 9.22 ? approved : (order.paid)) {
        }
        condition(order == null) {
        }
      }
      end Done16
    }
    signal("Ready") {
    }
  }
  emit link("Retry")
  await link("Retry")
}`,
  ],
  [
    'an else branch reaching the step after the if through a merge another branch printed falls through with no goto',
    `process onboarding {
  if (true) {
    receive check-stock9
    end Done
  } else if (true) {
  } else {
    service Rate12(class: "org.acme.Audit")
  }
  goto check-stock9
}`,
  ],
  [
    'an if whose branch holds a nested if keeps its join settings and its branch step inside when the tail loops on itself',
    `process p {
  var c: any
  var d: any
  if (c) (joinAsyncBefore: true) {
    step A
    if (d) {
      end X1
    }
  }
  receive B
  goto B
}`,
  ],
  [
    'two sibling branches each jumping back to the same step print as gotos, not as nested loops',
    `process p {
  var x: any
  var y: any
  var z: any
  step A
  if (x) {
    step B
    if (y) {
      goto A
    }
  } else {
    step C
    if (z) {
      goto A
    }
  }
  step After
}`,
  ],
  [
    'a jump back on a route the split tests second keeps its place in the if chain instead of becoming a loop test',
    `process p {
  var a: any
  var b: any
  user A
  if (a) {
  } else if (b) {
    goto A
  }
}`,
  ],
  [
    'a boundary handler jumping into a while body leaves the loop printed as a while',
    `process p {
  var u: boolean
  while (u) {
    user A
    user B
  }
  user C
  on A: signal("R") {
    goto B
  }
}`,
  ],
  [
    'a do-while branch passing through two link pairs keeps the loop and its back edge',
    `process p {
  var a: boolean
  var c: boolean
  do {
    if (a) {
      emit link("R1")
      await link("R1")
      step X
      emit link("R2")
      await link("R2")
      step Y
    } else {
      step W
    }
  } while (c)
  end Done
}`,
  ],
  [
    'a link emitted inside a nested do-while inner body keeps both loops and leaves the outer link catch reachable',
    `process p {
  var u: any
  var v: any
  var a: boolean
  do {
    do {
      user A
      if (a) {
        emit link("R")
      }
      user B
    } while (v)
    user C
  } while (u)
  end Done
  await link("R")
  goto C
}`,
  ],
  [
    'an if whose else branch loops back keeps its join setting when its then branch is a nested if',
    `process p {
  var a: boolean
  var b: boolean
  user S
  if (a) (joinAsyncBefore: true) {
    if (b) {
      user B
    }
  } else {
    user W
    goto S
  }
}`,
  ],
  [
    'a nested if whose then branch ends keeps its join setting when the outer else jumps into that branch',
    `process p {
  var a: boolean
  var b: boolean
  user S
  if (a) {
    if (b) (joinAsyncAfter: true) {
      user R
      end Stop
    } else {
      user T
    }
    user U
  } else {
    goto R
  }
}`,
  ],
  [
    'an if at the tail of a while body keeps its join setting when its else jumps back to the body start',
    `process p {
  var a: boolean
  var b: boolean
  var c: boolean
  while (c) {
    user S
    if (a) (joinAsyncBefore: true) {
      if (b) {
        user B
      }
      user Q
    } else {
      user W
      goto S
    }
  }
}`,
  ],
  [
    'an if/else inside an await branch keeps its join setting on its own join rather than the await join',
    `process p {
  var a: boolean
  await {
    condition(a) {
      if (a) (joinAsyncBefore: true) {
      } else {
        emit message("OrderReceived")
      }
    }
    signal("Shutdown") {
      end Done
    }
  }
}`,
  ],
  [
    'an if with an empty branch and no else inside an await branch keeps its join setting on its own join rather than the await join',
    `process p {
  var a: boolean
  await {
    condition(a) {
      if (a) (joinAsyncBefore: true) {
      }
    }
    signal("Shutdown") {
      end Done
    }
  }
}`,
  ],
  [
    'an if whose other branch throws continues at its one-in join rather than inside the live branch',
    `process claim-review {
  escalation NEEDS_REVIEW

  if (true) {
    receive Rate
  } else {
    decide Hold6(expression: "#{order.go()}")
    throw escalation(NEEDS_REVIEW)
  }
  throw message("Quote Received")
}`,
  ],
  [
    'an else-if jumping back above the enclosing parallel leaves the statement after the if outside the if',
    `process invoice_batch {
  call Call5(process: "invoice-approval")
  parallel {
    {
      if (true) {
      } else if (true) {
        goto Call5
      }
      await condition(false && !order['le'])
    }
    {
    }
  }
}`,
  ],
  [
    'a parallel whose other branch ends continues at its own one-in join after a nested parallel in the live branch',
    `process order-fulfilment {
  parallel {
    if (true) {
      parallel {
        {
        }
        {
          end Done
        }
      }
    }
    else {
      service Hold9(class: "org.acme.Audit")
      end Done10
    }
  }
  end Done11
}`,
  ],
  [
    'a goto from an outer else into a nested else-if leaves the join setting on the outer if',
    `process claim-review {
  if (true) (joinAsyncAfter: true) {
    if (true) {
    } else if (true) {
      user check-stock6(formRef: "payout-approval", binding: deployment)
    }
  } else {
    goto check-stock6
  }
}`,
  ],
  [
    'a nested else-if entered by a goto from the outer else keeps its own join when its other branch ends',
    `process p {
  if (true) (joinAsyncAfter: true) {
    if (true) {
      user F
      end Done
    } else if (true) {
      user U
    }
  } else {
    goto U
  }
  user C
}`,
  ],
  [
    'an if whose branch a goto after the if re-enters prints no else on the first pass',
    `process p {
  if (true) {
    step P
    parallel {
      if (true) {
      }
      if (true) {
      }
    }
  }
  goto P
}`,
  ],
  [
    'a parallel whose branch jumps back above it does not take the nested parallel in its other branch as its join',
    `process p {
  user A
  parallel {
    {
      parallel {
        {
          user B
        }
        {
          user C
        }
      }
      end E
    }
    {
      user X
      goto A
    }
  }
}`,
  ],
  [
    'a link throw ending a nested branch keeps its catch after the nested if when the catch runs on to the outer join',
    `process p {
  var c: any
  var d: any
  if (c) {
    if (d) {
      user A
    } else {
      user R
      emit link("Retry")
    }
    goto A
    await link At("Retry")
    user T
  } else {
    user S
  }
}`,
  ],
  [
    'a nested branch jumping back above the block prints inside the branch, leaving the implicit end at the tail',
    `process p {
  var x: any
  await condition Wait(x)
  if (true) {
    if (true) {
      step Rate
      goto Wait
    } else if (true) {
    }
    await {
      timer("PT1H") {
      }
      message("Cancelled") {
      }
    }
  }
}`,
  ],
  [
    'a do-while opening a branch that ends on a throw prints inside the branch',
    `process invoice_batch {
  if (true) {
    do {
      service Release2(delegate: "\${shipDelegate}")
    } while (true)
    throw signal("Shutdown")
  }
  end Done12
}`,
  ],
  [
    'a goto from an if into the do-while right after it, with the process ending on the implicit end, keeps that end implicit',
    `process p {
  var c: any
  var x: any
  if (c) {
    goto A
  }
  do {
    user A
    user B
  } while (x)
}`,
  ],
  [
    'a goto from an if into a cycle a later if also jumps back into prints the same on the next pass',
    `process p {
  var c: any
  var d: any
  if (d) {
    goto B
  }
  user A
  if (c) {
    user B
  }
  user C
  goto A
}`,
  ],
  [
    'a step an await branch jumps to, in an else-if branch before the await, prints outside the await',
    `process onboarding {
  if (true) {
  } else if (true) {
    step Notify10
    throw message("Cancelled")
  } else {
    await {
      signal("Ready") {
        goto Notify10
      }
      message("OrderReceived") {
      }
    }
  }
  end Done22
}`,
  ],
  [
    'a step a parallel branch jumps to prints in the nested else-if branch that also enters it',
    `process claim-review {
  if (true) {
    if (true) {
    } else if (true) {
      decide Charge4(decision: "approve-claim")
      end Done5
    }
  } else {
    parallel {
      if (true) {
        goto Charge4
      }
      {
      }
    }
  }
}`,
  ],
  [
    "a step a nested if's branch jumps to prints in the outer else branch that jumps to it and ends on its own",
    `process p {
  if (true) {
    if (true) {
      user Review
      end Done
    }
  } else {
    user Approve
    goto Review
  }
}`,
  ],
  [
    'a step in a while body that a later parallel branch jumps to prints in the while body',
    `process invoice_batch {
  while (true) {
    if (true) {
      script Record3 \`\`\`feel
      if (a) { b } else { c }
      \`\`\`
      goto Record3
    }
  }
  parallel {
    if (true) {
    }
    if (true) {
      goto Record3
    }
  }
}`,
  ],
  [
    'a step an await branch in the next else-if jumps to prints outside the await',
    `process order-fulfilment {
  if (true) {
    send Ship4(expression: "\${bean.run(execution)}")
    end Done13
  } else if (true) {
    await {
      signal("Shutdown") {
      }
      condition(("\${fn(\\"a\\")}") == score / score) {
        goto Ship4
      }
    }
  }
  end Done27
}`,
  ],
  [
    'a goto from an await branch into the body of a while after the await prints as a goto beside the while',
    `process p {
  var x: any
  await {
    timer(at: "2027-01-01T00:00:00") {
      goto B
    }
    message("M") {
      user Z
    }
  }
  while (x) {
    user A
    user B
  }
}`,
  ],
  [
    'a goto from an await branch into the body of a do-while after the await prints as a goto beside the do-while',
    `process p {
  var x: any
  await {
    timer(at: "2027-01-01T00:00:00") {
      goto B
    }
    message("M") {
      user Z
    }
  }
  do {
    user A
    user B
  } while (x)
}`,
  ],
  [
    'a goto from an await branch into a do-while nested in a later do-while prints as a goto beside the loops',
    `process p {
  var c: any
  var d: any
  var e: any
  var x: any
  var y: any
  var z: any
  await {
    timer(at: "2027-01-01T00:00:00") {
      goto C
    }
    message("M") {
      user Z
    }
  }
  do {
    user A
    do {
      user B
      user C
    } while (y)
  } while (x)
}`,
  ],
  [
    'a start after an if that runs into the implicit end prints at the tail and keeps that end implicit',
    `process onboarding {
  var order: any
  if (true) {
    emit link("Rework")
    await link("Rework")
  } else {
    throw signal("Ready")
  }
  start Start18 condition(order.paid)
}`,
  ],
  [
    'a start after an if, entering a step that runs into the implicit end, prints before that step and keeps that end implicit',
    `process claim-review {
  var order: any
  if (true) {
    emit link("Retry")
    await link("Retry")
  } else {
    emit link("Rework")
    await link("Rework")
  }
  start Start19 condition(order.paid)
  service Review20(class: "com.example.Delegate")
}`,
  ],
  [
    'a start entering a step the chain before it still runs on to prints after a goto to that step',
    `process p {
  var c: any
  user A
  goto T
  start B condition(c)
  user T
}`,
  ],
  [
    "a nested if's own goto out of a parallel branch that ends on it stays a goto, not a walk into the step it names",
    `process p {
  var c: any
  parallel {
    {
      if (c) {
        user X
        goto N
      }
    }
    {
      user Q
    }
  }
  if (c) {
    user M
    user N
    end E1
  }
  user T
}`,
  ],
  [
    "a nested if's own goto out of an await branch that ends on it stays a goto, not a walk into the step it names",
    `process p {
  var c: any
  await {
    signal("Ready") {
      if (c) {
        user X
        goto N
      }
    }
    condition(c) {
      user Q
    }
  }
  if (c) {
    user M
    user N
    end E1
  }
  user T
}`,
  ],
  [
    'a step after an if that a nested if branch jumps to prints after the if, not inside the nested branch',
    `process p {
  var c: any
  if (c) {
    if (c) {
      user A
      goto G
    } else if (c) {
      user B
      goto A
    }
    user K
  } else {
    user L
  }
  user G
}`,
  ],
  [
    'a while opening an if branch whose body an earlier goto enters mid-way prints inside the branch',
    `process p {
  var c: any
  var d: any
  var x: any
  if (d) {
    goto B
  }
  if (c) {
    while (x) {
      user A
      user B
    }
    throw signal("S")
  }
  end Done
}`,
  ],
  [
    'an if branch a sibling jumps into prints inside the if, not after the implicit end',
    `process p {
  var c: any
  if (c) {
    user A
    goto G
  } else if (c) {
    user B
    goto A
  }
  user K
  user G
}`,
  ],
  [
    "a nested if branch a sibling jumps into prints inside it when the surrounding loop's back edge reaches the outer join",
    `process p {
  var c: any
  while (c) {
    user H
    if (c) {
      if (c) {
        user A
        goto H
      } else if (c) {
        user B
        goto A
      }
      user K
    } else {
      user L
    }
    user N
  }
}`,
  ],
  [
    "a nested if branch in a loop that a sibling jumps into prints inside it when it jumps straight to the outer if's join",
    `process p {
  var c: any
  while (c) {
    if (c) {
      if (c) {
        user A
        goto G
      } else if (c) {
        user B
        goto A
      }
      user K
    } else {
      user L
    }
    user G
  }
  user Z
}`,
  ],
  [
    'a step in an if branch that one later parallel branch jumps back to prints in the if branch',
    `process invoice_batch {
  if (true) {
    await message("OrderReceived")
    service Fetch5(type: "shell") {
      field command = "df"
    }
    end Done6
  }
  parallel {
    if (true) {
    }
    if (true) {
      goto Fetch5
    }
  }
}`,
  ],
  [
    "a step after an if that a do-while in one branch runs back into prints after the if, not inside the loop's branch",
    `process p {
  var c: any
  var x: any
  if (c) {
    do {
      user A
      user D
    } while (x)
    end E1
  } else if (c) {
    user B
    goto D
  }
  user K
  goto D
}`,
  ],
  ...ORDER_ROWS,
];

describe('every regression input is accepted by the validator', () => {
  it.each(ROWS.map(([title, source]) => [title, source] as const))(
    '%s',
    async (_title, source) => {
      expect(await errorMessages(source)).toEqual([]);
    },
  );
});

describe('round-trip regressions from minimized fuzz finds', () => {
  for (const [title, source] of ROWS) {
    it(title, async () => {
      const first = await roundTrip(source);
      expect(await errorMessages(first.dsl)).toEqual([]);
      expect(modelSignature(first.ir3)).toEqual(modelSignature(first.ir1));

      const second = await roundTrip(first.dsl);
      expect(second.dsl).toBe(first.dsl);
    });
  }
});

// A model from another tool lists its elements and flows in any order, so
// which chain, start or loop entry the printer takes first must not depend on
// it, nor move once the print is read back in statement order.
function reversed<C extends FlowContainer>(c: C): C {
  return {
    ...c,
    flowElements: c.flowElements
      .map((el) => (el.kind === 'subProcess' ? reversed(el) : el))
      .reverse(),
    sequenceFlows: c.sequenceFlows.toReversed(),
  };
}

describe('an order-dependent shape prints the same model, stable on the next pass, when the model lists its elements in reverse', () => {
  for (const [title, source, comparison = 'same'] of ORDER_ROWS) {
    it(title, async () => {
      const { ir1, ir2 } = await roundTrip(source);
      const dsl = printDsl(reversed(ir2));
      expect(await errorMessages(dsl)).toEqual([]);
      const { ir1: reread, dsl: next } = await roundTrip(dsl);
      expect(compareModels(ir1, reread)).toBe(comparison);
      expect(next).toBe(dsl);
    });
  }
});

// A plain reprint of the round-tripped IR, and the same with element and flow
// order reversed (standing in for a model authored by another tool); a row
// picks whichever mechanism its regression needs.
async function plain(source: string): Promise<BpmnProcess> {
  return (await roundTrip(source)).ir2;
}
async function reversedOrder(source: string): Promise<BpmnProcess> {
  return reversed((await roundTrip(source)).ir2);
}

// The printer writes no boundary id, so an authored one is minted afresh on
// the next compile: printed first, it would take its minted sibling's base
// id. No script source produces that id collision, so the XML is mutated
// after a first round trip instead.
async function mintedSiblingOrder(source: string): Promise<BpmnProcess> {
  const { xml } = await roundTrip(source);
  const { ir } = await xmlToIr(xml.replaceAll('Boundary_A_signal_2', 'MyB'));
  return reversed(ir);
}

// Two authored ids share no minted rank to order by, so nothing but the
// model's own listing order can settle a print between them.
async function modelListingOrder(source: string): Promise<BpmnProcess> {
  const { xml } = await roundTrip(source);
  const { ir } = await xmlToIr(
    xml
      .replaceAll('Boundary_A_signal_2', 'MyC')
      .replaceAll('Boundary_A_signal', 'MyB'),
  );
  return ir;
}

// Every row's print keeps every path the source keeps too, so a check that
// only compares reachable steps and conditions (as `ROWS`'s round-trip test
// does) would pass a misplaced print as readily as the right one; only the
// literal print, revalidated through the compiler, pins the regression.
const PRINTS_AS_WRITTEN: [
  title: string,
  source: string,
  produce: (source: string) => Promise<BpmnProcess>,
][] = [
  // The join spelled as an extra `else { goto After }` reads the same paths
  // reversed too.
  [
    'two sibling branches that each jump back before their if keep the join after the if in reverse order',
    `process p {
  var x: any
  var y: any
  var z: any
  user A
  if (x) {
    user B
    if (y) {
      goto A
    }
  } else {
    user C
    if (z) {
      goto A
    }
  }
  user After
}
`,
    reversedOrder,
  ],
  // The jump is the split's first conditioned route, the one a `do` test
  // needs, but the split sits inside a block opened after the jump target,
  // so the `while` would close the loop inside that block.
  [
    'a jump back above the enclosing parallel, tested first, stays a goto inside its branch',
    `process p {
  user Call5
  parallel {
    {
      if (true) {
        goto Call5
      } else if (true) {
      }
    }
    {
    }
  }
}
`,
    plain,
  ],
  [
    'a jump back above the enclosing if, tested first, stays a goto inside its branch',
    `process p {
  var a: any
  var t: any
  user C
  if (a) {
    if (t) {
      goto C
    } else if (t) {
    }
  } else {
    user B
  }
}
`,
    plain,
  ],
  [
    'a goto after a do-while back into a loop nested in its body keeps the do-while',
    `process p {
  var x: any
  var y: any
  do {
    user A
    while (y) {
      user B
      user C
    }
  } while (x)
  goto C
}
`,
    plain,
  ],
  [
    'a boundary handler with an authored id prints after its minted sibling on the same host and trigger',
    `process p {
  user A
  on A: signal("Ready") {
    user X
  }
  on A: signal("Shutdown") {
    user Y
  }
}
`,
    mintedSiblingOrder,
  ],
  [
    'two boundary handlers with authored ids on the same host and trigger keep their model order',
    `process p {
  user A
  on A: signal("Ready") {
    user X
  }
  on A: signal("Shutdown") {
    user Y
  }
}
`,
    modelListingOrder,
  ],
  // `Fail` and `X` are both authored, so inlining `step X  throw error Fail(E)`
  // re-derives the same ids either way: the authored-tail rule's reason to
  // hoist a chain behind the block does not apply here.
  [
    'a hoisted chain of named steps stays in its branch',
    `process p {
  error E
  var c: any
  if (c) {
    step X
    throw error Fail(E)
  } else if (c) {
    goto X
  }
  end Done
}
`,
    plain,
  ],
  // `B` is also entered by the ordinary flow after the outer `if`, through
  // the nested `if (c)`, so inlining `goto B`'s target there would print `B`
  // before the steps that flow into it the ordinary way.
  [
    'a goto stays a goto when the flow after its block also reaches the same target',
    `process p {
  var c: any
  var d: any
  if (d) {
    goto B
  }
  user A
  if (c) {
    user B
  }
  user C
  goto A
}
`,
    plain,
  ],
  // A step ahead of the boundary handler's own `goto` moves the re-entering
  // predecessor from the boundary event itself to a step it dominates; the
  // walk must still trace that step back to the boundary rather than treating
  // it as ordinary flow.
  [
    "a boundary handler's own goto does not push a branch entry out of the branch when a step comes before it",
    `process claim-review {
  if (true) {
    call Call5(process: "invoice-approval")
  } else {
    service Release10(topic: "shipping")
    end Done
  }
  on Call5: escalation {
    step H
    goto Release10
  }
}
`,
    plain,
  ],
];

describe('a printed regression re-parses and revalidates as written', () => {
  it.each(PRINTS_AS_WRITTEN)('%s', async (_title, source, produce) => {
    const printed = irToDsl(await produce(source));
    expect(printed.warnings).toEqual([]);
    expect(printed.source).toBe(source);
    expect(await errorMessages(printed.source)).toEqual([]);
  });
});

// Printed as a jump back, this loop reads the same paths, so the row contract
// alone would pass it: the print itself is the regression.
it('a boundary handler jumping into a do-while body leaves the loop printed as a do-while', async () => {
  const source = `process p {
  var u: any
  do {
    user A
    user B
  } while (u)
  user C
  on A: signal("R") {
    goto B
  }
}
`;
  const { dsl } = await roundTrip(source);
  expect(dsl).toBe(source);
  expect(await errorMessages(dsl)).toEqual([]);
});

// The source itself is refused (the validator counts the `emit link` as
// ending the branch even with its `await link` right behind it, so `user
// After` reads as unreachable there), so it is compiled without validation;
// only the print, which sinks `user After`
// into the branch that carries the live route, is checked.
it('an if whose only live branch crosses a link pair sinks the step after it into that branch', async () => {
  const source = `process p {
  var c: any
  var x: any
  if (c) {
    if (x) {
      emit link("L")
      await link("L")
      await {
        message("M") {
        }
        signal("S") {
        }
      }
    } else {
      end E
    }
    user After
  } else {
    end Done
  }
}`;
  const { dsl } = await roundTrip(source);
  expect(await errorMessages(dsl)).toEqual([]);
  const second = await roundTrip(dsl);
  expect(second.dsl).toBe(dsl);
});

// `goto X` after the unreachable `user Z` (dead code behind `end E`) is
// itself unreachable, so it must not count as a predecessor entering `X`
// from outside the branch. The source is refused for that dead code, not
// for the branch placement under test, so only the print is checked here.
it('an unreachable predecessor of a branch entry does not push its chain out of the branch', async () => {
  const source = `process p {
  var c: any
  if (c) {
    user X
    if (c) {
      end E1
    }
  } else {
    user W
  }
  user Y
  end E
  user Z
  goto X
}
`;
  const { dsl } = await roundTrip(source);
  expect(dsl).toBe(source);
});

// `wallStaysOff`'s `postDominates(entry, join)` branch keeps a nested if
// branch's entry from walling itself off when the entry is also every route
// out of the join: without it, a later `goto A` from past the outer if hoists
// `A` behind the implicit end instead of leaving it inside the nested if.
it('a nested if branch a later goto jumps back into stays inside the if, not hoisted behind the implicit end', async () => {
  const source = `process p {
  var c: any
  var d: any
  if (c) {
    if (d) {
      goto A
    }
  }
  user K
  user A
  user N
  user Z
}
`;
  const { dsl } = await roundTrip(source);
  expect(dsl).toBe(source);
  expect(await errorMessages(dsl)).toEqual([]);
});

// A nested do-while has two back-edge candidates sharing its head (the inner
// do's own test and the outer if's `goto B`), so `ownLoopTest` cannot name a
// single owner for the cycle; gating `headsEnteredPast` on that owner instead
// of the CFG's rank would drop the cycle there and let the walk pick the
// other if branch's flow to hold the loop instead.
it('an if whose branches both close on the same nested do-while keeps the loop in the else branch', async () => {
  const source = `process p {
  var d: any
  var e: any
  var x: any
  var y: any
  if (d) {
    do {
      user A
      do {
        user B
        user C
      } while (y)
    } while (x)
  } else {
    user Z
    goto B
  }
  if (e) {
    goto B
  }
}
`;
  const { dsl } = await roundTrip(source);
  expect(dsl).toBe(
    'process p {\n' +
      '  var d: any\n' +
      '  var e: any\n' +
      '  var x: any\n' +
      '  var y: any\n' +
      '  if (d) {\n' +
      '    goto A\n' +
      '  } else {\n' +
      '    user Z\n' +
      '    do {\n' +
      '      do {\n' +
      '        user B\n' +
      '        user C\n' +
      '      } while (y)\n' +
      '      if (x) {\n' +
      '        user A\n' +
      '        goto B\n' +
      '      }\n' +
      '    } while (e)\n' +
      '  }\n' +
      '}\n',
  );
  expect(await errorMessages(dsl)).toEqual([]);
});

// Both loops read the same paths whether nested or flattened to if/goto, so
// the row contract alone would pass this too: the print itself is the
// regression. The handler re-enters the outer body past the inner loop's
// test gateway, which must not stop that gateway from dominating the outer
// one's.
it('a boundary handler re-entering the outer body past a nested do-while leaves both loops printed as do-while', async () => {
  const source = `process p {
  var u: any
  var v: any
  do {
    do {
      user A
      user B
    } while (v)
    user C
  } while (u)
  user E
  on E: signal("R") {
    goto C
  }
}
`;
  const { dsl } = await roundTrip(source);
  expect(dsl).toBe(source);
  expect(await errorMessages(dsl)).toEqual([]);
});

// The generator cannot draw one gateway that both merges and splits, so this
// shape comes in as modeled XML: J joins two of F's routes and forks again.
// The script has no mixed gateway, so J prints as a join and a fork, which is
// why the path signature, counting gateways per route, is not compared.
const MIXED_JOIN = bpmnDoc(
  [
    '<bpmn:startEvent id="S" />',
    '<bpmn:parallelGateway id="F" />',
    '<bpmn:userTask id="A" />',
    '<bpmn:endEvent id="EA" />',
    '<bpmn:userTask id="B" />',
    '<bpmn:userTask id="C" />',
    '<bpmn:parallelGateway id="J" />',
    '<bpmn:userTask id="D" />',
    '<bpmn:userTask id="E" />',
    '<bpmn:endEvent id="ED" />',
    '<bpmn:endEvent id="EE" />',
    ...[
      ['S', 'F'],
      ['F', 'A'],
      ['A', 'EA'],
      ['F', 'B'],
      ['F', 'C'],
      ['B', 'J'],
      ['C', 'J'],
      ['J', 'D'],
      ['J', 'E'],
      ['D', 'ED'],
      ['E', 'EE'],
    ].map(
      ([from, to]) =>
        `<bpmn:sequenceFlow id="${from}_${to}" sourceRef="${from}" targetRef="${to}" />`,
    ),
  ].join('\n'),
);

it('a gateway that merges a fork with an ending branch and splits again prints as the parallel join followed by a parallel', async () => {
  const { ir } = await xmlToIr(MIXED_JOIN);
  const dsl1 = printDsl(ir);
  expect(dsl1).toBe(`process p {
  start S
  parallel {
    {
      user A
      end EA
    }
    {
      user B
    }
    {
      user C
    }
  }
  parallel {
    {
      user D
      end ED
    }
    {
      user E
      end EE
    }
  }
}
`);
  expect(await errorMessages(dsl1)).toEqual([]);
  const second = await roundTrip(dsl1);
  expect(second.dsl).toBe(dsl1);
});

// No script source lowers to this: the implicit start and a conditional start
// both enter T, which runs into the implicit end. A body opening with `start B`
// would have no implicit start, so the print must jump to T first.
it('an implicit start and a conditional start entering the same step keep both starts and the implicit end', async () => {
  const xml = bpmnDoc(
    [
      '<bpmn:startEvent id="StartEvent_p" />',
      '<bpmn:startEvent id="B"><bpmn:conditionalEventDefinition>' +
        '<bpmn:condition xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="bpmn:tFormalExpression">${c}</bpmn:condition>' +
        '</bpmn:conditionalEventDefinition></bpmn:startEvent>',
      '<bpmn:userTask id="T" />',
      '<bpmn:endEvent id="EndEvent_p" />',
      '<bpmn:sequenceFlow id="f1" sourceRef="StartEvent_p" targetRef="T" />',
      '<bpmn:sequenceFlow id="f2" sourceRef="B" targetRef="T" />',
      '<bpmn:sequenceFlow id="f3" sourceRef="T" targetRef="EndEvent_p" />',
    ].join('\n'),
  );
  const { ir } = await xmlToIr(xml);
  const dsl = printDsl(ir);
  expect(dsl).toBe(`process p {
  var c: any
  goto T
  start B condition(c)
  user T
}
`);
  expect(await errorMessages(dsl)).toEqual([]);
  const { ir1: reread, dsl: next } = await roundTrip(dsl);
  expect(compareModels(ir, reread)).toBe('restructured');
  expect(next).toBe(dsl);
});

// A link throw's catch prints right behind it with no `goto` between them
// (`emit link` / `await link`), so the flow the throw carried still runs on
// through the catch's own routes. `start C` enters the merge that chain
// reaches and `start B` enters the step past it, so both need their own
// `goto` closing that still-live flow first, the same as a start entering a
// step an ordinary fall-through chain already reaches.
it('a start entering a step reached only through a printed link hop keeps the flow closed with a goto', async () => {
  const xml = bpmnDoc(
    [
      '<bpmn:startEvent id="StartEvent_p" />',
      '<bpmn:startEvent id="B"><bpmn:conditionalEventDefinition>' +
        '<bpmn:condition xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="bpmn:tFormalExpression">${c}</bpmn:condition>' +
        '</bpmn:conditionalEventDefinition></bpmn:startEvent>',
      '<bpmn:startEvent id="C"><bpmn:conditionalEventDefinition>' +
        '<bpmn:condition xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="bpmn:tFormalExpression">${d}</bpmn:condition>' +
        '</bpmn:conditionalEventDefinition></bpmn:startEvent>',
      '<bpmn:userTask id="A" />',
      '<bpmn:intermediateThrowEvent id="Th"><bpmn:linkEventDefinition name="L" /></bpmn:intermediateThrowEvent>',
      '<bpmn:intermediateCatchEvent id="Ca"><bpmn:linkEventDefinition name="L" /></bpmn:intermediateCatchEvent>',
      '<bpmn:exclusiveGateway id="M" />',
      '<bpmn:userTask id="T" />',
      '<bpmn:endEvent id="EndEvent_p" />',
      '<bpmn:sequenceFlow id="f1" sourceRef="StartEvent_p" targetRef="A" />',
      '<bpmn:sequenceFlow id="f2" sourceRef="A" targetRef="Th" />',
      '<bpmn:sequenceFlow id="f3" sourceRef="Ca" targetRef="M" />',
      '<bpmn:sequenceFlow id="f4" sourceRef="M" targetRef="T" />',
      '<bpmn:sequenceFlow id="f5" sourceRef="T" targetRef="EndEvent_p" />',
      '<bpmn:sequenceFlow id="f6" sourceRef="B" targetRef="T" />',
      '<bpmn:sequenceFlow id="f7" sourceRef="C" targetRef="M" />',
    ].join('\n'),
  );
  const { ir } = await xmlToIr(xml);
  const dsl = printDsl(ir);
  expect(dsl).toBe(`process p {
  var c: any
  var d: any
  user A
  emit link Th("L")
  await link Ca("L")
  goto T
  start C condition(d)
  goto T
  start B condition(c)
  user T
}
`);
  expect(await errorMessages(dsl)).toEqual([]);
  const { ir1: reread, dsl: dsl2 } = await roundTrip(dsl);
  expect(compareModels(ir, reread)).toBe('restructured');
  // The round trip compiles the merge gateway away: three plain flows land on
  // `T` directly, so `Ca`'s own chain now reaches the elided end on its own.
  // The tail rule still has to treat that end as displaced, since `B` and `C`
  // reach it too, or this second print pushes `end EndEvent_p` off the tail
  // and prints it as a name the compiler refuses.
  expect(await errorMessages(dsl2)).toEqual([]);
  expect(dsl2).toBe(`process p {
  var c: any
  var d: any
  user A
  emit link Th("L")
  await link Ca("L")
  goto T
  start C condition(d)
  start B condition(c)
  user T
}
`);
  const { ir1: rereadAgain, dsl: dsl3 } = await roundTrip(dsl2);
  expect(compareModels(ir, rereadAgain)).toBe('restructured');
  expect(dsl3).toBe(dsl2);
});

// The elided end's own branch does nothing once the walk reaches the end
// itself: pushing a `goto` there instead would name a target the deferred
// `end` print has not reached yet, so the leftover edge into it degrades to
// the unstructured-region marker rather than a wrong jump. The deferred `end`
// still lands ahead of `start B` in the printed order.
it('a conditional start entering the elided end keeps the end printed before the start', async () => {
  const xml = bpmnDoc(
    [
      '<bpmn:startEvent id="StartEvent_p" />',
      '<bpmn:startEvent id="B"><bpmn:conditionalEventDefinition>' +
        '<bpmn:condition xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="bpmn:tFormalExpression">${c}</bpmn:condition>' +
        '</bpmn:conditionalEventDefinition></bpmn:startEvent>',
      '<bpmn:userTask id="A" />',
      '<bpmn:endEvent id="EndEvent_p" />',
      '<bpmn:sequenceFlow id="f1" sourceRef="StartEvent_p" targetRef="A" />',
      '<bpmn:sequenceFlow id="f2" sourceRef="A" targetRef="EndEvent_p" />',
      '<bpmn:sequenceFlow id="f3" sourceRef="B" targetRef="EndEvent_p" />',
    ].join('\n'),
  );
  const { ir } = await xmlToIr(xml);
  const printed = irToDsl(ir);
  expect(printed.source).toBe(`process p {
  var c: any
  user A
  end EndEvent_p
  start B condition(c)
  // unstructured region: hand-repair required (dropped edge into EndEvent_p)
}
`);
  expect(printed.warnings).toEqual([
    {
      elementId: 'EndEvent_p',
      category: 'droppedEdge',
      message:
        'The script has an unstructured region: a route the model takes has no ' +
        'form here and was left out. The marker comment where it belonged ' +
        'names the step it led to and is where hand-repair starts.',
    },
    {
      elementId: 'EndEvent_p',
      category: 'refusedStatement',
      message:
        'The name this step carries in the model is one the script keeps for ' +
        'the names it derives itself, so it draws an error when the source is ' +
        'read back. Rename the step in the model and print it again.',
    },
  ]);
});

// Minimized from a fuzz find: the `else if` branch's own `service Release19
// goto Wait14` chain is walked while deciding whether the first branch's own
// chain (`InFirst`, `Wait14`, the `parallel`, `Fail18`) can print inline. That
// walk must stop at every node the first branch's entry does not
// loop-dominate, or it follows the `parallel`'s `goto Charge7` exit past the
// nodes the branch owns and reads `Release19` as part of it. The row contract
// alone would pass the misplaced print too, since the model stays equivalent
// either way; the print itself is the regression.
it("a goto between an if-chain's branches does not pull the target branch's chain into the other branch's inline check", async () => {
  const source = `process p {
  var order: any
  var urgent: any
  var approved: any
  user Charge7
  if (order['div']) {
    user InFirst
    await message Wait14("OrderReceived") {
    }
    parallel {
      if ((order == null)) {
        call Call15(process: "invoice-approval")
        emit signal("Ready")
      }
      if (urgent) {
        service check-stock16(class: "org.acme.Audit")
        goto Charge7
      }
    }
    throw signal Fail18("StockLow")
  } else if (approved) {
    service Release19(class: "com.example.orders.Ship")
    goto Wait14
  } else {
    service Charge(class: "com.example.Delegate")
  }
  end Done21
}
`;
  const { dsl } = await roundTrip(source);
  expect(await errorMessages(dsl)).toEqual([]);
  expect(dsl).toBe(`process p {
  var approved: any
  var order: any
  var urgent: any
  user Charge7
  if (order["div"]) {
    user InFirst
    await message Wait14("OrderReceived")
    parallel {
      if ((order == null)) {
        call Call15(process: "invoice-approval")
        emit signal("Ready")
      }
      if (urgent) {
        service check-stock16(class: "org.acme.Audit")
        goto Charge7
      }
    }
    throw signal Fail18("StockLow")
  } else if (approved) {
    service Release19(class: "com.example.orders.Ship")
    goto Wait14
  } else {
    service Charge(class: "com.example.Delegate")
  }
  end Done21
}
`);
});
