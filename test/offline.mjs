// Acceptance test for dsh-web-search-firecrawl.
//
// Runs the plugin's real code path against the real Firecrawl API, using the harness's own
// `@deepseek-ai/schemastery` plus minimal stubs for the two seams this plugin imports
// (`@deepseek-ai/dsh-web`, `@deepseek-ai/dsh-credentials`).
//
// The offline half always runs. The live half needs a working Firecrawl key: export it, or
// point the test at an env var name and/or a `KEY: value` credentials file to read it from.
//
//   FIRECRAWL_API_KEY=fc-... node test/offline.mjs
//   node test/offline.mjs --var DEEPSEEK_API_KEY --credentials ~/.dsh/.credentials.yaml
//
// With no key the live assertions are skipped (still exit 0), so the suite doubles as a smoke
// test on a machine without credentials.
import { readFileSync } from "node:fs";

const PLUGIN = new URL("../lib/index.js", import.meta.url).href;

/** Parse `--var NAME` / `--credentials PATH`, defaulting to the plugin's own env var. */
function parseArgs(argv) {
  const parsed = {
    varName: process.env.FIRECRAWL_TEST_VAR ?? "FIRECRAWL_API_KEY",
    credentialsPath: process.env.FIRECRAWL_TEST_CREDENTIALS ?? undefined
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--var" && argv[i + 1] !== undefined) parsed.varName = argv[++i];
    else if (argv[i] === "--credentials" && argv[i + 1] !== undefined) parsed.credentialsPath = argv[++i];
  }
  return parsed;
}

const cli = parseArgs(process.argv.slice(2));

/** Resolve the live key from the environment first, then from a credentials file. */
function resolveLiveKey({ varName, credentialsPath }) {
  const ambient = process.env[varName];
  if (typeof ambient === "string" && ambient.length > 0) return { key: ambient, from: `env ${varName}` };
  if (credentialsPath === undefined) return undefined;
  try {
    const match = readFileSync(credentialsPath, "utf8").match(new RegExp(`^\\s*${varName}:\\s*(\\S+)\\s*$`, "mu"));
    return match === null ? undefined : { key: match[1], from: `credentials file (${varName})` };
  } catch {
    return undefined;
  }
}

const live = resolveLiveKey(cli);

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(label, why) {
  skipped += 1;
  console.log(`  SKIP  ${label} — ${why}`);
}

/** A fake plugin context: only the two seams the plugin touches. */
function makeContext(credentialValues) {
  const state = { provider: undefined };
  const ctx = {
    web: {
      registerSearchProvider(provider) {
        state.provider = provider;
        return () => {};
      }
    },
    get(name) {
      if (name !== "credentials") return undefined;
      return {
        async resolve(ref) {
          const value = credentialValues[ref];
          return typeof value === "string" && value.length > 0 ? { value } : undefined;
        }
      };
    }
  };
  return { ctx, state };
}

async function expectError(label, run, expectedCode) {
  try {
    await run();
    check(label, false, "no error thrown");
  } catch (error) {
    check(label, error?.code === expectedCode, `code=${error?.code} message=${String(error?.message).split("\n")[0].slice(0, 120)}`);
  }
}

const plugin = await import(PLUGIN);
const { Config, FirecrawlSearchProvider, apply, inject, mapFirecrawlResponse, name, searchEndpoint } = plugin;

console.log("== module surface ==");
check("plugin name", name === "web-search-firecrawl", name);
check("injects the web seam", Array.isArray(inject) && inject.includes("web"), JSON.stringify(inject));
check("exports a Config schema", typeof Config === "function");
check("exports apply()", typeof apply === "function");

console.log("== endpoint mapping ==");
check("trailing slash dropped", searchEndpoint("https://api.firecrawl.dev/v1/") === "https://api.firecrawl.dev/v1/search", searchEndpoint("https://api.firecrawl.dev/v1/"));

