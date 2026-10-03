# dsh-web-search-firecrawl

A **Firecrawl-backed search provider** for the [DeepSeek Harness](https://www.deepseek.com/harness/)
web capability seam (`ctx.web`). It registers under the provider id `firecrawl`.

## Why this exists

The only search provider the harness ships is `@deepseek-ai/dsh-web-search-deepseek`. It implements
search as an Anthropic-compatible Messages call (`POST {baseURL}/messages` with the native
`web_search_20250305` server tool) — that is, **it only speaks the Anthropic Messages protocol**.

Firecrawl is a standalone retrieval API (`POST {baseURL}/search`) with no `/messages` route, so
pointing `web-search-deepseek.baseURL` at `https://api.firecrawl.dev` can only ever yield:

```
HTTP 404: POST /messages is not a Firecrawl API endpoint.
```

This plugin supplies the missing half: a real provider that calls Firecrawl's `/search` endpoint.

Unlike the DeepSeek provider (a full auxiliary model turn), this is a **dedicated retrieval
endpoint**: one HTTP round trip, structured results, no extra model turn and no generated tokens.

## Configuration

```yaml
# Select the Firecrawl provider. The deepseek-official provider can stay registered (its settings
# page keeps working) but must not also be *selected*, or the seam throws WEB_PROVIDER_AMBIGUOUS.
# Note: a patch's `config` replaces the whole config, it is NOT deep-merged, so every other field
# on the row (here `fetchProvider`) has to be restated.
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: firecrawl
    fetchProvider: http

# New rows must go through `insert`: a non-insert patch targeting an unknown id is warned about
# and skipped by the loader.
- insert:
    - id: web-search-firecrawl
      name: dsh-web-search-firecrawl
      config:
        apiKeyEnv: FIRECRAWL_API_KEY
        baseURL: https://api.firecrawl.dev/v1
        maxResults: 5
        timeoutMs: 30000
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | unset | Literal Firecrawl key; wins over `apiKeyEnv` (prefer the reference so no secret lands in config) |
| `apiKeyEnv` | `FIRECRAWL_API_KEY` | Credential reference resolved through `ctx.credentials` at every search; falls back to the process environment when that service is absent |
| `baseURL` | `https://api.firecrawl.dev/v1` | Firecrawl API base; `/search` is appended (trailing slashes are ignored) |
| `maxResults` | `5` | Result count requested when the seam sends no `maxResults`; 1–100 |
| `timeoutMs` | `20000` | Per-search wall-clock bound in milliseconds |

## Behaviour

- `search()` passes the seam's `maxResults` straight through as Firecrawl's `limit` (so it never
  over-fetches), falling back to the configured `maxResults`, clamped to 1–100.
- Response mapping: both the flat v1 `data[]` shape and the grouped `data.web[]` shape are
  accepted; sources are deduplicated by `url`; `title` comes from the same-named field; `snippet`
  comes from `description` (or `snippet`) and is truncated past 1200 characters; `publishedAt`
  appears only when Firecrawl supplies `date` / `publishedDate` / `metadata.publishedTime`.
- Error codes reuse the seam's vocabulary: `WEB_PROVIDER_CREDENTIAL_MISSING` for a missing key,
  `WEB_ABORTED` for caller cancellation, and `WEB_PROVIDER_ERROR` for everything else (non-2xx,
  timeout, unparseable body, `success: false`). Messages always name the endpoint actually used.
- Redirects are refused (`redirect: "error"`); options are snapshotted once per operation, so one
  search never mixes two config generations.

## Install

1. Put the package at `<profile>/plugins/dsh-web-search-firecrawl`.
2. Link `<profile>/node_modules/dsh-web-search-firecrawl` to that directory (the layout pnpm uses
   for `file:` dependencies).
3. Declare it in the profile's `package.json`:
   `"dsh-web-search-firecrawl": "file:./plugins/dsh-web-search-firecrawl"`.
   The profile's direct dependencies are what the runtime resolution table is built from; without
   the declaration the loader cannot import the package by name.
4. Add the `insert` row and the `web` override above to the profile's `cordis.patch.yml`.
5. Saving takes effect immediately — no DSH Desktop restart was needed in testing.

## Test

```bash
FIRECRAWL_API_KEY=fc-... node test/offline.mjs
# or read the key from a `KEY: value` file instead:
node test/offline.mjs --var DEEPSEEK_API_KEY --credentials ~/.dsh/.credentials.yaml
```

The suite exercises the module surface, endpoint joining, both response shapes, dedup and snippet
truncation, the live Firecrawl call, and five failure paths (missing credential, rejected key,
unreachable endpoint, caller cancellation, timeout). The live assertions are skipped when no key is
available, so it doubles as a smoke test.

The harness packages (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-web`,
`@deepseek-ai/dsh-credentials`) are resolved from the harness installation; the two seams this
plugin imports are stubbed inside the test when needed.

## Known limitations

- Only Firecrawl's web results are used; news/image sources are not requested.
- `description` is Firecrawl's digest rather than a citation excerpt, so a source with no
  `description` carries no `snippet`.
- It cannot be registered alongside `web-search-deepseek` without choosing one, or the seam throws
  `WEB_PROVIDER_AMBIGUOUS`.

## License

MIT
