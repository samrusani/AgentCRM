import { DEFAULT_BASE_URL } from './messages';
import type { CaptureResponse, ExtensionRequest } from './messages';
import { sendCapture } from './api';

async function capture(request: Extract<ExtensionRequest, { kind: 'capture' }>): Promise<CaptureResponse> {
  const stored = await chrome.storage.local.get({ baseUrl: DEFAULT_BASE_URL, token: '' });
  return sendCapture(stored, request.payload);
}

function isRequest(value: unknown): value is ExtensionRequest {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return kind === 'capture' || kind === 'openOptions';
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
  capture(message).then(sendResponse, () =>
    sendResponse({ ok: false, code: 'network', message: 'Could not reach the AgentCRM server. Is it running?' }),
  );
  return true;
});
