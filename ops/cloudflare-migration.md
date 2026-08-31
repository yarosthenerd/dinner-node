# Moving dinnernode.xyz to Cloudflare

Why: Cloudflare named tunnels give each node a stable https hostname on a
domain we control, with no open ports, no home IP in the on-chain registry and
no certificate to manage. They write DNS records into a Cloudflare zone, so the
zone has to live at Cloudflare. The CNAME-only alternative that avoids moving
the zone is a Business plan feature at $200/month.

Cost: nothing. Cloudflare's free plan hosts DNS, and Cloudflare Tunnel is free.
This is a nameserver change, not a registrar transfer, so there is no fee and
no transfer lock. The domain stays at Name.com.

Time: 5 to 10 minutes to add the zone, 2 minutes to change the nameservers,
then usually under an hour for the delegation to flip. Cloudflare emails when
the zone goes active.

Downtime: none expected. The Vercel nameservers keep answering until the
delegation flips, and the Cloudflare ones serve identical records from the
moment the zone is added. The failure mode is a record that did not come
across, which is why step 2 is a comparison rather than a glance.

## 0. What is true before you start

Captured 2026-08-28 from live DNS. This is the state to restore to if anything
goes wrong.

```
dinnernode.xyz        A      64.29.17.65
dinnernode.xyz        A      216.198.79.1
dinnernode.xyz        TXT    google-site-verification=rNRUbfyo8YtFHUqyyt8gpRaqq-bhlIhvdliPeucopGA
dinnernode.xyz        TXT    google-site-verification=YuhmjDLs_ROqb0zsktg5XvUWrz0vriC0V8Yq0wW1j5E
www.dinnernode.xyz    CNAME  cname.vercel-dns.com
api.dinnernode.xyz    A      64.29.17.1
api.dinnernode.xyz    A      216.198.79.1

registrar    Name.com, Inc.
nameservers  ns1.vercel-dns.com, ns2.vercel-dns.com
DNSSEC       not enabled (delegationSigned: false)
MX           none
```

Two facts that make this safe. **DNSSEC is off**, so there is nothing to
disable first; moving a signed zone without unsigning it breaks resolution
completely. **There is no mail**, so no MX to lose.

Re-read the live state at any point with:

```
for h in dinnernode.xyz www.dinnernode.xyz api.dinnernode.xyz; do
  echo "== $h"; dig +short $h; dig +short CNAME $h
done
dig +short TXT dinnernode.xyz
dig +short NS dinnernode.xyz
```

## 1. Add the zone at Cloudflare

1. Create a free Cloudflare account if there is not one.
2. Add a site, enter `dinnernode.xyz`, choose the **Free** plan.
3. Cloudflare scans the existing records and pre-fills them. Do not accept the
   import on trust.

## 2. Compare the imported records against section 0

Every row above must be present, and **every record must be DNS only, not
proxied**. In the Cloudflare records table that is the grey cloud rather than
the orange one.

Proxying the apex would put Cloudflare's CDN in front of Vercel's: a second
cache layer, a second TLS terminator, and a class of failure that looks like
the site being stale for reasons nothing in the repo explains. We want
Cloudflare for DNS and tunnels only.

The two `google-site-verification` TXT records are the ones an import most
often drops. Losing them does not break the site; it silently un-verifies
Search Console.

Do not add the tunnel hostnames yet. `cloudflared` creates those itself, in
step 5.

## 3. Change the nameservers

Cloudflare shows two assigned nameservers, of the form `x.ns.cloudflare.com`.
Replace the Vercel pair with them.

The domain is registered at Name.com but was bought through Vercel, so try
Vercel first: **Vercel dashboard, Domains, dinnernode.xyz, nameservers**. If
the field is not editable there, do it at Name.com under the same domain.

Leave both Vercel nameservers behind, replaced rather than appended. A mixed
delegation resolves inconsistently depending on which nameserver a resolver
happens to ask.

## 4. Verify before touching anything else

Wait for the Cloudflare email, then:

```
dig +short NS dinnernode.xyz
curl -sS -o /dev/null -w "apex   %{http_code}\n" https://dinnernode.xyz
curl -sS -o /dev/null -w "www    %{http_code}\n" https://www.dinnernode.xyz
dig +short TXT dinnernode.xyz
```

Expected: two `ns.cloudflare.com` nameservers, 200 from both hosts, both
verification TXT records still present. **Stop here if any of that is wrong**
and put the section 0 nameservers back. The old records are still live in
Vercel's DNS, so reverting is one field and one propagation wait.

## 5. Install cloudflared and create the tunnels

One tunnel per process that needs to be reachable. Today that is two: node 1
and discovery. Node 2 joins the same way when it has its own tunnel.

Installed 2026-08-31 as a user-local binary rather than from apt, because
this machine has no passwordless sudo and a user systemd unit does not need
root to run one. The units point at `/home/yaros/.local/bin/cloudflared`. The
cost of this choice is that apt will not update it: re-run the download to
upgrade.

```
# install, no root required
curl -fsSL -o ~/.local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x ~/.local/bin/cloudflared
cloudflared --version

# the apt route, if root is available and automatic updates are wanted. Change
# ExecStart in both units in ops/ back to /usr/bin/cloudflared if you use it.
# curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
#   | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
# echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
#   | sudo tee /etc/apt/sources.list.d/cloudflared.list
# sudo apt-get update && sudo apt-get install -y cloudflared

# authorise this machine against the zone, opens a browser
cloudflared tunnel login

# one named tunnel per process
cloudflared tunnel create dinnernode-node1
cloudflared tunnel create dinnernode-discovery

# the DNS records, created by cloudflared in the zone from step 1
cloudflared tunnel route dns dinnernode-node1     node1.dinnernode.xyz
cloudflared tunnel route dns dinnernode-discovery discovery.dinnernode.xyz
```

