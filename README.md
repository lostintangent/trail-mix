# Trail Mix

An open-source, keyboard-first mail client that you host yourself. One Cloudflare Worker serves you and the people you invite. Each of them gets a private Mailroom for their own IMAP accounts, on a desktop or a phone.

Beyond reading and writing quickly, Trail Mix keeps the parts of mail that waste your time out of the way: tracking pixels, lookalike senders, piles of notifications, and the worry of a message sent too soon. Your mail server stays the source of truth, so you can try Trail Mix without moving anything.

## Features

- **Every account in one Inbox:** Connect Zoho, Outlook or any IMAP host, and read them together in one Inbox, with Flagged, Drafts and Outbox across them all. Each account has its own color, stamped on its mail and on the From chip, so you always know which inbox a message came from and which one it will leave from.
- **Keyboard-first and fast:** Gmail-style keys for everything, such as J and K to move, E to archive and R to reply, plus a command palette on ⌘K and search that answers as you type. A 50,000-message folder scrolls at 60 frames a second.
- **Sending you can take back:** Every send can be undone for ten seconds or scheduled for later. Your draft is saved to your mail server as you write and stays there until the send is accepted, so a closed tab or a dropped connection never costs a message, and exactly one copy lands in Sent.
- **Write in Markdown:** Bold, lists, links, code and pasted images go out as clean HTML mail with a plain-text part, so it reads well in any client.
- **Private reading:** Remote images wait until you allow the sender, then load through your own Worker, so senders never learn your IP address. Known tracking pixels are dropped before anything loads, and each message says how many it carried. Message HTML is sanitized and shown in a sandbox where nothing can run.
- **Senders you can trust at a glance:** Mail that passes DMARC shows its sender's logo or photo, from BIMI, Gravatar or their website. Mail that doesn't keeps plain initials, so a lookalike can't borrow a brand's face. Newsletters that prove who they are get a one-click Unsubscribe.
- **A dark mode made for mail:** Trail Mix follows your system's light or dark setting, with any accent color you like. In the dark, HTML mail is repainted to sit on charcoal while its images and brand colors stay as sent, and any sender whose mail reads better on light paper can stay on it.
- **GitHub notifications, bundled:** Notifications from GitHub gather into one row per repository, so a morning of reviews and comments is one line to work through.
- **At home on your phone:** Add it to your Home Screen for a full-screen app with swipe to archive and notifications for new mail, which offer Archive and Mark read wherever your device shows a notification's buttons. Every open device stays current as mail arrives, and the app shows the mail you last saw while it reconnects.
- **Yours to run, for people you invite:** One Worker on Cloudflare's $5-a-month plan, set up with one button. Cloudflare Access emails each person a one-time code, so Trail Mix holds no password of yours, and each person's mail lives in a Mailroom of their own.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lostintangent/trail-mix)

## Set up your own

About 15 minutes, from a new Cloudflare account to your first message. Trail Mix stays closed, showing only a setup page, until step 2 is done.

### Before you start

