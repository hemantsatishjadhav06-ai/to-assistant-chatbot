# TO Assistant — Deploy & Test Guide

## What's new in this build

Live, complete Magento shoe data with resolved specs:

- New tool `get_shoes_with_specs(sport, brand?, shoe_type?, court_type?, width?, cushioning?, page_size?)` returns shoes from tennis/pickleball/padel categories with **brand, court_type, width, cushioning, shoe_type, shoe_weight, inner_material, outer_material, outsole, made_in_country, available UK/INDIA sizes** fully resolved from attribute option IDs to labels.
- New tool `list_brands()` returns every brand carried by the store (50 brands loaded live).
- Startup now pre-caches attribute options (`brands`, `court_type`, `width`, `cushioning`, `shoe_type`, `shoe_size`, `color`) from Magento so ID -> label resolution happens offline per request.
- Bug fix: `MAGENTO_BASE_URL` env containing `/rest/V1` no longer produces `/rest/V1/rest/V1`.

## Verified locally against live Magento

Health check passes (`magento_bearer: connected`). Sample chats tested end-to-end:

- "which shoe brands do you carry?" -> calls `list_brands`, returns full brand list.
- "Show me ASICS tennis shoes for men, include sizes and cushioning" -> calls `get_shoes_with_specs({sport:'tennis', brand:'ASICS', shoe_type:"Men's"})`, returns 4-5 products with sizes 6-13, cushioning High/Medium, court_type All Court, etc.
- "List padel shoes with full specs" -> calls `get_shoes_with_specs({sport:'padel'})`.

## Render deploy (one-time)

1. Push this folder to a GitHub repo (e.g. `tennisoutlet/to-assistant-chatbot`).
2. In Render dashboard -> **New +** -> **Blueprint** -> point at the repo. Render reads `render.yaml`.
3. On first deploy, Render will prompt for the two secrets marked `sync: false`:
   - `OPENROUTER_API_KEY` = `sk-or-v1-...` (current value in `.env`)
   - `MAGENTO_TOKEN` = `375syepu5xo13ejewk8mqekj100qxlnr`
4. Optional (for order lookups via OAuth): add `MAGENTO_CONSUMER_KEY`, `MAGENTO_CONSUMER_SECRET`, `MAGENTO_ACCESS_TOKEN`, `MAGENTO_ACCESS_TOKEN_SECRET`.
5. Click **Apply**. Render builds, installs deps, runs `node server.js`.
6. Your test URL will be `https://to-assistant-chatbot.onrender.com` (or whatever Render assigns).

### Already deployed?

Just push to the repo's main branch — Render auto-redeploys. Verify with:

```
curl https://<your-render-url>/api/health
# expect: {"status":"running","magento_bearer":"connected",...}
```

Open `https://<your-render-url>/` in a browser for the chat UI.

## Why I could not hand you a live URL

I do not have your Render API key or GitHub push access from this session, so I cannot deploy on your behalf. If you paste a Render API key (or invite a deploy key / connect a repo), I can trigger the deploy for you next run.
