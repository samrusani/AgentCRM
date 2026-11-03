# Connect Gmail

AgentCRM connects to Gmail through an OAuth client that you create in your own Google Cloud project. The app never ships a shared client: your mailbox access stays between you and Google, and nothing about your account passes through anyone else's infrastructure. The tradeoff is about ten minutes of one time setup, described here step by step.

## Why these scopes

The app asks Google for exactly two permissions, and the card in Settings names both:

- `gmail.send`: submit the messages you approve. Google classes this scope as sensitive.
- `gmail.readonly`: read incoming mail so the app can show replies, detect bounces, and run its duplicate protection (after an unclear send outcome it searches for the message id it generated instead of ever sending twice). Google classes this scope as restricted, which matters for published apps; for a client you create for yourself it changes nothing except the warning screens described below.

Tokens are stored unencrypted in the local database file, like every other secret in AgentCRM. Anyone who can read that file can read them.

## Create the OAuth client

1. Open https://console.cloud.google.com/ and create a project (any name).
2. Enable the Gmail API: APIs and services, Library, search for Gmail API, Enable.
3. Configure the consent screen: APIs and services, OAuth consent screen. Choose External, fill in the app name and your email address, and save. You do not need to submit for verification.
4. Add yourself as a test user on the consent screen page (Audience or Test users, depending on the console version). This matters: only test users can sign in while the app is in Testing status.
5. Create the client: APIs and services, Credentials, Create credentials, OAuth client ID, application type Desktop app. Copy the client id and the client secret.
6. Paste both into the Gmail card in AgentCRM Settings, Connectors, then select Sign in with Google. Your browser opens Google's consent screen; after you approve, Google redirects back to the app running on your computer.

## The two honest consequences

- Testing status: Google expires consents for apps in Testing after seven days. The app will show the connector as needing attention and you sign in again. This is Google's rule, not the app's.
- In production, unverified: you can instead press Publish app on the consent screen page. Sign ins then last, but Google shows an "unverified app" warning during sign in because the app (your own client) has not gone through Google's verification. Verification is built for published software with many users and is not required to use your own client with your own account. Choose whichever consequence you prefer; both are safe for self use.

## Limits worth knowing

- Google enforces its own sending limits (consumer accounts around 500 recipients per day, Google Workspace accounts more). AgentCRM additionally stops at its own cap of 50 accepted sends per inbox per day.
- The Gmail API has generous per minute quotas that a local CRM will not approach.
- If you change your Google password, Google revokes the app's tokens and you sign in again.

## Removing the connection

Remove the connector in Settings to delete the stored tokens from the local database. You can also revoke the app's access at https://myaccount.google.com/permissions, and delete the OAuth client in your Google Cloud console.
