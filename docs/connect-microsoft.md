# Connect Microsoft 365 or Outlook.com

AgentCRM connects to Microsoft mail through an app registration that you create in your own Microsoft Entra tenant. As with Gmail, the app never ships a shared client: mail access stays between you and Microsoft. Setup takes about ten minutes.

## Create the app registration

1. Open https://entra.microsoft.com/ (or portal.azure.com) and sign in. Go to Identity, Applications, App registrations, New registration.
2. Name it anything. Under Supported account types choose "Accounts in any organizational directory and personal Microsoft accounts". This is the option that works for both work mailboxes and personal outlook.com addresses.
3. Register, then open Authentication. Add a platform, choose "Mobile and desktop applications", and enter `http://localhost` as the redirect URI. Microsoft matches loopback redirects regardless of port, so this one entry covers the app.
4. Still under Authentication, set "Allow public client flows" to Yes and save. No client secret is needed; the app signs in with PKCE like a desktop application.
5. Copy the Application (client) id from the Overview page and paste it into the Microsoft card in AgentCRM Settings, Connectors, then select Sign in with Microsoft.

## Permissions requested

- `Mail.Send`: submit the messages you approve.
- `Mail.ReadWrite`: create the draft that makes sending reconcilable (the app sends by creating a draft first, so an unclear outcome can be checked instead of risking a duplicate), thread replies, and read incoming mail for replies and bounce reports.
- `offline_access`: stay signed in between sessions.

Tokens are stored unencrypted in the local database file, like every other secret in AgentCRM.

## Honest notes

- Work and school tenants can require administrator consent for these permissions. If yours does, Microsoft shows its own error during sign in and the card repeats it; ask your administrator or use a personal account.
- Microsoft rotates the refresh token on every use and expires unused ones; if sign in lapses, the card asks you to sign in again.
- Microsoft enforces its own sending limits (10,000 recipients per day per Microsoft 365 mailbox, 30 messages per minute; personal account limits are not published). AgentCRM additionally stops at its own cap of 50 accepted sends per inbox per day.

## Removing the connection

Remove the connector in Settings to delete the stored tokens. You can also revoke the app at https://account.live.com/consent/Manage (personal) or through your organization's My Apps portal, and delete the app registration in Entra.
