// The workerd modules the check Worker imports. Only `connect` is used, so it is typed as the
// function imapflow's sockets transport takes, and cannot drift from what imapflow expects.
declare module 'cloudflare:sockets' {
  export const connect: import('imapflow').SocketsConnect;
}
