# Deploy Tollbooth on Railway

## Prerequisites

- A [Railway](https://railway.com) account
- The [Railway CLI](https://docs.railway.com/guides/cli) installed and authenticated (`railway login`)
- A `tollbooth.config.yaml` ready (see [Quickstart](../../README.md#quickstart))

## Option A — Deploy from Docker image (recommended)

### 1. Create a project

```bash
railway init
```

### 2. Create a `Dockerfile`

Railway builds from a Dockerfile. Create `Dockerfile.railway`:

```dockerfile
FROM ghcr.io/loa212/x402-tollbooth:latest
COPY tollbooth.config.yaml /app/tollbooth.config.yaml
```

### 3. Configure the service

Create `railway.toml`:

```toml
[build]
  dockerfilePath = "Dockerfile.railway"

[deploy]
  healthcheckPath = "/health"
  healthcheckTimeout = 5
  restartPolicyType = "ON_FAILURE"
  restartPolicyMaxRetries = 3
```

Railway auto-detects the listening port via the `PORT` env var. Tollbooth defaults to port 3000, which Railway will route to automatically.

### 4. Set environment variables

Via the CLI:

```bash
railway variables set API_KEY=sk-your-key
```

Or in the Railway dashboard under your service's **Variables** tab.

### 5. Deploy

```bash
railway up
```

### 6. Expose the service

Generate a public domain in the Railway dashboard under **Settings → Networking → Generate Domain**, or via CLI:

```bash
railway domain
```

## Option B — Deploy from source with Dockerfile

If you've cloned the tollbooth repo and want to build from source:

### 1. Clone and configure

```bash
git clone https://github.com/Loa212/x402-tollbooth.git
cd x402-tollbooth
```

Add your `tollbooth.config.yaml` to the project root.

### 2. Create `railway.toml`

```toml
[build]
  dockerfilePath = "Dockerfile"

[deploy]
  healthcheckPath = "/health"
  healthcheckTimeout = 5
  restartPolicyType = "ON_FAILURE"
  restartPolicyMaxRetries = 3
```

The repo's existing `Dockerfile` builds tollbooth from source. You'll need to ensure your config file is copied in. Add this line at the end of the `Dockerfile`:

```dockerfile
COPY tollbooth.config.yaml /app/tollbooth.config.yaml
```

### 3. Set variables and deploy

```bash
railway variables set API_KEY=sk-your-key
railway up
```

## Verify

```bash
# Replace with your Railway domain
DOMAIN="your-app.up.railway.app"

# Health check
curl https://$DOMAIN/health
# → {"status":"ok"}

# Test a paid route — should return 402
curl -i https://$DOMAIN/weather
# → HTTP/2 402
```

## Notes

- Railway automatically provisions HTTPS and routes traffic to your container's listening port.
- For custom domains, add them in **Settings → Networking → Custom Domain**.
- Logs are available in the Railway dashboard or via `railway logs`.
- Railway supports auto-deploy from a linked GitHub repo — push to `main` and it redeploys automatically.
