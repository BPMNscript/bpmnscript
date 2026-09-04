import { expect } from 'vitest';

import { UnsupportedConstructError } from '../../src/errors.js';

/**
 * Asserts that an import was refused: `refusal` rejects with `errorClass`, and
 * (when `detail` is given) the error's `detail` field names the offending
 * construct. Returns the error so a caller can pin its remaining fields.
 *
 * A regular expression is matched with `toMatch`, a string with `toBe`.
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
    const actual = (err as { detail: string }).detail;
    if (detail instanceof RegExp) {
      expect(actual).toMatch(detail);
    } else {
      expect(actual).toBe(detail);
    }
  }
  return err as E;
};
