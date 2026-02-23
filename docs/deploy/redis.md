# Redis Shared Store Setup

Use Redis when running multiple tollbooth instances or when you need state to survive restarts.

## When to use Redis

- Single instance, ephemeral workloads: in-memory stores are usually enough.
- Multiple instances behind a load balancer: Redis is recommended.
- Restart-sensitive workloads (rate limits, time sessions, verification cache): Redis is recommended.

## Config

```yaml
stores:
  redis:
    url: "redis://localhost:6379"
    prefix: "tollbooth-prod"

  rateLimit:
    backend: redis

  verificationCache:
    backend: redis

  timeSession:
    backend: redis
```

If one store needs different Redis connection details:

```yaml
stores:
  redis:
    url: "redis://shared:6379"
    prefix: "tollbooth"

  timeSession:
    backend: redis
    redis:
      url: "redis://sessions:6379"
      prefix: "tollbooth-sessions"
```

## Local docker-compose

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  tollbooth:
    image: ghcr.io/loa212/x402-tollbooth:latest
    depends_on:
      - redis
    volumes:
      - ./tollbooth.config.yaml:/app/tollbooth.config.yaml:ro
    ports:
      - "3000:3000"
```
