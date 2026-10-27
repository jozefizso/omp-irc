# omp-irc

IRC communication between [oh-my-pi](https://github.com/can1357/oh-my-pi) agents, using a native [Ergo](https://ergo.chat/) IRC server. One omp session can own the server; agents on Windows, Linux/WSL2, or another machine join the same channel and exchange channel or direct messages.

## Install

Requires **omp 18.12.6 or newer**. The extension uses host-provided schemas and Node built-ins; there are no runtime npm dependencies and no build step.

Clone this repository on each machine, then link the absolute checkout path:

```sh
omp plugin link /absolute/path/to/omp-irc
```

On Windows, use a path such as `W:/integrations-workspace/omp-irc`. Restart omp after linking. For a single run without installation:

```sh
omp -e /absolute/path/to/omp-irc
```

`package.json` declares the `omp.extensions` entry point and packaged files. A maintainer can create a distributable npm archive with `bun pm pack`; the package does not bundle Ergo. To remove a linked installation, run `omp plugin uninstall omp-irc`.

## Quick start: Windows ↔ WSL2

After linking the plugin in both environments and restarting omp:

**First omp instance:**

```text
/irc host
```

**Second omp instance:**

```text
/irc join
```

That is all the server setup needed for local use. The host downloads the official Ergo **2.19.1** release on first use, checks its pinned SHA-256, extracts it, creates a loopback-only configuration and database, starts the server, and joins the agent. Subsequent starts reuse the installed binary and database. There is no Docker, Go, certificate setup, or YAML editing for this workflow. Default: `127.0.0.1:16667`, channel `#omp`, unique OS/PID-based nicknames.

Send from either instance:

```text
/irc send {"target":"#omp","text":"hello from the other agent"}
```

In the receiving instance, inspect the exact messages **without a model call**:

```text
/irc receive
```

Check state with `/irc status`. Stop the owned server with `/irc server-stop`, or exit its owning omp session. For explicit nicknames or a different port:

```text
/irc host {"port":16668,"nick":"windows-agent","channel":"#work"}
/irc join {"port":16668,"nick":"linux-agent","channel":"#work"}
```

`/irc host` prints a join command matching its port/channel; run that printed command in the **other** omp instance. If a server is already listening on the port, `/irc host` joins it instead of starting another, so running `/irc host` in both instances also works. `/irc join` also accepts a hostname, or JSON with connection options such as TLS and `passwordEnv`.

**Requirements:** automatic setup supports Windows x64, Linux x64, and Linux arm64. It needs internet access on first use. Windows uses its built-in ZIP-capable `System32/tar.exe` explicitly, including when launched from Git Bash; Linux requires `tar` on PATH. No automatic setup is attempted until `/irc host` or the `irc_host` tool is explicitly invoked. Windows x64 and Linux x64 were exercised with fresh downloads; Linux arm64 was not exercised.

**Storage:** generated files live under `~/.omp/irc` in the hosting OS. Set `OMP_IRC_HOME` before launching omp to choose another directory. A binary cache is shared across local hosts; configuration/database directories are per port. Do not share managed directories between Windows and Linux or edit their configurations; use the manual workflow below for custom servers. A hard-killed setup can leave a lock directory: the error reports the exact path to remove after confirming no setup is still running.

**Network boundary:** automatic hosting listens only on loopback. This works for two local instances and was verified across Windows/WSL2 **mirrored networking**. For **WSL2 NAT**, the suggested setup-free direction is `/irc host` inside WSL and `/irc join` on Windows, using WSL2's normally enabled localhost forwarding. That NAT route was not verified on this mirrored-networking machine; custom WSL/firewall settings can prevent forwarding. Hosting on Windows and connecting from NAT-mode WSL via the host gateway will not reach a loopback-only listener. Separate machines, or configurations without working localhost forwarding, require the advanced secured-listener configuration below.

## Advanced: prepare a custom Ergo server

1. Download the native release for your OS/architecture from [official Ergo releases](https://github.com/ergochat/ergo/releases). Version **2.19.1** is a suitable baseline. Verify the archive against that release's checksum file before extracting. Use `ergo.exe` on Windows or `ergo` on Linux; no Docker or Go installation is needed.
2. Copy the shipped `default.yaml` to `ircd.yaml` in the extracted directory. Keep the accompanying files there. Set `network.name` and `server.name` as desired.
3. Configure `server.listeners`. For a loopback-only development server without certificates, **replace the entire listeners mapping** with:

   ```yaml
   server:
     # Keep the other shipped server settings.
     listeners:
       "127.0.0.1:6667": {}
   ```

   Do not leave the shipped TLS listener enabled unless its certificate/key files exist. Do not replace the rest of the full configuration with this fragment.
4. From the extracted directory, run `./ergo initdb --conf ircd.yaml` once (Windows PowerShell: `.\ergo.exe initdb --conf ircd.yaml`). Do not initialize an existing database again.

For clients on other machines, bind a reachable private interface instead of loopback and use **TLS plus authentication**. Example fragment for a certificate whose subject/SAN matches `irc.dev.example`:

```yaml
server:
  listeners:
    "192.168.1.20:6697":
      tls:
        cert: fullchain.pem
        key: privkey.pem
  password: "$2a$...replace-with-the-generated-hash..."
accounts:
  login-via-pass-command: false
```

Generate the password hash interactively with `./ergo genpasswd` or `.\ergo.exe genpasswd`; place its output in `server.password`. Keep the plaintext password only in an environment variable on each client, e.g. `OMP_IRC_PASSWORD`. The plugin reads it via `passwordEnv`, so the secret is not in tool arguments or chat. For a private CA, supply the CA PEM path via `caFile`; hostname verification stays enabled. Self-signed certificates must be trusted explicitly and match the connection hostname. There is no insecure TLS mode.

Merge these values into the shipped configuration. With a shared server password, disable `accounts.login-via-pass-command` as shown so PASS is not also treated as an account login; otherwise Ergo rejects the default combination unless SASL bypass is enabled.

Restrict the firewall to the intended peers/subnet. Plaintext IRC exposes both messages and the shared password; reserve it for trusted loopback or an appropriately secured private tunnel. Ergo controls history retention, registrations, and access policy; review its shipped defaults before sharing sensitive project context.

## Start the server from omp

In the omp session that will own the server:

```text
/irc server-start {"binary":"C:/tools/ergo/ergo.exe","config":"C:/tools/ergo/ircd.yaml"}
```

Linux equivalent:

```text
/irc server-start {"binary":"/home/dev/ergo/ergo","config":"/home/dev/ergo/ircd.yaml"}
```

Paths are resolved relative to the session working directory. The process runs with its configuration directory as cwd, so Ergo's relative database/certificate paths work. Startup waits for Ergo's `Server running` log, not merely a spawned PID. Keep that console info log enabled in custom configurations. Startup errors include bounded process output.

The server belongs to this omp session: normal session shutdown stops it. `/irc server-stop` stops it explicitly and disconnects all attached clients. The plugin does not adopt or stop independently launched servers. To keep a server independent of omp's lifetime, run Ergo separately and use only the connection tools.

## Join and communicate

In the first omp:

```text
/irc connect {"host":"127.0.0.1","port":6667,"nick":"windows-agent","channel":"#omp"}
```

In the other omp, use a distinct nickname and the same server/channel:

```text
/irc connect {"host":"irc.dev.example","port":6697,"nick":"linux-agent","channel":"#omp","tls":true,"passwordEnv":"OMP_IRC_PASSWORD","caFile":"/home/dev/certs/dev-ca.pem"}
```

For two local clients, both can use the first example with different nicknames. Once connected, ask the agent:

> Use irc_send to send “Ready to review your changes” to #omp.

Or send without a model turn:

```text
/irc send {"target":"#omp","text":"Ready to review your changes"}
/irc send {"target":"linux-agent","text":"Please inspect the Linux build"}
/irc status
/irc disconnect
```

Slash-command arguments are **JSON**, not shell syntax. Incoming messages are labeled untrusted network content and appended to agent context. By default they **do not start an idle agent turn**: prompt the agent to read/reply, or use `irc_receive` to wait during a task. Set `"wake":true` when connecting only if you want incoming messages to trigger agent work; automated peers can otherwise create costly reply loops. No automatic broadcasting of assistant output occurs: replies use `irc_send` explicitly.

IRC nicknames are routing identifiers, not authenticated identities. A peer's requests do not grant permission to execute commands or disclose secrets. Use a private authenticated server and only connect agents you intend to collaborate with.

### Windows ↔ WSL2

Install/link the plugin in **both** omp environments. A Windows path such as `W:/integrations-workspace/omp-irc` is usually `/mnt/w/integrations-workspace/omp-irc` inside WSL; binaries, CA paths, and environment variables must use the owning process's OS conventions.

- **WSL2 mirrored networking:** localhost connectivity may allow both sides to use `127.0.0.1`, subject to Windows/Hyper-V firewall policy.
- **WSL2 NAT, Windows hosts Ergo:** inside WSL, `ip route show default` normally identifies the Windows host gateway. Bind Ergo to the appropriate Windows interface, connect the Linux agent to that gateway, and permit only the WSL subnet in Windows Firewall. A loopback-only Windows listener is not reachable through the gateway.
- **WSL hosts Ergo:** Windows often forwards WSL localhost ports; if not available, use the address reported by `hostname -I` in WSL, bind the matching interface, and check firewall policy. WSL addresses can change after restart.

Do not assume a DNS nameserver address is the Windows host: DNS tunneling can make it unrelated. For TLS, use a hostname resolving to the chosen host address and matching the certificate. These networking settings are outside the plugin; it never modifies firewall rules or WSL configuration.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `irc_host` | Join the local server on the port, or provision and start Ergo and join it; optional `port`, `nick`, `channel`, `wake`. `hosted` reports whether this session owns the server. |
| `irc_join` | `irc_connect` with local defaults (`127.0.0.1:16667`, `#omp`, unique nickname); any option can be overridden. |
| `irc_server_start` | Start native Ergo with `binary` and `config` paths. |
| `irc_server_stop` | Stop this session's owned server. |
| `irc_connect` | Connect and confirm channel JOIN; takes `host`, `port`, `nick`, `channel`, optional `tls`, `caFile`, `passwordEnv`, `wake`. |
| `irc_send` | Send `{target,text}` to a channel or nickname; long UTF-8 text is split into IRC-sized messages. |
| `irc_receive` | Drain the inbox; optional `waitMs` from 0–20000 waits for a message. |
| `irc_status` | Connection, owned process state, pending inbox count, and overflow count; no connection password. |
| `irc_disconnect` | Disconnect this client without stopping Ergo. |

`irc_host`, `irc_join`, `irc_status`, `irc_connect`, `irc_send`, and `irc_receive` are always in the model's tool list; the remaining tools are discoverable (`xd://` when omp's `tools.xdev` is enabled). One connection and one owned server per extension/session. Inbox capacity: 200 messages, dropping oldest on overflow and reporting `dropped` when drained. Incoming messages also enter context; the inbox limit is not a session-history retention policy. Sending confirms a socket write, **not** peer receipt or execution. No offline replay, acknowledgement protocol, delivery guarantee, automatic reconnect, or SASL/account login is implemented. Reconnect explicitly after network loss. Use unique ASCII nicknames and ordinary `#channels` for Ergo's default identifier policy.

After JOIN, numeric server errors (for example an unknown message destination) do not disconnect the client. `irc_status` exposes the latest as `client.lastServerError` until the next connection. Check this field when a socket write succeeded but the peer did not receive a message.

## Development

```sh
bun install
bun run check
bun test
```

Development dependencies supply omp's actual extension types; they are not shipped or needed at runtime. Protocol and extension tests use isolated local TCP servers; provisioning integrity is tested in an isolated child process. For a manual end-to-end check, run `/irc host` in one omp, `/irc join` in another, send a message and inspect it with `/irc receive`; then stop the server. Use `/irc server-start` for an externally configured server. Do not use a public unauthenticated listener for testing.

Verified with omp 18.12.6 and Ergo 2.19.1: a Windows omp session started the server; actual Windows and Linux WSL2 model agents exchanged a channel message and a direct reply using `irc_send` / `irc_receive`. This machine used mirrored WSL networking and loopback. Separate real-Ergo smoke checks verified certificate rejection, explicit CA trust, wrong-password rejection, successful authenticated TLS JOIN, and server shutdown. Installation was checked with `omp plugin link` in an isolated config directory, followed by plain `omp --mode rpc` (without `-e`) successfully executing `/irc status`. A local protocol smoke also verified continued receive/send after a post-JOIN destination error. NAT networking and separate physical machines were not exercised.

Automatic hosting was additionally verified with clean temporary storage on both Windows x64 and Linux x64: official release download and checksum verification, config/database creation, native server startup, Windows/WSL peer messaging, explicit inbox display, cached Windows restart, and shutdown. Temporary servers and generated smoke data were removed.

## License

MIT. Copyright 2026 Cisco Systems, Inc. and its affiliates.
