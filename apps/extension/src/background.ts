import { DEFAULT_BASE_URL } from './messages';
import type { CaptureResponse, ExtensionRequest, LookupResponse } from './messages';
import { NETWORK_MESSAGE, isLoopbackAddress, normalizeBaseUrl, sendCapture, sendLookup } from './api';

async function capture(request: Extract<ExtensionRequest, { kind: 'capture' }>): Promise<CaptureResponse> {
  const stored = await chrome.storage.local.get({ baseUrl: DEFAULT_BASE_URL, token: '' });
  return sendCapture(stored, request.payload);
}

async function lookup(request: Extract<ExtensionRequest, { kind: 'lookup' }>): Promise<LookupResponse> {
  const stored = await chrome.storage.local.get({ baseUrl: DEFAULT_BASE_URL, token: '' });
  // The lookup runs on page view with no click, so it only ever talks to this computer. With any other server
  // address nothing leaves the machine until the user clicks capture.
  if (!isLoopbackAddress(normalizeBaseUrl(stored.baseUrl))) {
    return { ok: false, code: 'remote', message: 'The automatic check only runs against a local server address.' };
  }
  return sendLookup(stored, request.payload);
}

function isRequest(value: unknown): value is ExtensionRequest {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return kind === 'capture' || kind === 'lookup' || kind === 'openOptions';
}

// The toolbar button has no popup, so clicking it opens the options page.
chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isRequest(message)) return false;
  if (message.kind === 'openOptions') {
    void chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  // Returning true keeps the message channel open until the async fetch settles.
  const work = message.kind === 'lookup' ? lookup(message) : capture(message);
  work.then(sendResponse, () => sendResponse({ ok: false, code: 'network', message: NETWORK_MESSAGE }));
  return true;
});