`tunnel login` writes a certificate to `~/.cloudflared/cert.pem` and each
`create` writes a credentials JSON beside it. Both are secrets. They are
outside the repo and must stay there.

## 6. Point the tunnels at the local ports

`~/.cloudflared/node1.yml`:

```
tunnel: dinnernode-node1
credentials-file: /home/yaros/.cloudflared/<node1-tunnel-id>.json
ingress:
  - hostname: node1.dinnernode.xyz
    service: http://localhost:4173
  - service: http_status:404
```

`~/.cloudflared/discovery.yml`:

```
tunnel: dinnernode-discovery
credentials-file: /home/yaros/.cloudflared/<discovery-tunnel-id>.json
ingress:
  - hostname: discovery.dinnernode.xyz
    service: http://localhost:4175
  - service: http_status:404
```

Run them in the foreground once each, to see the errors:

```
cloudflared tunnel --config ~/.cloudflared/node1.yml run
cloudflared tunnel --config ~/.cloudflared/discovery.yml run
```

Then, from anywhere:

```
curl -sS https://node1.dinnernode.xyz/health | head -c 200; echo
curl -sS https://discovery.dinnernode.xyz/health; echo
```

**4175, not 4174.** 4174 is node 2. The default port in `src/discovery.ts`
predates there being a second node, so `ops/dinnernode-discovery.service` sets
`DISCOVERY_PORT=4175` explicitly and the tunnel has to match it.

## 7. Make them survive a reboot

The units are in the repo: `ops/dinnernode-tunnel-node1.service` and
`ops/dinnernode-tunnel-discovery.service`. Install them the same way as the
node units, which `ops/README.md` describes.

```
cp ops/dinnernode-tunnel-node1.service ops/dinnernode-tunnel-discovery.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dinnernode-tunnel-node1.service
systemctl --user enable --now dinnernode-tunnel-discovery.service
```

**Then retire the ngrok one**, which is still running as
`dinnernode-tunnel.service` and holds the static domain node 1 answers on
today. Stop it only after `https://node1.dinnernode.xyz/health` returns 200,
and update `PUBLIC_URL` in the same pass, or the node keeps announcing an
address that no longer resolves:

```
systemctl --user disable --now dinnernode-tunnel.service
```

## 7a. State after the install, 2026-08-31

Both tunnels are installed, enabled and connected, with two QUIC connections
each to `vie05`/`vie06` and `beg01`.

```
node1.dinnernode.xyz      -> tunnel 2da0573e-bf75-4d14-b02a-ea151ff902c1 -> localhost:4173
discovery.dinnernode.xyz  -> tunnel 7243325d-e4e9-4124-84bb-6a13385bb0f4 -> localhost:4175
```

Verified from outside: `node1.dinnernode.xyz/health` 200,
`discovery.dinnernode.xyz/providers` 200, `POST /challenge` signs a message
whose `url` line is the new hostname, and `POST /lanjob` through the tunnel is
refused with 403 because cloudflared sets `cf-connecting-ip`.

`PUBLIC_URL` in `.env` is now `https://node1.dinnernode.xyz` and node 1
announces it. `DISCOVERY_URL` stays `http://localhost:4175` on both nodes:
they share the machine with the listener, so routing their announce out to
Cloudflare and back would buy nothing.

Two things did not land with this step:

- **The ngrok unit is still running.** `dinnernode-tunnel.service` still
  publishes port 4173, and nothing announces its hostname any more. Retire it
  with `systemctl --user disable --now dinnernode-tunnel.service` once the
  Vercel redeploy below is confirmed.
- **Node 2 still has no public URL,** and its `PUBLIC_URL` in `.env.node2` is
  a LAN address that is now also stale: the machine is `192.168.3.8` and the
  file says `192.168.5.98`. It did not announce at all after the restart,
  because `announce()` awaits the engine warm and node 2's warm is blocked
  behind `OLLAMA_MAX_LOADED_MODELS=1` with node 1's 22GB model resident. So
  the failover target needs the sudo item in `TODO.md` and a third tunnel,
  created the same way as these two.

## 8. What changes in the project once the hostnames exist

- `.env` and `.env.node2`: `PUBLIC_URL=https://node1.dinnernode.xyz` and the
  node 2 equivalent, plus `DISCOVERY_URL=https://discovery.dinnernode.xyz` on
  both, so `announce()` has somewhere to announce to.
- Vercel: `VITE_DISCOVERY_URL=https://discovery.dinnernode.xyz`, then redeploy.
  This is the variable whose absence is the standing blocker on the failover
  demo.
- The ngrok tunnel and its static domain can be retired once node 1 answers on
  its own hostname.

**The signed-nonce challenge is in the tree as of 2026-08-28**, so a publicly
reachable discovery is no longer a publicly reachable prompt-theft route. It is
not backward compatible: an old node announcing to a new discovery is rejected,
and a new node finds no nonce endpoint on an old discovery. **Restart both
nodes and discovery together** when this deploys, before or after the tunnels,
it does not matter which.
