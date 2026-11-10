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

To read your own mail on your machine instead, remove the `DEMO_MAILBOX` line from `.dev.vars`, give `CREDENTIALS_KEY` a long random value of your own (`openssl rand -base64 32` makes one), delete `.wrangler/state`, and start `bun run dev` again. The first-run screen adds a Zoho account, with the server names your Zoho settings list, or any IMAP and SMTP server with its password. Trail Mix tries the password before it keeps anything. Your mail's index and the sealed password stay in `.wrangler/state`, and anything you send leaves for real once its undo window closes.

## Who can read your mail

The mail server stays the only authority for your mail. Trail Mix stores your account settings, your encrypted credentials and the messages waiting to be sent, all in the Cloudflare account it is deployed to. Whoever controls that Cloudflare account can read everything stored there, encryption included, because the key is theirs. If someone else runs Trail Mix for you, you are trusting them with your mail.

## Contributing

[AGENTS.md](AGENTS.md) is the working agreement for every change, by a person or an agent: the architecture, the design rules and the toolchain.

## License

[MIT](LICENSE)
