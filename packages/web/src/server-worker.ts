// Entry of the browser web worker: the language server and the two
// conversion requests share one JSON-RPC connection over postMessage.

import { createBpmnScriptServices } from '@bpmn-script/language';
import { EmptyFileSystem } from 'langium';
import { startLanguageServer } from 'langium/lsp';
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createConnection,
} from 'vscode-languageserver/browser';
import { registerConversionRequests } from './requests.js';

/** The package version, replaced by esbuild at bundle time. */
declare const BPMNSCRIPT_VERSION: string;

const connection = createConnection(
  new BrowserMessageReader(self),
  new BrowserMessageWriter(self),
);

const { shared } = createBpmnScriptServices({ connection, ...EmptyFileSystem });

registerConversionRequests(connection, BPMNSCRIPT_VERSION);

startLanguageServer(shared);
