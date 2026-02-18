# Deploy Tollbooth on Fly.io

## Prerequisites

- A [Fly.io](https://fly.io) account
- The [`flyctl` CLI](https://fly.io/docs/flyctl/install/) installed and authenticated (`fly auth login`)
- A `tollbooth.config.yaml` ready (see [Quickstart](../../README.md#quickstart))

## 1. Create the app

```bash
fly apps create my-tollbooth
```

## 2. Add `fly.toml`

Create `fly.toml` in your project root:

```toml
app = "my-tollbooth"
primary_region = "iad"           # pick the region closest to your upstream APIs

[build]
  image = "ghcr.io/loa212/x402-tollbooth:latest"

[env]
  LOG_FORMAT = "json"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"    # scale to zero when idle
  auto_start_machines = true     # wake on incoming request
  min_machines_running = 0

[[http_service.checks]]
  grace_period = "5s"
  interval = "15s"
  method = "GET"
  path = "/health"
  timeout = "2s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

> **Tip:** Pin a specific image tag (e.g. `ghcr.io/loa212/x402-tollbooth:0.3.0`) instead of `latest` for reproducible deploys.

## 3. Mount your config file

Tollbooth expects `tollbooth.config.yaml` at `/app/tollbooth.config.yaml` inside the container. Use a Fly volume or bake the config into a custom Dockerfile.

**Option A — Custom Dockerfile (recommended)**

Create a `Dockerfile.fly`:

```dockerfile
FROM ghcr.io/loa212/x402-tollbooth:latest
COPY tollbooth.config.yaml /app/tollbooth.config.yaml
```

Then update `fly.toml`:

```toml
[build]
  dockerfile = "Dockerfile.fly"
```

**Option B — Fly volume**

```bash
fly volumes create tollbooth_config --region iad --size 1
```

Add to `fly.toml`:

```toml
[mounts]
  source = "tollbooth_config"
  destination = "/data"
```

Then update the start command to point to the mounted config:

```toml
[processes]
  app = "start --config=/data/tollbooth.config.yaml"
```

You'll need to SSH in once to copy your config: `fly ssh console` then copy the file to `/data/`.

## 4. Set secrets

Set any environment variables your config references (e.g. `${API_KEY}`):

```bash
fly secrets set API_KEY=sk-your-key --app my-tollbooth
```

## 5. Deploy

```bash
fly deploy
```

## 6. Verify

```bash
# Health check
curl https://my-tollbooth.fly.dev/health
# → {"status":"ok"}

# x402 discovery (if enabled)
curl https://my-tollbooth.fly.dev/.well-known/x402

# Test a paid route — should return 402
curl -i https://my-tollbooth.fly.dev/weather
# → HTTP/2 402
```

## Notes

- Fly machines cold-start in ~1-2 seconds. Set `min_machines_running = 1` if you need zero cold starts.
- For multi-region deployments, duplicate the `[[vm]]` section or use `fly scale count 2 --region iad,cdg`.
- Logs: `fly logs --app my-tollbooth`
