// Message shapes shared by the content scripts, the background worker, and the tests.

export interface CapturePayload {
  source: 'linkedin' | 'x';
  url: string;
  name: string;
  headline?: string;
  company?: string;
  location?: string;
  handle?: string;
  bio?: string;
  website?: string;
  email?: string;
  phone?: string;
}

/** Same shape as a capture minus the extracted fields: the server only needs the source and the profile URL. */
export interface LookupPayload {
  source: 'linkedin' | 'x';
  url: string;
}

/** A note the user typed in the capture panel. The profile identity travels as source and url, never a person id. */
export interface NotePayload {
  source: 'linkedin' | 'x';
  url: string;
  note: string;
}

export type ExtensionRequest =
  | { kind: 'capture'; payload: CapturePayload }
  | { kind: 'lookup'; payload: LookupPayload }
  | { kind: 'note'; payload: NotePayload }
  | { kind: 'openOptions' };

export type CaptureResponse =
  | { ok: true; outcome: 'created' | 'existing'; personName: string; added?: string[] }
  | { ok: false; code: string; message: string };

export type LookupResponse =
  | { ok: true; exists: boolean }
  | { ok: false; code: string; message: string };

export type NoteResponse =
  | { ok: true; personName: string }
  | { ok: false; code: string; message: string };

export interface ExtensionSettings {
  baseUrl: string;
  token: string;
}

export const DEFAULT_BASE_URL = 'http://localhost:4720';
export const CONFIG_MESSAGE = 'Open the extension options to set the token';
