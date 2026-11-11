# Security

Trail Mix holds the keys to people's mail, so a problem in it matters. Thank you for reporting one.

## Reporting a problem

Report it privately, through **[Report a vulnerability](https://github.com/lostintangent/trail-mix/security/advisories/new)** on this repository's Security tab. Please don't open a public issue or pull request for it.

Say what someone could do and how, with the steps or a request that shows it. The reply comes in the advisory, and once a fix is on `main`, the advisory is published with credit to you, unless you'd rather not be named.

Only the newest `main` is supported. Trail Mix has no versioned releases, and each deployment takes a fix by deploying the newest `main`.

## What Trail Mix promises

These are what a report would show broken.

- **Members are private from each other.** Each member's mail, accounts, drafts and settings live in a Mailroom of their own, which the Worker chooses from the sign-in Cloudflare Access verified on that request alone. Nothing a browser sends can name another member's Mailroom.
- **A password enters once.** The password or token for a mail account crosses to the Mailroom once, when the account is added, and is sealed with a key derived for that member before it is stored. No query returns it, and it never sits in a log, a URL or the browser's storage.
- **Mail can't run.** Message HTML is sanitized, then shown in a frame sandboxed without scripts under a restrictive content security policy. Every route that serves a message's bytes, a remote image or a sender's picture answers with a sandboxing policy and `nosniff`, so opening one directly runs nothing.
- **Mail tells no one it was read.** Remote images load only through the Worker's proxy, and only after the member allows their sender. The remote host sees the Worker, never the member.
- **Closed until configured.** A deployment with no sign-in configured serves only its setup page, apart from `/health`, which reports the running version and nothing else.
- **Nothing secret is in the repository.** The keys a deployment needs are made by its first deploy and kept as Worker secrets.

## What the operator can read

The operator is whoever controls the Cloudflare account Trail Mix is deployed to. They can read everything stored there, encryption included, because the key that seals each member's passwords is derived from a secret in their account. That is by design, not a vulnerability: people who use someone else's Trail Mix trust its operator with their mail, and the README tells them so.

Also out of scope are Cloudflare's own services, such as Access and its sign-in codes, and each mail host's servers. Report those to Cloudflare or the mail host.
