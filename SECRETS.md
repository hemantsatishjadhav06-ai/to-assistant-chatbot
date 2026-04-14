# Secrets & environment variables

This file lists the env vars the service reads. **Values belong in Render dashboard env, never in git, never in chat.**

If any secret has ever been pasted into a chat window, an issue tracker, a PR description, or a commit message — rotate it. Rotate the whole key, not just the password suffix.

## Supabase (v4 memory layer)

| Name                         | Where from                                         | Used by                       | Notes                                             |
|------------------------------|----------------------------------------------------|-------------------------------|---------------------------------------------------|
| `SUPABASE_URL`               | Project Settings → API → Project URL               | `db.js`                       | Safe to log. Public.                              |
| `SUPABASE_SERVICE_ROLE_KEY`  | Project Settings → API → service_role (secret)     | `db.js`                       | **Server-only.** Bypasses RLS. NEVER ship to client. Rotate on any leak. |
| `SUPABASE_DB_URL` (optional) | Project Settings → Database → Connection string    | migrations/psql only          | Only needed if running `psql` locally; runtime uses the JS client. |

Do **not** expose the service_role key in the browser bundle, in `/api/health`, in client-visible errors, or in logs beyond "configured / not configured".

## Magento 2

| Name                         | Used by       | Notes |
|------------------------------|---------------|-------|
| `MAGENTO_REST`               | `server.js`   | Base URL, e.g. `https://tennisoutlet.in/rest/default/V1` |
| `MAGENTO_BEARER_TOKEN`       | `server.js`   | Integration admin token |
| `OAUTH_CONSUMER_KEY` + `OAUTH_CONSUMER_SECRET` + `OAUTH_ACCESS_TOKEN` + `OAUTH_ACCESS_TOKEN_SECRET` | `server.js` | Used for order search / OMS-side endpoints |

## OpenRouter

| Name                  | Used by     | Notes |
|-----------------------|-------------|-------|
| `OPENROUTER_API_KEY`  | `agents.js` | LLM requests |
| `OPENROUTER_MODEL`    | `agents.js` | Default model id |

## Feature flags (v4)

| Name                   | Default | Effect |
|------------------------|---------|--------|
| `WRITES_ENABLED`       | `false` | Master kill switch. When false, all transactional actions are rejected before they reach Magento/Unicommerce. |
| `ACTION_DRYRUN`        | `true`  | When true, actions log to `actions` table with status=`proposed` but do not execute externally. |
| `MEMORY_ENABLED`       | `true`  | When false, falls back to v3.3 in-memory session only. |

## Rotation checklist (run once after any leak)

1. Supabase → Settings → Database → Reset DB password. Update `SUPABASE_DB_URL` in Render.
2. Supabase → Settings → API → Rotate service_role key. Update `SUPABASE_SERVICE_ROLE_KEY` in Render.
3. Redeploy Render.
4. `curl https://<render-host>/api/health` → verify `"supabase":"connected"`.
5. Search the git history for any leaked values and force-push a history rewrite if found:
   ```
   git log -p | grep -iE 'sb_secret|postgres://.*@|SUPABASE_SERVICE_ROLE_KEY'
   ```

## Repo hygiene

- `.env` is git-ignored. Verify before any commit.
- Never write secrets in markdown examples. Use `<YOUR_KEY>` placeholders.
- `/api/health` returns only `connected` / `disconnected:<short reason>` — no values.
