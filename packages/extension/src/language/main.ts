import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createBpmnScriptServices } from '@bpmn-script/language';

const connection = createConnection(ProposedFeatures.all);

const { shared } = createBpmnScriptServices({ connection, ...NodeFileSystem });

startLanguageServer(shared);
