/**
 * The CFG analysis over a table of control-flow graphs.
 *
 * The module is pure graph machinery with no DSL knowledge: it builds a
 * control-flow graph from a {@link BpmnProcess}, computes dominators and
 * post-dominators, and answers the dominance / back-edge queries the
 * restructuring pattern catalog needs. Each row pins the complete analysis of
 * one graph, so a spurious relation fails as loudly as a missing one. Rows
 * sharing an oracle assert an equivalence: the exclusive and the parallel
 * diamond, the intermediate catch and the intermediate throw.
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeCfg,
  VIRTUAL_ENTRY,
  VIRTUAL_EXIT,
} from '../src/cfg-analysis.js';
import type { BpmnProcess, FlowElement } from '../src/ir/types.js';
import {
  boundaryEvent,
  edge,
  errorDef,
  gateway,
  messageDef,
  minimalProcess,
  signalDef,
  typedEvent,
} from './helpers/ir-fixtures.js';

const start = (id: string): FlowElement => ({ kind: 'startEvent', id });
const end = (id: string): FlowElement => ({ kind: 'endEvent', id });
const task = (id: string): FlowElement => ({ kind: 'userTask', id });
const parallel = (id: string): FlowElement => ({ kind: 'parallelGateway', id });

/**
 * A process from its nodes and a whitespace-separated `source>target` list.
 * An edge naming an undeclared element is a typo in the fixture, and would
 * otherwise be dropped without a trace by the analysis itself.
 */
function graph(flowElements: FlowElement[], edges: string): BpmnProcess {
  const declared = new Set(flowElements.map((e) => e.id));
  return minimalProcess(
    flowElements,
    edges.split(/\s+/).map((spec) => {
      const [source, target] = spec.split('>');
      if (!declared.has(source) || !declared.has(target)) {
        throw new Error(`edge "${spec}" names an undeclared element`);
      }
      return edge(source, target);
    }),
  );
}

/**
 * Every answer the analysis gives about one graph: a line per node in element
 * order, framed by the two sentinels, then the back-edge list. `dom` and
 * `pdom` are the full dominator and post-dominator sets, which is where an
 * unreachable node shows as dominated by nothing at all, itself included.
 */
function describeCfg(process: BpmnProcess): string[] {
  const cfg = analyzeCfg(process);
  const ids = [
    VIRTUAL_ENTRY,
    ...process.flowElements.map((e) => e.id),
    VIRTUAL_EXIT,
  ];
  const name = (id: string | undefined) =>
    id === VIRTUAL_ENTRY ? 'ENTRY' : id === VIRTUAL_EXIT ? 'EXIT' : (id ?? '-');
  const list = (of: string[]) =>
    of.length === 0 ? '-' : of.map(name).join(',');

  return [
    ...ids.map((id) =>
      [
        name(id),
        `in=${list(cfg.incoming(id))}`,
        `out=${list(cfg.outgoing(id))}`,
        `idom=${name(cfg.immediateDominator(id))}`,
        `ipdom=${name(cfg.immediatePostDominator(id))}`,
        `dom=${list(ids.filter((a) => cfg.dominates(a, id)))}`,
        `pdom=${list(ids.filter((a) => cfg.postDominates(a, id)))}`,
      ].join(' '),
    ),
    `back-edges=${list(cfg.backEdges().map((f) => f.id))}`,
  ];
}

const DIAMOND_EDGES = 'start>split split>A split>B A>join B>join join>end';

