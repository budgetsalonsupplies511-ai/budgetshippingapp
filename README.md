# Budget Shipping App

Embedded Shopify shipping dashboard and carrier-rate service for Budget Salon Supplies.

## Shipping rules

- Retail Standard, Express, and free-shipping thresholds are configurable.
- Retail rules can be overridden by Australian state.
- Selected bulky products can use custom prices or live carrier rates.
- Trade and Freelance customers use live carrier pricing.
- Australia Post Shipping & Tracking contract rates are supported.
- Aramex and TNT/FedEx credential panels are available for later connection.

## Local development

```bash
pnpm install
pnpm dev
```

Run a production build with:

```bash
pnpm build
```

## Runtime configuration

Runtime secrets and carrier credentials must be configured through the hosting environment or the authenticated Shopify dashboard. Never commit them to Git.

The application expects the Cloudflare bindings declared in `.openai/hosting.json`, including the `DB` D1 binding.

## Security

- Shopify session tokens are verified server-side.
- Carrier credentials are encrypted before being stored.
- `.env` files, build output, dependencies, and deployment artifacts are excluded by `.gitignore`.
