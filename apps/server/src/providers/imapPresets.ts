import type { SmtpTlsMode } from './mailTransport.js';

// The two tested presets. A preset fills the servers and the login names, so a person types an address and an app
// password. Custom mode takes every server from the person.

export type ImapPresetName = 'icloud' | 'fastmail' | 'custom';

export interface ImapServers {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpTls: SmtpTlsMode;
}

export const presetServers: Record<'icloud' | 'fastmail', ImapServers> = {
  icloud: { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpTls: 'starttls' },
  fastmail: { imapHost: 'imap.fastmail.com', imapPort: 993, smtpHost: 'smtp.fastmail.com', smtpPort: 465, smtpTls: 'tls' },
};

export const presetLabels: Record<ImapPresetName, string> = { icloud: 'iCloud Mail', fastmail: 'Fastmail', custom: 'The mail server' };

// Where the app password is made, in one sentence per preset.
export const appPasswordHints: Record<ImapPresetName, string> = {
  icloud:
    'Use an app-specific password from account.apple.com (Sign-In and Security, App-Specific Passwords), not the Apple Account password. Two-factor authentication must be on.',
  fastmail:
    'Use an app password from Fastmail (Settings, Privacy & Security, New app password) that allows mail access. The Basic plan has no IMAP or SMTP access.',
  custom: 'Check the username and password. Many providers need an app password instead of the account password.',
};

export function localPartOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(0, at) : address;
}

// The name that signs in over IMAP. iCloud wants the part of the address before the @, while its SMTP server wants the
// full address. `loginName` is set when the login differs from the sending address, such as an alias.
export function imapUsernameFor(preset: ImapPresetName, address: string, loginName: string | null): string {
  const login = loginName ?? address;
  return preset === 'icloud' ? localPartOf(login) : login;
}

export function smtpUsernameFor(_preset: ImapPresetName, address: string, loginName: string | null): string {
  return loginName ?? address;
}