/** Shared by the exclusive and the parallel diamond. */
const DIAMOND = [
  'ENTRY in=- out=start idom=- ipdom=start dom=ENTRY pdom=ENTRY,start,split,join,end,EXIT',
  'start in=ENTRY out=split idom=ENTRY ipdom=split dom=ENTRY,start pdom=start,split,join,end,EXIT',
  'split in=start out=A,B idom=start ipdom=join dom=ENTRY,start,split pdom=split,join,end,EXIT',
  'A in=split out=join idom=split ipdom=join dom=ENTRY,start,split,A pdom=A,join,end,EXIT',
  'B in=split out=join idom=split ipdom=join dom=ENTRY,start,split,B pdom=B,join,end,EXIT',
  'join in=A,B out=end idom=split ipdom=end dom=ENTRY,start,split,join pdom=join,end,EXIT',
  'end in=join out=EXIT idom=join ipdom=EXIT dom=ENTRY,start,split,join,end pdom=end,EXIT',
  'EXIT in=end out=- idom=end ipdom=- dom=ENTRY,start,split,join,end,EXIT pdom=EXIT',
  'back-edges=-',
];

const INTERMEDIATE_EVENT_EDGES = 'start>task task>node node>end';

/** Shared by the intermediate catch and the intermediate throw. */
const INTERMEDIATE_EVENT = [
  'ENTRY in=- out=start idom=- ipdom=start dom=ENTRY pdom=ENTRY,start,task,node,end,EXIT',
  'start in=ENTRY out=task idom=ENTRY ipdom=task dom=ENTRY,start pdom=start,task,node,end,EXIT',
  'task in=start out=node idom=start ipdom=node dom=ENTRY,start,task pdom=task,node,end,EXIT',
  'node in=task out=end idom=task ipdom=end dom=ENTRY,start,task,node pdom=node,end,EXIT',
  'end in=node out=EXIT idom=node ipdom=EXIT dom=ENTRY,start,task,node,end pdom=end,EXIT',
  'EXIT in=end out=- idom=end ipdom=- dom=ENTRY,start,task,node,end,EXIT pdom=EXIT',
  'back-edges=-',
];

