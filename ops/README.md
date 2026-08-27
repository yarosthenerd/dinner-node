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
