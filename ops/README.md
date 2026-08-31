# Unit files

Copies of the systemd user units this machine runs, kept here so a second
machine can be set up from the repo rather than from memory. Install with:

```
cp ops/dinnernode2.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dinnernode2.service
```

`loginctl enable-linger $USER` is what makes user units start at boot without
someone logging in. It is already set on this machine.

Config is NOT here. `.env` and `.env.node2` hold private keys and are
gitignored; the unit reads `.env.node2` through `EnvironmentFile` and dotenv
loads `.env` underneath it for settings both nodes share.

## Tunnels

Two more user units, so the same `loginctl enable-linger` covers all four
processes. They are named tunnels on subdomains we control, which is what an
aggregator listing and a discovery record can point at; a quick tunnel gets a
new hostname on every restart and is the right shape only for a stranger's
node, which `src/tunnel.ts` starts automatically when `PUBLIC_URL` is unset.

```
cp ops/dinnernode-tunnel-node1.service ops/dinnernode-tunnel-discovery.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dinnernode-tunnel-node1.service
systemctl --user enable --now dinnernode-tunnel-discovery.service
```

They read `~/.cloudflared/node1.yml` and `~/.cloudflared/discovery.yml`, which
name a credentials file each. **Those credentials and `cert.pem` are secrets
and live outside the repo.** Standing them up the first time is
`ops/cloudflare-migration.md`, steps 5 and 6.

Note the port the discovery unit uses: 4175, not 4174. 4174 is node 2. The
default in `src/discovery.ts` predates there being a second node, so both the
unit and the tunnel config have to say it explicitly.