const CASES: [title: string, process: BpmnProcess, expected: string[]][] = [
  [
    'an exclusive diamond: the split dominates both branches and the join, the join post-dominates the split, and no edge is a back-edge',
    graph(
      [
        start('start'),
        gateway('split'),
        task('A'),
        task('B'),
        gateway('join'),
        end('end'),
      ],
      DIAMOND_EDGES,
    ),
    DIAMOND,
  ],
  [
    'a parallel diamond yields the identical relations: the analysis is gateway-agnostic',
    graph(
      [
        start('start'),
        parallel('split'),
        task('A'),
        task('B'),
        parallel('join'),
        end('end'),
      ],
      DIAMOND_EDGES,
    ),
    DIAMOND,
  ],
  [
    'a pre-test loop reports exactly the body->head back-edge, whose target dominates its source',
    graph(
      [start('start'), gateway('head'), task('body'), task('exit'), end('end')],
      'start>head head>body head>exit body>head exit>end',
    ),
    [
      'ENTRY in=- out=start idom=- ipdom=start dom=ENTRY pdom=ENTRY,start,head,exit,end,EXIT',
      'start in=ENTRY out=head idom=ENTRY ipdom=head dom=ENTRY,start pdom=start,head,exit,end,EXIT',
      'head in=start,body out=body,exit idom=start ipdom=exit dom=ENTRY,start,head pdom=head,exit,end,EXIT',
      'body in=head out=head idom=head ipdom=head dom=ENTRY,start,head,body pdom=head,body,exit,end,EXIT',
      'exit in=head out=end idom=head ipdom=end dom=ENTRY,start,head,exit pdom=exit,end,EXIT',
      'end in=exit out=EXIT idom=exit ipdom=EXIT dom=ENTRY,start,head,exit,end pdom=end,EXIT',
      'EXIT in=end out=- idom=end ipdom=- dom=ENTRY,start,head,exit,end,EXIT pdom=EXIT',
      'back-edges=Flow_body_head',
    ],
  ],
  [
    'a process with two ends is post-dominated by the virtual exit, never by either real end',
    graph(
      [start('start'), gateway('split'), end('end1'), end('end2')],
      'start>split split>end1 split>end2',
    ),
    [
      'ENTRY in=- out=start idom=- ipdom=start dom=ENTRY pdom=ENTRY,start,split,EXIT',
      'start in=ENTRY out=split idom=ENTRY ipdom=split dom=ENTRY,start pdom=start,split,EXIT',
      'split in=start out=end1,end2 idom=start ipdom=EXIT dom=ENTRY,start,split pdom=split,EXIT',
      'end1 in=split out=EXIT idom=split ipdom=EXIT dom=ENTRY,start,split,end1 pdom=end1,EXIT',
      'end2 in=split out=EXIT idom=split ipdom=EXIT dom=ENTRY,start,split,end2 pdom=end2,EXIT',
      'EXIT in=end1,end2 out=- idom=split ipdom=- dom=ENTRY,start,split,EXIT pdom=EXIT',
      'back-edges=-',
    ],
  ],
  [
    'an irreducible cycle entered from outside at both nodes reports no back-edge, because neither node dominates the other',
    graph(
      [start('start'), task('A'), task('B'), end('end')],
      'start>A start>B A>B B>A A>end B>end',
    ),
    [
      'ENTRY in=- out=start idom=- ipdom=start dom=ENTRY pdom=ENTRY,start,end,EXIT',
      'start in=ENTRY out=A,B idom=ENTRY ipdom=end dom=ENTRY,start pdom=start,end,EXIT',
      'A in=start,B out=B,end idom=start ipdom=end dom=ENTRY,start,A pdom=A,end,EXIT',
      'B in=start,A out=A,end idom=start ipdom=end dom=ENTRY,start,B pdom=B,end,EXIT',
      'end in=A,B out=EXIT idom=start ipdom=EXIT dom=ENTRY,start,end pdom=end,EXIT',
      'EXIT in=end out=- idom=end ipdom=- dom=ENTRY,start,end,EXIT pdom=EXIT',
      'back-edges=-',
    ],
  ],
  [
    'a node the start event cannot reach has no immediate dominator and is dominated by nothing, itself included',
    graph(
      [start('start'), task('reachable'), task('orphan'), end('end')],
      'start>reachable reachable>end orphan>end',
    ),
    [
      'ENTRY in=- out=start idom=- ipdom=start dom=ENTRY pdom=ENTRY,start,reachable,end,EXIT',
      'start in=ENTRY out=reachable idom=ENTRY ipdom=reachable dom=ENTRY,start pdom=start,reachable,end,EXIT',
      'reachable in=start out=end idom=start ipdom=end dom=ENTRY,start,reachable pdom=reachable,end,EXIT',
      'orphan in=- out=end idom=- ipdom=end dom=- pdom=orphan,end,EXIT',
      'end in=reachable,orphan out=EXIT idom=reachable ipdom=EXIT dom=ENTRY,start,reachable,end pdom=end,EXIT',
      'EXIT in=end out=- idom=end ipdom=- dom=ENTRY,start,reachable,end,EXIT pdom=EXIT',
      'back-edges=-',
    ],
  ],
  [
    'two loops report both back-edges in sequenceFlows order, not in discovery order',
    graph(
      [
        start('start'),
        gateway('head1'),
        task('body1'),
        gateway('head2'),
        task('body2'),
        end('end'),
      ],
      // Loop 2's back-edge is listed before loop 1's, so it must come out first.
      'start>head1 head1>body1 body2>head2 body1>head1 head1>head2 head2>body2 head2>end',
    ),
    [
      'ENTRY in=- out=start idom=- ipdom=start dom=ENTRY pdom=ENTRY,start,head1,head2,end,EXIT',
      'start in=ENTRY out=head1 idom=ENTRY ipdom=head1 dom=ENTRY,start pdom=start,head1,head2,end,EXIT',
      'head1 in=start,body1 out=body1,head2 idom=start ipdom=head2 dom=ENTRY,start,head1 pdom=head1,head2,end,EXIT',
      'body1 in=head1 out=head1 idom=head1 ipdom=head1 dom=ENTRY,start,head1,body1 pdom=head1,body1,head2,end,EXIT',
      'head2 in=body2,head1 out=body2,end idom=head1 ipdom=end dom=ENTRY,start,head1,head2 pdom=head2,end,EXIT',
      'body2 in=head2 out=head2 idom=head2 ipdom=head2 dom=ENTRY,start,head1,head2,body2 pdom=head2,body2,end,EXIT',
      'end in=head2 out=EXIT idom=head2 ipdom=EXIT dom=ENTRY,start,head1,head2,end pdom=end,EXIT',
      'EXIT in=end out=- idom=end ipdom=- dom=ENTRY,start,head1,head2,end,EXIT pdom=EXIT',
      'back-edges=Flow_body2_head2,Flow_body1_head1',
    ],
  ],
  [
    'a boundary event is a second entry: the virtual entry dominates it and it dominates its whole escape chain',
    graph(
      [
        start('start'),
        task('main'),
        end('end'),
        boundaryEvent('Boundary_main_error', 'main', errorDef()),
        task('escapeA'),
        end('escapeEnd'),
      ],
      'start>main main>end Boundary_main_error>escapeA escapeA>escapeEnd',
    ),
    [
      'ENTRY in=- out=start,Boundary_main_error idom=- ipdom=EXIT dom=ENTRY pdom=ENTRY,EXIT',
      'start in=ENTRY out=main idom=ENTRY ipdom=main dom=ENTRY,start pdom=start,main,end,EXIT',
      'main in=start out=end idom=start ipdom=end dom=ENTRY,start,main pdom=main,end,EXIT',
      'end in=main out=EXIT idom=main ipdom=EXIT dom=ENTRY,start,main,end pdom=end,EXIT',
      'Boundary_main_error in=ENTRY out=escapeA idom=ENTRY ipdom=escapeA dom=ENTRY,Boundary_main_error pdom=Boundary_main_error,escapeA,escapeEnd,EXIT',
      'escapeA in=Boundary_main_error out=escapeEnd idom=Boundary_main_error ipdom=escapeEnd dom=ENTRY,Boundary_main_error,escapeA pdom=escapeA,escapeEnd,EXIT',
      'escapeEnd in=escapeA out=EXIT idom=escapeA ipdom=EXIT dom=ENTRY,Boundary_main_error,escapeA,escapeEnd pdom=escapeEnd,EXIT',
      'EXIT in=end,escapeEnd out=- idom=ENTRY ipdom=- dom=ENTRY,EXIT pdom=EXIT',
      'back-edges=-',
    ],
  ],
  [
    'an if/else inside an escape chain keeps a clean split/join pair',
    graph(
      [
        start('start'),
        task('main'),
        end('end'),
        boundaryEvent('Boundary_main_error', 'main', errorDef()),
        gateway('splitB'),
        task('branchA'),
        task('branchB'),
        gateway('joinB'),
        end('endB'),
      ],
      'start>main main>end Boundary_main_error>splitB splitB>branchA splitB>branchB branchA>joinB branchB>joinB joinB>endB',
    ),
    [
      'ENTRY in=- out=start,Boundary_main_error idom=- ipdom=EXIT dom=ENTRY pdom=ENTRY,EXIT',
      'start in=ENTRY out=main idom=ENTRY ipdom=main dom=ENTRY,start pdom=start,main,end,EXIT',
      'main in=start out=end idom=start ipdom=end dom=ENTRY,start,main pdom=main,end,EXIT',
      'end in=main out=EXIT idom=main ipdom=EXIT dom=ENTRY,start,main,end pdom=end,EXIT',
      'Boundary_main_error in=ENTRY out=splitB idom=ENTRY ipdom=splitB dom=ENTRY,Boundary_main_error pdom=Boundary_main_error,splitB,joinB,endB,EXIT',
      'splitB in=Boundary_main_error out=branchA,branchB idom=Boundary_main_error ipdom=joinB dom=ENTRY,Boundary_main_error,splitB pdom=splitB,joinB,endB,EXIT',
      'branchA in=splitB out=joinB idom=splitB ipdom=joinB dom=ENTRY,Boundary_main_error,splitB,branchA pdom=branchA,joinB,endB,EXIT',
      'branchB in=splitB out=joinB idom=splitB ipdom=joinB dom=ENTRY,Boundary_main_error,splitB,branchB pdom=branchB,joinB,endB,EXIT',
      'joinB in=branchA,branchB out=endB idom=splitB ipdom=endB dom=ENTRY,Boundary_main_error,splitB,joinB pdom=joinB,endB,EXIT',
      'endB in=joinB out=EXIT idom=joinB ipdom=EXIT dom=ENTRY,Boundary_main_error,splitB,joinB,endB pdom=endB,EXIT',
      'EXIT in=end,endB out=- idom=ENTRY ipdom=- dom=ENTRY,EXIT pdom=EXIT',
      'back-edges=-',
    ],
  ],
  [
    'a node reached from both the main flow and an escape chain keeps only the virtual entry as a dominator',
    graph(
      [
        start('start'),
        task('main'),
        boundaryEvent('Boundary_main_error', 'main', errorDef()),
        task('shared'),
        end('end'),
      ],
      'start>main main>shared Boundary_main_error>shared shared>end',
    ),
    [
      'ENTRY in=- out=start,Boundary_main_error idom=- ipdom=shared dom=ENTRY pdom=ENTRY,shared,end,EXIT',
      'start in=ENTRY out=main idom=ENTRY ipdom=main dom=ENTRY,start pdom=start,main,shared,end,EXIT',
      'main in=start out=shared idom=start ipdom=shared dom=ENTRY,start,main pdom=main,shared,end,EXIT',
      'Boundary_main_error in=ENTRY out=shared idom=ENTRY ipdom=shared dom=ENTRY,Boundary_main_error pdom=Boundary_main_error,shared,end,EXIT',
      'shared in=main,Boundary_main_error out=end idom=ENTRY ipdom=end dom=ENTRY,shared pdom=shared,end,EXIT',
      'end in=shared out=EXIT idom=shared ipdom=EXIT dom=ENTRY,shared,end pdom=end,EXIT',
      'EXIT in=end out=- idom=end ipdom=- dom=ENTRY,shared,end,EXIT pdom=EXIT',
      'back-edges=-',
    ],
  ],
  [
    'a back-edge inside an escape chain is detected like any other',
    graph(
      [
        start('start'),
        task('main'),
        end('end'),
        boundaryEvent('Boundary_main_error', 'main', errorDef()),
        gateway('head2'),
        task('body2'),
        end('escEnd'),
      ],
      'start>main main>end Boundary_main_error>head2 head2>body2 body2>head2 head2>escEnd',
    ),
    [
      'ENTRY in=- out=start,Boundary_main_error idom=- ipdom=EXIT dom=ENTRY pdom=ENTRY,EXIT',
      'start in=ENTRY out=main idom=ENTRY ipdom=main dom=ENTRY,start pdom=start,main,end,EXIT',
      'main in=start out=end idom=start ipdom=end dom=ENTRY,start,main pdom=main,end,EXIT',
      'end in=main out=EXIT idom=main ipdom=EXIT dom=ENTRY,start,main,end pdom=end,EXIT',
      'Boundary_main_error in=ENTRY out=head2 idom=ENTRY ipdom=head2 dom=ENTRY,Boundary_main_error pdom=Boundary_main_error,head2,escEnd,EXIT',
      'head2 in=Boundary_main_error,body2 out=body2,escEnd idom=Boundary_main_error ipdom=escEnd dom=ENTRY,Boundary_main_error,head2 pdom=head2,escEnd,EXIT',
      'body2 in=head2 out=head2 idom=head2 ipdom=head2 dom=ENTRY,Boundary_main_error,head2,body2 pdom=head2,body2,escEnd,EXIT',
      'escEnd in=head2 out=EXIT idom=head2 ipdom=EXIT dom=ENTRY,Boundary_main_error,head2,escEnd pdom=escEnd,EXIT',
      'EXIT in=end,escEnd out=- idom=ENTRY ipdom=- dom=ENTRY,EXIT pdom=EXIT',
      'back-edges=Flow_body2_head2',
    ],
  ],
  [
    'a container with no start event roots both its boundary event and its predecessor-less main flow',
    graph(
      [
        task('main'),
        boundaryEvent('B', 'main', errorDef()),
        task('esc'),
        end('e'),
      ],
      'B>esc esc>e',
    ),
    [
      'ENTRY in=- out=main,B idom=- ipdom=EXIT dom=ENTRY pdom=ENTRY,EXIT',
      'main in=ENTRY out=EXIT idom=ENTRY ipdom=EXIT dom=ENTRY,main pdom=main,EXIT',
      'B in=ENTRY out=esc idom=ENTRY ipdom=esc dom=ENTRY,B pdom=B,esc,e,EXIT',
      'esc in=B out=e idom=B ipdom=e dom=ENTRY,B,esc pdom=esc,e,EXIT',
      'e in=esc out=EXIT idom=esc ipdom=EXIT dom=ENTRY,B,esc,e pdom=e,EXIT',
      'EXIT in=main,e out=- idom=ENTRY ipdom=- dom=ENTRY,EXIT pdom=EXIT',
      'back-edges=-',
    ],
  ],
  [
    'an intermediate catch event is a plain main-flow node, immediately dominated by its predecessor',
    graph(
      [
        start('start'),
        task('task'),
        typedEvent('intermediateCatchEvent', 'node', messageDef('M')),
        end('end'),
      ],
      INTERMEDIATE_EVENT_EDGES,
    ),
    INTERMEDIATE_EVENT,
  ],
  [
    'an intermediate throw event in the same position yields the identical relations',
    graph(
      [
        start('start'),
        task('task'),
        typedEvent('intermediateThrowEvent', 'node', signalDef('S')),
        end('end'),
      ],
      INTERMEDIATE_EVENT_EDGES,
    ),
    INTERMEDIATE_EVENT,
  ],
  [
    'a sequence flow naming an undeclared element is skipped rather than thrown on',
    {
      ...graph([start('s'), task('m'), end('e')], 's>m m>e'),
      sequenceFlows: [
        edge('s', 'm'),
        edge('m', 'ghost'),
        edge('ghost', 'e'),
        edge('m', 'e'),
      ],
    },
    [
      'ENTRY in=- out=s idom=- ipdom=s dom=ENTRY pdom=ENTRY,s,m,e,EXIT',
      's in=ENTRY out=m idom=ENTRY ipdom=m dom=ENTRY,s pdom=s,m,e,EXIT',
      'm in=s out=e idom=s ipdom=e dom=ENTRY,s,m pdom=m,e,EXIT',
      'e in=m out=EXIT idom=m ipdom=EXIT dom=ENTRY,s,m,e pdom=e,EXIT',
      'EXIT in=e out=- idom=e ipdom=- dom=ENTRY,s,m,e,EXIT pdom=EXIT',
      'back-edges=-',
    ],
  ],
];

describe('cfg analysis', () => {
  it.each(CASES)('%s', (_title, process, expected) => {
    expect(describeCfg(process)).toEqual(expected);
  });

  it('answers every query for an id no element declares, rather than throwing', () => {
    const cfg = analyzeCfg(graph([start('s'), task('m'), end('e')], 's>m m>e'));

    expect(cfg.outgoing('nope')).toEqual([]);
    expect(cfg.incoming('nope')).toEqual([]);
    expect(cfg.immediateDominator('nope')).toBeUndefined();
    expect(cfg.immediatePostDominator('nope')).toBeUndefined();
    expect(cfg.dominates('nope', 'm')).toBe(false);
    expect(cfg.dominates('m', 'nope')).toBe(false);
    expect(cfg.postDominates('nope', 'm')).toBe(false);
    expect(cfg.postDominates('m', 'nope')).toBe(false);
  });
});
