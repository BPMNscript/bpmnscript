import type * as conversion from '@bpmn-script/conversion';
import { expectTypeOf, test } from 'vitest';
import type {
  CompileResult,
  ConvDiagnostic,
  DecompileResult,
} from '../src/protocol';

// The protocol mirrors the conversion package so the source needs nothing else; this keeps the two
// in step. Warning categories are plain strings here, so a new category needs no editor release.
test('every result the worker sends is a result the editor reads', () => {
  expectTypeOf<CompileResult>().toEqualTypeOf<conversion.CompileResult>();
  expectTypeOf<ConvDiagnostic>().toEqualTypeOf<conversion.ConvDiagnostic>();
  expectTypeOf<conversion.DecompileResult>().toExtend<DecompileResult>();
});