1. **A Cloudflare account.** Sign in at [dash.cloudflare.com](https://dash.cloudflare.com), or create one. Open **Workers & Pages** once, which asks you to choose your `workers.dev` subdomain.
2. **Workers Paid**, $5 a month, under **Workers & Pages → Plans**. Syncing a mailbox needs more CPU than the Free plan allows. It also puts a card on file, which R2 and Zero Trust ask for even though both are free at Trail Mix's size.
3. **R2.** Open **R2 Object Storage** and turn it on.

### 1. Deploy

Press **Deploy to Cloudflare** above. Connect your GitHub account, keep the names it suggests, and select **Create and deploy**. Cloudflare copies Trail Mix into a repository of yours, then builds and deploys it, which takes a few minutes.

The first deploy makes two keys and keeps them as secrets only your Worker can read: one that seals your mail passwords, and one that signs notifications. There's nothing to paste.

When it's done, open the address Cloudflare shows, `https://trail-mix.<subdomain>.workers.dev`. It says Trail Mix isn't set up yet.

### 2. Sign in with Cloudflare Access

Cloudflare Access stands in front of Trail Mix and emails each person a one-time code, so Trail Mix never holds a password of yours.

1. Open **Zero Trust**. The first time, choose a team name, which becomes `<team>.cloudflareaccess.com`, and the **Free** plan.
2. Under **Integrations → Identity providers**, select **Add new identity provider → One-time PIN**. A new team starts with only the **Cloudflare** provider, which lets in members of your Cloudflare account and nobody you invite.
3. Under **Access controls → Applications**, select **Create new application → Self-hosted and private**, then **Add public hostname**:
   - **Name:** Trail Mix
   - **Public hostname:** your address from step 1, without `https://`
   - **Policy:** action **Allow**, with **Emails** set to your address
   - **Login methods:** turn off **Accept all available identity providers** and choose only **One-time PIN**, so the people you invite aren't offered a Cloudflare sign-in that can't let them in
   - **Session duration:** 1 month, so an installed app asks for a code about once a month

   Save it, and copy the **Audience (AUD) Tag** from its overview. Use an application like this one, not the Worker's **Protect this Worker** switch, which refuses the connection each open Trail Mix tab keeps.

4. In **Workers & Pages**, open **trail-mix → Settings → Variables and Secrets**, add these two as **Text**, and select **Deploy**:
   - `ACCESS_TEAM_DOMAIN`: `<team>.cloudflareaccess.com`
   - `ACCESS_AUD`: the tag you copied
5. Open your address again, enter your email and then the code Cloudflare sends. Trail Mix welcomes you.

### 3. Name yourself the operator

The operator invites and removes people from **Members**, in Trail Mix's **Settings**, which edits the Access policy from step 2 for you.

1. Under **My Profile → API Tokens**, create a **Custom token** named "Trail Mix members", for your account alone, with exactly these four **Account** permissions:
   - Access: Apps Read
   - Access: Policies Write
   - Access: Audit Logs Read
   - Access: Organizations Revoke
2. In **Variables and Secrets**, add `OPERATOR_EMAIL` as **Text**, the address you sign in with, and `ACCESS_API_TOKEN` as **Secret**, the token. Select **Deploy**.

Reload Trail Mix, and **Members** appears in **Settings**, which the gear at the foot of the sidebar opens, and in its command palette. Each person you invite signs in with a code and gets a Mailroom of their own, with mail nobody else can see.

### 4. Add your mail

Trail Mix's welcome screen adds your first account. It tries the password on both servers before it keeps anything, and if one refuses, it tells you why in the server's own words.

- **Zoho:** turn on IMAP access in Zoho Mail's settings, create an app-specific password for Trail Mix, and use the server names those settings list.
- **Any other IMAP host:** its IMAP and SMTP servers, and the password it gives mail apps.
- **Outlook.com:** needs a Microsoft app registration first, below.

That's it. Trail Mix checks your mail every few minutes, and live while it's open.

### Outlook.com accounts

About 10 minutes, once for your whole deployment.

1. In Outlook.com, open **Settings → Mail → Forwarding and IMAP** and turn on **Let devices and apps use IMAP**.
2. At [entra.microsoft.com](https://entra.microsoft.com), open **App registrations → New registration**. Name it Trail Mix, choose **Personal Microsoft accounts only**, leave the redirect URI empty and register it. Under **Authentication**, set **Allow public client flows** to **Yes** and save.
3. Copy its **Application (client) ID**, add it to your Worker as the **Text** variable `MICROSOFT_CLIENT_ID`, and select **Deploy**.

### Keeping it up to date

Your copy deploys itself whenever its `main` branch changes. To bring in the newest Trail Mix, from a clone of your copy:

```sh
git pull https://github.com/lostintangent/trail-mix.git main
git push
```

Each Mailroom upgrades its own storage the first time a new version runs.

To deploy from a clone instead of the button, with Bun and Node installed as [Try it locally](#try-it-locally) says, sign in with `npx wrangler login`, then run `bun install`, `bun run build` and `bun run deploy`. It makes the same keys the first time and the R2 bucket if it's missing.

## Who can read your mail

The mail server stays the only authority for your mail. Trail Mix stores your account settings, your encrypted credentials, an index of your mail, the messages you've opened, the messages waiting to be sent, and the devices you've turned notifications on for, all in the Cloudflare account it is deployed to. Whoever controls that Cloudflare account can read everything stored there, encryption included, because the key is theirs. If someone else runs Trail Mix for you, you are trusting them with your mail.

To show who a message is from, Trail Mix looks up the picture of each sender whose mail their server verified: their brand's logo through DNS, their photo at Gravatar by a hash of their address, and their site's icon. Cloudflare asks, never your browser, at most once a week for each. Gravatar can match a hash to an address it knows, so it can learn who writes to you.

A notification of new mail carries its sender, subject and first words to your device through the push service its browser's maker runs, such as Apple's, Google's or Mozilla's. It is encrypted for that device alone, so the push service learns when one is sent, never what it says.

A Mailroom nobody opens for 30 days stops checking mail, and after 90 days it erases itself. Anyone can erase everything Trail Mix holds for them at any time, from the command palette or the foot of any account's page. [SECURITY.md](SECURITY.md) says how to report a problem.

## Try it locally

You need Bun canary 1.4.4 or newer, which `bun upgrade --canary` installs, and Node 22.18 or newer, which runs the local Workers runtime and the deploy.

```sh
bun install
cp dev.vars.example .dev.vars
bun run dev
```

The dev server signs you in as the development member named in `.dev.vars` and fills a new Mailroom with the demo mailbox. No real mail is involved.

To read your own mail on your machine instead, remove the `DEMO_MAILBOX` line from `.dev.vars`, give `CREDENTIALS_KEY` a long random value of your own (`openssl rand -base64 32` makes one), delete `.wrangler/state`, and start `bun run dev` again. Your mail's index and the sealed password stay in `.wrangler/state`, and anything you send leaves for real once its undo window closes.

## Contributing

[AGENTS.md](AGENTS.md) is the working agreement for every change, by a person or an agent: the architecture, the design rules and the toolchain.

## License

[MIT](LICENSE)
