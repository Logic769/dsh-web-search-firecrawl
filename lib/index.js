import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { WebError } from "@deepseek-ai/dsh-web";
//#region lib/types/provider.js
/**
 * Firecrawl-backed search through `POST {baseURL}/search`.
 *
 * Unlike the DeepSeek provider (`dsh-web-search-deepseek`), which spends a full auxiliary
 * Messages turn on the native `web_search_20250305` server tool, this provider is a
 * dedicated retrieval endpoint: one HTTP round trip, structured `data[]` results, no
 * model turn and no generated tokens. It therefore fits deployments that hold a Firecrawl
 * API key instead of a DeepSeek key, or that prefer a real search index over
 * server-side retrieval inside a model call.
 *
 * The wire format and the native `fetch` client are provider-private and do not use `ctx.llm`.
 * @module dsh-web-search-firecrawl/provider
 */
/** Stable id this provider registers under. */
const FIRECRAWL_PROVIDER_ID = "firecrawl";
/**
 * Default Firecrawl API base, including `/v1`; `/search` is appended.
 * `$FIRECRAWL_BASE_URL` does not override it — this plugin is not shipped by the harness,
 * so its endpoint is configured per deployment through plugin config only.
 */
const FIRECRAWL_DEFAULT_BASE_URL = "https://api.firecrawl.dev/v1";
/** Default credential reference resolved through `ctx.credentials` per search. */
const FIRECRAWL_DEFAULT_API_KEY_ENV = "FIRECRAWL_API_KEY";
/** Default source cap requested from Firecrawl when the seam sends no `maxResults`. */
const FIRECRAWL_DEFAULT_MAX_RESULTS = 5;
/** Largest `limit` Firecrawl accepts on `/search`. */
const FIRECRAWL_MAX_RESULTS = 100;
/** Default per-search wall-clock bound, in milliseconds. */
const FIRECRAWL_DEFAULT_TIMEOUT_MS = 20_000;
/** Upper bound on one source excerpt, so a long `description` cannot flood the context. */
const SNIPPET_MAX_CHARS = 1_200;
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = "dsh-web-search-firecrawl/0.1.0";
/**
 * Normalize the configured base into the `/search` endpoint: trailing slashes are dropped so a
 * base written with or without one resolves identically.
 *
 * @param baseURL - the configured base, e.g. `https://api.firecrawl.dev/v1`.
 * @returns the absolute search endpoint.
 */
function searchEndpoint(baseURL) {
	return `${baseURL.replace(/\/+$/u, "")}/search`;
}
/** True for a value usable as a positive count. */
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}
/**
 * Bound one request's `limit`: prefer the seam's `maxResults` (the deployment's source cap, so
 * over-returning never happens), then the configured default, clamped to Firecrawl's range.
 *
 * @param requested - the seam's `maxResults`, when the caller sent one.
 * @param fallback - the configured default.
 * @returns a positive integer no greater than {@link FIRECRAWL_MAX_RESULTS}.
 */
