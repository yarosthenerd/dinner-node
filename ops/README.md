# Unit files

Copies of the systemd user units this machine runs, kept here so a second
machine can be set up from the repo rather than from memory.

Seven units, and the directory should stay exactly in step with
`~/.config/systemd/user/`:

| Unit | What it runs |
|---|---|
| `dinnernode.service` | node 1, `npm run host`, port 4173, config from `.env` |
| `dinnernode2.service` | node 2, small model, port 4174, config from `.env.node2` |
| `dinnernode-discovery.service` | the discovery listener, port 4175 |
| `dinnernode-tunnel-node1.service` | named Cloudflare tunnel for `node1.dinnernode.xyz` |
| `dinnernode-tunnel-node2.service` | named Cloudflare tunnel for `node2.dinnernode.xyz` |
| `dinnernode-tunnel-discovery.service` | named Cloudflare tunnel for discovery |
| `claude-remote-control.service` | Remote Control server, so the operator can reach this machine from a phone |

**`dinnernode.service` was missing from this directory until 2026-09-07**, and
the omission cost more than a missing file usually does. Both `SNAPSHOT.md` and
`TODO.md` used "the daemons are not systemd units" as the standing reason the
kill e2e had never run against the live pair, for about a week after it stopped
being true. Nothing here showed otherwise, because the unit that refutes it was
the one not committed. If a unit gets installed by hand, commit it the same
day.

Install one with:

```
cp ops/dinnernode2.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dinnernode2.service
```

Both provider units carry `Restart=always` with `RestartSec=10`. That is what
makes a failover test survivable, and it is also why a test that wants to watch
an outage has to stop the unit rather than SIGKILL the process: systemd puts
node 1 back about ten seconds later. `scripts/kill-takeover-e2e.mjs` takes
`KILL_CMD` and `RESTORE_CMD` for exactly this.

`loginctl enable-linger $USER` is what makes user units start at boot without
someone logging in. It is already set on this machine.

Config is NOT here. `.env` and `.env.node2` hold private keys and are
gitignored; the unit reads `.env.node2` through `EnvironmentFile` and dotenv
loads `.env` underneath it for settings both nodes share.

## Tunnels

Three of the seven units, so the same `loginctl enable-linger` covers every
process on this machine. They are named tunnels on subdomains we control, which is what an
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
