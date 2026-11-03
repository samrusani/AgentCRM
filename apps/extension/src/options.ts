import { isLoopbackAddress, normalizeBaseUrl, verifyConnection } from './api';
import { DEFAULT_BASE_URL } from './messages';

const baseUrl = document.getElementById('baseUrl') as HTMLInputElement;
const token = document.getElementById('token') as HTMLInputElement;
const save = document.getElementById('save') as HTMLButtonElement;
const test = document.getElementById('test') as HTMLButtonElement;
const result = document.getElementById('result') as HTMLElement;
const addressNote = document.getElementById('addressNote') as HTMLElement;

// A quiet caution, never a block: the token goes wherever the address points.
function updateAddressNote() {
  addressNote.hidden = isLoopbackAddress(normalizeBaseUrl(baseUrl.value));
}
baseUrl.addEventListener('input', updateAddressNote);

function show(text: string, tone: 'ok' | 'error' = 'ok') {
  result.textContent = text;
  result.dataset.tone = tone;
}

function addressProblem(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'Enter an address that starts with http:// or https://.';
  } catch {
    return 'Enter the server address, for example http://localhost:4720.';
  }
}

async function load() {
  const stored = await chrome.storage.local.get({ baseUrl: DEFAULT_BASE_URL, token: '' });
  baseUrl.value = normalizeBaseUrl(stored.baseUrl);
  token.value = typeof stored.token === 'string' ? stored.token : '';
  updateAddressNote();
}

save.addEventListener('click', async () => {
  const address = normalizeBaseUrl(baseUrl.value);
  const problem = addressProblem(address);
  if (problem) return show(problem, 'error');
  await chrome.storage.local.set({ baseUrl: address, token: token.value.trim() });
  baseUrl.value = address;
  updateAddressNote();
  show('Saved.');
});

test.addEventListener('click', async () => {
  const address = normalizeBaseUrl(baseUrl.value);
  const problem = addressProblem(address);
  if (problem) return show(problem, 'error');
  updateAddressNote();
  test.disabled = true;
  show('Testing');
  // Uses the current field values, saved or not.
  const outcome = await verifyConnection(address, token.value);
  test.disabled = false;
  if (outcome.ok) show(outcome.workspace ? `Connected to ${outcome.workspace}.` : 'Connected.');
  else show(outcome.message, 'error');
});

void load();
