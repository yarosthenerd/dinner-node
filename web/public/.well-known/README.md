# .well-known

Files here are served at the site root by path, e.g. `discord` becomes
`https://www.dinnernode.xyz/.well-known/discord`. Vite copies this directory
through to `dist/` unchanged, so nothing else has to know about it.

## discord

Domain ownership proof for the DinnerNode Discord server's linked-domain
setting. Discord re-fetches it periodically rather than once, so **deleting it
un-verifies the domain at some later date, with no warning and no obvious
cause**. It is checked in for exactly that reason: an uploaded-by-hand file
would not survive the next deploy.

Nothing in it is secret. It proves control of the domain to one service and
grants nothing to whoever reads it.