console.log("== response mapping (synthetic) ==");
{
  const flat = mapFirecrawlResponse({
    success: true,
    data: [
      { url: "https://a.example/1", title: "A", description: "alpha" },
      { url: "https://a.example/1", title: "dup", description: "dup" },
      { url: "https://b.example/2", title: "", description: "" }
    ]
  });
  check("flat data[] mapped and deduped", flat.sources.length === 2, JSON.stringify(flat.sources));
  check("empty title/snippet omitted", flat.sources[1].title === undefined && flat.sources[1].snippet === undefined);
  check("truncated flag is provider-local false", flat.truncated === false);

  const grouped = mapFirecrawlResponse({ success: true, data: { web: [{ url: "https://c.example/3", description: "gamma" }] } });
  check("grouped data.web[] accepted", grouped.sources.length === 1 && grouped.sources[0].url === "https://c.example/3");

  const long = mapFirecrawlResponse({ success: true, data: [{ url: "https://d.example/4", description: "x".repeat(5000) }] });
  check("long description bounded", long.sources[0].snippet.length <= 1201, `${long.sources[0].snippet.length} chars`);
}
await expectError("success:false is an error", async () => mapFirecrawlResponse({ success: false, error: "bad key" }), "WEB_PROVIDER_ERROR");
await expectError("missing data[] is an error", async () => mapFirecrawlResponse({ success: true }), "WEB_PROVIDER_ERROR");

console.log("== registration through the real Config schema ==");
const { ctx, state } = makeContext(live === undefined ? {} : { [cli.varName]: live.key });
const config = new Config({
  apiKeyEnv: cli.varName,
  baseURL: "https://api.firecrawl.dev/v1",
  maxResults: 3,
  timeoutMs: 20_000
});
apply(ctx, config);
check("provider registered", state.provider?.id === "firecrawl", String(state.provider?.id));
check("provider reports available()", state.provider.available() === live !== undefined);

console.log("== live Firecrawl search ==");
if (live === undefined) {
  skip("live search", `no key found (set ${cli.varName}, or pass --var/--credentials)`);
} else {
  const live1 = await state.provider.search({ query: "OpenWrt OpenClash", maxResults: 3 });
  check("live search returned sources", live1.sources.length > 0, `${live1.sources.length} sources from ${live.from}`);
  check("live sources respect maxResults", live1.sources.length <= 3, `${live1.sources.length} sources`);
  check("every live source carries a url", live1.sources.every((source) => typeof source.url === "string" && source.url.startsWith("http")));
  console.log(JSON.stringify(live1.sources, null, 2));

  console.log("== narrow limits ==");
  const one = await state.provider.search({ query: "deepseek harness", maxResults: 1 });
  check("maxResults=1 honored", one.sources.length === 1, `${one.sources.length} sources`);
}

console.log("== failure paths ==");
{
  const missing = makeContext({});
  apply(missing.ctx, new Config({ apiKeyEnv: "FIRECRAWL_API_KEY_UNSET_IN_TEST", baseURL: "https://api.firecrawl.dev/v1" }));
  await expectError("missing credential", () => missing.state.provider.search({ query: "x" }), "WEB_PROVIDER_CREDENTIAL_MISSING");
}
if (live === undefined) {
  skip("rejected credential", "needs a live key to get a 401 back");
} else {
  const literal = makeContext({});
  apply(literal.ctx, new Config({ apiKey: "fc-0000000000000000000000000000000000000000", baseURL: "https://api.firecrawl.dev/v1" }));
  await expectError("rejected credential", () => literal.state.provider.search({ query: "x" }), "WEB_PROVIDER_ERROR");
}
{
  const offline = makeContext({ DEEPSEEK_API_KEY: "not-a-real-key" });
  apply(offline.ctx, new Config({ apiKeyEnv: "DEEPSEEK_API_KEY", baseURL: "http://127.0.0.1:9/v1", timeoutMs: 3_000 }));
  await expectError("unreachable endpoint", () => offline.state.provider.search({ query: "x" }), "WEB_PROVIDER_ERROR");
}
{
  const controller = new AbortController();
  controller.abort(new Error("test cancellation"));
  await expectError("caller cancellation", () => state.provider.search({ query: "x" }, controller.signal), "WEB_ABORTED");
}
{
  const quick = new FirecrawlSearchProvider(() => ({
    apiKey: "fc-0000000000000000000000000000000000000000",
    apiKeyEnv: "FIRECRAWL_API_KEY",
    baseURL: "https://api.firecrawl.dev/v1",
    maxResults: 5,
    timeoutMs: 1
  }));
  try {
    await quick.search({ query: "x" });
    check("timeout surfaces as WEB_PROVIDER_ERROR", false, "no error thrown");
  } catch (error) {
    check(
      "timeout surfaces as WEB_PROVIDER_ERROR",
      error?.code === "WEB_PROVIDER_ERROR" && /timed out after 1ms/u.test(String(error.message)),
      String(error?.message).split("\n")[0].slice(0, 120)
    );
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
