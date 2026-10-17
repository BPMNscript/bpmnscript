import { expect } from 'vitest';

import { UnsupportedConstructError } from '../../src/errors.js';

/**
 * Asserts that an import was refused: `refusal` rejects with `errorClass`, and
 * (when `detail` is given) the error names the offending construct. Returns
 * the error so a caller can pin its remaining fields.
 *
 * A string is the error's `detail` field, compared with `toBe`. A regular
 * expression is matched against the whole message, whose note lines carry
 * the engine's reasons.
 */
export const expectRefusal = async <
  E extends UnsupportedConstructError = UnsupportedConstructError,
>(
  refusal: Promise<unknown>,
  errorClass: abstract new (...args: never[]) => UnsupportedConstructError,
  detail?: RegExp | string,
): Promise<E> => {
  const err: unknown = await refusal.then(
    () => expect.fail('Should have thrown'),
    (thrown: unknown) => thrown,
  );
  expect(err).toBeInstanceOf(errorClass);
  if (detail !== undefined) {
    if (detail instanceof RegExp) {
      expect((err as Error).message).toMatch(detail);
    } else {
      expect((err as { detail: string }).detail).toBe(detail);
    }
  }
  return err as E;
};
