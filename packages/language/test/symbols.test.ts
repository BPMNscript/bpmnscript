/**
 * The document outline, driven through the real `DocumentSymbolProvider` with
 * `expectSymbols` from `langium/test`, over the frozen
 * `boundary-events.bpmnscript` golden.
 *
 * The whole tree is flattened to one `Kind name` line per symbol, indented by
 * depth, and asserted as a single list: an `on` handler with no children of
 * its own would otherwise be invisible (its steps would float to the level
 * above), which is exactly the regression this pins.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { expectSymbols } from 'langium/test';
import type { DocumentSymbol } from 'vscode-languageserver-types';
import { SymbolKind } from 'vscode-languageserver-types';
import { createBpmnScriptServices } from '@bpmn-script/language';

const KIND_NAME: Record<number, string> = {};
for (const [name, value] of Object.entries(SymbolKind)) {
  if (typeof value === 'number') KIND_NAME[value] = name;
}

function flatten(symbols: DocumentSymbol[], depth: number): string[] {
  return symbols.flatMap((symbol) => [
    `${'  '.repeat(depth)}${KIND_NAME[symbol.kind]} ${symbol.name}`,
    ...flatten(symbol.children ?? [], depth + 1),
  ]);
}

// Generated once against `boundary-events.bpmnscript` and read against the
// golden's narrative before being pinned: three code declarations, every
// named statement kinded and, per handler, one line for its own header with
// its steps nested under it. `BookCarrier`'s `in`/`out` mapping lines are
// absent, a mapping having no name to be a symbol by.
const EXPECTED = [
  'Module parcel-dispatch',
  '  Constant ADDRESS_REJECTED',
  '  Constant PAYMENT_DECLINED',
  '  Constant OVERSIZED_PARCEL',
  '  Event ParcelOrdered',
  '  Function CheckAddress',
  '  Namespace PackGoods',
  '    Event PackStart',
  '    Function PickItems',
  '    Event Oversized',
  '    Function SealParcel',
  '    Event PackDone',
  '  Function ComputeShipping',
  '  Function ChargePostage',
  '  Function PrintLabel',
  '  Function BookCarrier',
  '  Function HandOverParcel',
  '  Event ParcelDispatched',
  '  Event on CheckAddress: message("AddressVerified")',
  '    Function MarkAddressVerified',
  '  Event on CheckAddress: timer("PT4H", alongside)',
  '    Function SendAddressReminder',
  '  Event on PackGoods: error(ADDRESS_REJECTED, code: c, message: m)',
  '    Function CorrectAddress',
  '    Function NotifyInsuranceDesk',
  '    Function RecordAddressFix',
  '  Event on PackGoods: escalation(OVERSIZED_PARCEL, code: e, alongside)',
  '    Function ArrangeFreight',
  '  Event on ComputeShipping: timer("PT1H", alongside)',
  '    Function NotifyShippingDelay',
  '  Event on ChargePostage: error(PAYMENT_DECLINED)',
  '    Function ReviewPayment',
  '  Event on PrintLabel: message("ExpediteRequested")',
  '    Function ExpediteShipment',
  '  Event on BookCarrier: signal("CarrierStrike")',
  '    Function BookAlternateCarrier',
  '  Event on HandOverParcel: condition(weight > 30, alongside)',
  '    Function CallForklift',
  '  Event on signal("CarrierStrike", alongside)',
  '    Event StrikeNoted',
  '    Function RecordCarrierStrike',
  '    Event StrikeRecorded',
];

describe('document outline', () => {
  test('every element kinded, every handler named by its header and holding its steps', async () => {
    const text = readFileSync(
      new URL(
        '../../../tests/golden/boundary-events.bpmnscript',
        import.meta.url,
      ),
      'utf8',
    );
    const symbols = expectSymbols(
      createBpmnScriptServices(EmptyFileSystem).BpmnScript,
    );
    await symbols({
      text,
      assert: (result) => expect(flatten(result, 0)).toEqual(EXPECTED),
    });
  });
});
