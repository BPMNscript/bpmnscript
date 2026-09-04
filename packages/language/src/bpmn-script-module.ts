import { type Module, inject } from 'langium';
import {
  createDefaultModule,
  createDefaultSharedModule,
  type DefaultSharedModuleContext,
  type LangiumServices,
  type LangiumSharedServices,
  type PartialLangiumServices,
} from 'langium/lsp';
import {
  BpmnScriptGeneratedModule,
  BpmnScriptGeneratedSharedModule,
} from './generated/module.js';
import {
  BpmnScriptValidator,
  registerValidationChecks,
} from './bpmn-script-validator.js';
import {
  DefaultVariableSymbolProvider,
  type VariableSymbolProvider,
} from './variable-symbol-provider.js';
import { BpmnScriptCompletionProvider } from './bpmn-script-completion.js';
import { BpmnScriptScopeProvider } from './bpmn-script-scope-provider.js';
import { BpmnScriptLinker } from './bpmn-script-linker.js';
import { BpmnScriptParserErrorMessageProvider } from './bpmn-script-parser-error-message-provider.js';
import { BpmnScriptSemanticTokenProvider } from './bpmn-script-semantic-tokens.js';
import { BpmnScriptValueConverter } from './bpmn-script-value-converter.js';

/** {@link VariableSymbolProvider} sits in `references`: resolving identifiers is its concern. */
export type BpmnScriptAddedServices = {
  references: {
    VariableSymbolProvider: VariableSymbolProvider;
  };
  validation: {
    BpmnScriptValidator: BpmnScriptValidator;
  };
};

export type BpmnScriptServices = LangiumServices & BpmnScriptAddedServices;

export const BpmnScriptModule: Module<
  BpmnScriptServices,
  PartialLangiumServices & BpmnScriptAddedServices
> = {
  parser: {
    ParserErrorMessageProvider: (services) =>
      new BpmnScriptParserErrorMessageProvider(services),
    ValueConverter: () => new BpmnScriptValueConverter(),
  },
  references: {
    VariableSymbolProvider: () => new DefaultVariableSymbolProvider(),
    ScopeProvider: (services) => new BpmnScriptScopeProvider(services),
    Linker: (services) => new BpmnScriptLinker(services),
  },
  validation: {
    BpmnScriptValidator: (services) => new BpmnScriptValidator(services),
  },
  lsp: {
    CompletionProvider: (services) =>
      new BpmnScriptCompletionProvider(services),
    SemanticTokenProvider: (services) =>
      new BpmnScriptSemanticTokenProvider(services),
  },
};

export function createBpmnScriptServices(context: DefaultSharedModuleContext): {
  shared: LangiumSharedServices;
  BpmnScript: BpmnScriptServices;
} {
  const shared = inject(
    createDefaultSharedModule(context),
    BpmnScriptGeneratedSharedModule,
  );
  const BpmnScript = inject(
    createDefaultModule({ shared }),
    BpmnScriptGeneratedModule,
    BpmnScriptModule,
  );
  shared.ServiceRegistry.register(BpmnScript);
  registerValidationChecks(BpmnScript);
  if (!context.connection) {
    // Not inside a language server, so initialize the configuration now.
    shared.workspace.ConfigurationProvider.initialized({});
  }
  return { shared, BpmnScript };
}