function clampLimit(requested, fallback) {
	const wanted = isPositiveInteger(requested) ? requested : fallback;
	return Math.min(Math.max(wanted, 1), FIRECRAWL_MAX_RESULTS);
}
/** Combine caller cancellation with this plugin's own timeout, without leaking either timer. */
function combineSignals(signal, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (signal === undefined) return timeout;
	return AbortSignal.any([signal, timeout]);
}
/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal) {
	if (signal?.aborted === true) throw searchAborted(signal);
}
/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal, fallback) {
	return new WebError("Firecrawl search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}
/** True for a fetch or `AbortSignal` abort. */
function isAbortError(error) {
	return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
/** Wrap any post-dispatch failure with the endpoint it used. */
function searchError(endpoint, message, cause) {
	return new WebError(`${message}\n\nThe web search request used endpoint ${JSON.stringify(endpoint)}. Change it through the web-search-firecrawl plugin config (baseURL) if that endpoint is not intended.`, "WEB_PROVIDER_ERROR", cause === undefined ? undefined : { cause });
}
/**
 * Extract one source's excerpt. Firecrawl search items carry `description` (a markdown-ish
 * digest); `snippet` is accepted too so a future field rename degrades instead of emptying
 * every result.
 *
 * @param item - one `data[]` entry.
 * @returns the trimmed, length-bounded excerpt, or undefined when the item carries none.
 */
function snippetOf(item) {
	const raw = typeof item.description === "string" && item.description.length > 0 ? item.description : typeof item.snippet === "string" ? item.snippet : undefined;
	if (raw === undefined) return undefined;
	const text = raw.trim();
	if (text.length === 0) return undefined;
	return text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS)}…` : text;
}
/** Read a publication date when Firecrawl supplies one; the v1 web search shape usually does not. */
function publishedAtOf(item) {
	const candidates = [item.date, item.publishedDate, item.metadata?.publishedTime];
	for (const value of candidates) if (typeof value === "string" && value.length > 0) return value;
	return undefined;
}
/**
 * Map a Firecrawl search payload to the seam's normalized result. Both the flat `data[]`
 * shape and the grouped `data.web[]` shape are accepted, because Firecrawl changed that
 * envelope across versions.
 *
 * @param payload - the parsed response body.
 * @returns the result with deduped sources; `truncated` is always false here because the
 * request already asked for at most `limit` and the seam owns the final cap.
 * @throws {@link WebError} when the body carries no usable result array.
 */
function mapFirecrawlResponse(payload) {
	if (payload === null || typeof payload !== "object") throw new WebError("Firecrawl returned a response body that is not a JSON object", "WEB_PROVIDER_ERROR");
	if (payload.success === false) {
		const detail = typeof payload.error === "string" ? payload.error : payload.error?.message ?? payload.message;
		throw new WebError(`Firecrawl reported failure${detail === undefined || detail.length === 0 ? "" : `: ${detail}`}`, "WEB_PROVIDER_ERROR");
	}
	const items = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.data?.web) ? payload.data.web : undefined;
	if (items === undefined) throw new WebError("Firecrawl returned no `data[]` array; the response shape is not a search result", "WEB_PROVIDER_ERROR");
	const seen = /* @__PURE__ */ new Set();
	const sources = [];
	for (const item of items) {
		if (item === null || typeof item !== "object") continue;
		const url = typeof item.url === "string" ? item.url : "";
		if (url.length === 0 || seen.has(url)) continue;
		seen.add(url);
		const title = typeof item.title === "string" && item.title.length > 0 ? item.title : undefined;
		const snippet = snippetOf(item);
		const publishedAt = publishedAtOf(item);
		sources.push({
			url,
			...title === undefined ? {} : { title },
			...snippet === undefined ? {} : { snippet },
			...publishedAt === undefined ? {} : { publishedAt }
		});
	}
	return {
		sources,
		truncated: false
	};
}
/**
 * The Firecrawl-backed search provider. Redirects fail as `WEB_PROVIDER_ERROR`; every
 * post-dispatch failure names the endpoint it used.
 */
var FirecrawlSearchProvider = class {
	resolveOptions;
	id = FIRECRAWL_PROVIDER_ID;
	/**
	 * @param resolveOptions - the options for the NEXT operation, snapshotted once at each
	 * operation's entry so one search never mixes two config generations. A thunk rather than a
	 * value because the plugin's settings section can change between searches.
	 */
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}
	available() {
		const options = this.resolveOptions();
		return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined) && URL.canParse(options.baseURL) && isPositiveInteger(options.timeoutMs);
	}
	async search(request, signal) {
		const options = this.resolveOptions();
		const endpoint = searchEndpoint(options.baseURL);
		const apiKey = await this.apiKey(options, signal);
		throwIfSearchAborted(signal);
		const body = {
			query: request.query,
			limit: clampLimit(request.maxResults, options.maxResults)
		};
		throwIfSearchAborted(signal);
		let response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				redirect: "error",
				headers: {
					"authorization": `Bearer ${apiKey}`,
					"content-type": "application/json",
					"accept": "application/json",
					"user-agent": USER_AGENT
				},
				body: JSON.stringify(body),
				signal: combineSignals(signal, options.timeoutMs)
			});
		} catch (error) {
			if (signal?.aborted === true) throw searchAborted(signal, error);
			if (isAbortError(error) && signal?.aborted !== true) throw searchError(endpoint, `Firecrawl search timed out after ${options.timeoutMs}ms`, error);
			throw searchError(endpoint, `Firecrawl search request failed: ${String(error)}`, error);
		}
		if (!response.ok) {
			let message = `Firecrawl API error (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message ?? parsed?.message;
				if (detail !== undefined && detail.length > 0) message += `: ${detail}`;
			} catch (error) {
				if (signal?.aborted === true) throw searchAborted(signal, error);
			}
			if (response.status === 401 || response.status === 403) message += `\n\nThe configured Firecrawl credential was rejected. Check the "apiKeyEnv" reference (currently "${options.apiKeyEnv}") or set a literal "apiKey" in the web-search-firecrawl config.`;
			throw searchError(endpoint, message);
		}
		try {
			return mapFirecrawlResponse(await response.json());
		} catch (error) {
			if (error instanceof WebError) throw searchError(endpoint, error.message, error);
			if (signal?.aborted === true) throw searchAborted(signal, error);
			throw searchError(endpoint, `Firecrawl returned an unprocessable response body: ${String(error)}`, error);
		}
	}
	/**
	 * Resolve one operation's API key without retaining a credential on the provider.
	 *
	 * @param options - the caller's snapshot, so the key and the endpoint it is sent to come
	 * from one settings generation.
	 * @param signal - abort signal for the surrounding search.
	 * @returns the resolved key.
	 * @throws {@link WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when neither the literal nor
	 * the reference supplies one.
	 */
	async apiKey(options, signal) {
		throwIfSearchAborted(signal);
		if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await abortable(options.resolveApiKey(), signal);
		} catch (error) {
			if (signal?.aborted === true) throw searchAborted(signal, error);
			throw new WebError(`Firecrawl search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (resolved !== undefined && resolved.length > 0) return resolved;
		throw new WebError(`Firecrawl search has no API key for "${options.apiKeyEnv}"; store it through the credentials service (or export it in the launching environment), or set a literal "apiKey" in the web-search-firecrawl config`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
};
/**
 * Race a same-process asynchronous resolver against caller cancellation.
 * @param operation - the resolver.
 * @param signal - abort signal for the surrounding search.
 * @returns the resolved value.
 */
function abortable(operation, signal) {
	if (signal === undefined) return operation;
	if (signal.aborted) return Promise.reject(searchAborted(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(searchAborted(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(error instanceof Error ? error : new Error(String(error), { cause: error }));
		});
	});
}
//#endregion
//#region lib/types/index.js
/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-firecrawl";
/** The web seam this provider registers into. */
const inject = ["web"];
const Config = z.object({
	apiKey: z.string().role("secret").volatile(),
	apiKeyEnv: z.string().role("credential-ref").default(FIRECRAWL_DEFAULT_API_KEY_ENV).volatile(),
	baseURL: z.string().default(FIRECRAWL_DEFAULT_BASE_URL).volatile(),
	maxResults: z.number().step(1).min(1).max(FIRECRAWL_MAX_RESULTS).default(FIRECRAWL_DEFAULT_MAX_RESULTS).volatile(),
	timeoutMs: z.number().step(1).min(1_000).default(FIRECRAWL_DEFAULT_TIMEOUT_MS).volatile()
});
/**
 * Project one resolved settings section into the options the provider serves its next search
 * with. Credential resolution stays lazy so a key stored or rotated after load is visible to
 * the next search without a restart.
 *
 * @param ctx - plugin context supplying the credential plane.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx, config) {
	const apiKeyEnv = credentialRef(config.apiKeyEnv);
	return {
		...config.apiKey === undefined || config.apiKey.length === 0 ? {} : { apiKey: config.apiKey },
		resolveApiKey: async () => {
			const credentials = ctx.get("credentials");
			if (credentials !== undefined) {
				const resolved = await credentials.resolve(apiKeyEnv);
				if (resolved !== undefined && typeof resolved.value === "string" && resolved.value.length > 0) return resolved.value;
			}
			const ambient = process.env[apiKeyEnv];
			return typeof ambient === "string" && ambient.length > 0 ? ambient : undefined;
		},
		apiKeyEnv,
		baseURL: config.baseURL,
		maxResults: config.maxResults,
		timeoutMs: config.timeoutMs
	};
}
/** Register the Firecrawl search provider with `ctx.web`. */
function apply(ctx, config) {
	ctx.web.registerSearchProvider(new FirecrawlSearchProvider(() => resolveOptions(ctx, {
		apiKey: config.apiKey.get(),
		apiKeyEnv: config.apiKeyEnv.get(),
		baseURL: config.baseURL.get(),
		maxResults: config.maxResults.get(),
		timeoutMs: config.timeoutMs.get()
	})));
}
//#endregion
export { Config, FIRECRAWL_DEFAULT_API_KEY_ENV, FIRECRAWL_DEFAULT_BASE_URL, FIRECRAWL_DEFAULT_MAX_RESULTS, FIRECRAWL_DEFAULT_TIMEOUT_MS, FIRECRAWL_MAX_RESULTS, FIRECRAWL_PROVIDER_ID, FirecrawlSearchProvider, apply, inject, mapFirecrawlResponse, name, searchEndpoint };
