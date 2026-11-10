# Trail Mix

An open-source, keyboard-first mail client that you host yourself. One Cloudflare Worker serves you and the people you invite. Each of them gets a private Mailroom for their own IMAP accounts, on a desktop or a phone.

## Status

Trail Mix is in development. Reading, triage and writing work against a seeded demo mailbox and a local test mail server. Deploying a copy of your own isn't ready yet. When it is, this README will walk you through it, from the Cloudflare account to the first sign-in.

## Try it locally

You need Bun canary 1.4.4 or newer, which `bun upgrade --canary` installs.

```sh
bun install
cp .dev.vars.example .dev.vars
bun run dev
```

The dev server signs you in as the development member named in `.dev.vars` and fills a new Mailroom with the demo mailbox. No real mail is involved.

## Who can read your mail

The mail server stays the only authority for your mail. Trail Mix stores your account settings, your encrypted credentials and the messages waiting to be sent, all in the Cloudflare account it is deployed to. Whoever controls that Cloudflare account can read everything stored there, encryption included, because the key is theirs. If someone else runs Trail Mix for you, you are trusting them with your mail.

## Contributing

[AGENTS.md](AGENTS.md) is the working agreement for every change, by a person or an agent: the architecture, the design rules and the toolchain.

## License

[MIT](LICENSE)
