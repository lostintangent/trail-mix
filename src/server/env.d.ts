/**
 * The Worker's settings that its Wrangler configuration doesn't name, so `wrangler types` can't:
 * the secrets and variables an operator, a developer's `.dev.vars` or a test sets. Every one is
 * optional, since each deployment sets only some.
 */
declare namespace Cloudflare {
  interface Env {
    /** The commit this deployment runs. */
    VERSION?: string;
    /** The Worker secret each member's credentials key is derived from. */
    CREDENTIALS_KEY?: string;
    /** The Cloudflare Access team domain, such as `example.cloudflareaccess.com`. */
    ACCESS_TEAM_DOMAIN?: string;
    /** The audience tag of the Access application in front of Trail Mix. */
    ACCESS_AUD?: string;
    /** The one development member, set only in the local `.dev.vars` file. */
    DEV_MEMBER?: string;
    /**
     * The key the public demo signs each visitor's cookie with, a secret only the demo holds. Its
     * presence also tells a visitor's Mailroom, which holds only the demo mailbox, to check mail only
     * while they have it open, since nothing reaches the demo mailbox from outside, and to keep both
     * demo accounts, since filling one again writes thousands of rows.
     */
    VISITOR_KEY?: string;
    /** Fixes the demo accounts' creation time, an ISO 8601 instant, so their dates never move. */
    DEMO_MAILBOX_AT?: string;
    /**
     * `true` has the demo's mail server file its own copy of what it accepts in Sent, a moment late,
     * as Zoho's does, so the Outbox waits for it.
     */
    DEMO_HOST_FILES_SENT?: string;
    /**
     * The deployment's Web Push key, a P-256 private key in PKCS #8 PEM. With `OPERATOR_EMAIL`, whom
     * push services contact about its pushes, it turns notifications on.
     */
    PUSH_KEY?: string;
    OPERATOR_EMAIL?: string;
    /** The app the operator registered with Microsoft, which Outlook accounts sign in through. */
    MICROSOFT_CLIENT_ID?: string;
    /**
     * A test's stand-in for Outlook, as JSON: Microsoft's sign-in and the hosts. Honored only when
     * every address in it names this machine.
     */
    OUTLOOK_STAND_IN?: string;
    /**
     * A test's names for the servers on this machine that sign Authentication-Results, as JSON from
     * host to names. Honored for hosts on this machine alone.
     */
    AUTH_SERVERS_STAND_IN?: string;
    /**
     * A test's stand-in for where avatars are looked up, as one origin: DNS over HTTPS at
     * `/dns-query`, answering as Cloudflare's does, Gravatar at `/gravatar/` and each domain's site
     * at `/sites/<domain>/`. Honored only when it names this machine.
     */
    AVATARS_STAND_IN?: string;
    /**
     * A test's stand-in for the senders' servers a one-click unsubscribe posts to, as one origin.
     * Honored only when it names this machine.
     */
    UNSUBSCRIBE_STAND_IN?: string;
  }
}
