/**
 * Vercel hands Web-standard (Edge) functions the dynamic route segment as a
 * query parameter — `/api/v1/subscriptions/<id>` arrives as
 * `/api/v1/subscriptions?id=<id>` — so the handler would see a URL that does not
 * match its strict route table.
 *
 * `withCanonicalPath` rebuilds the URL the browser actually requested: it drops
 * the platform's `/api` prefix and puts a well-formed dynamic segment back into
 * the path. Anything else in the query string is left untouched, so the
 * handler's "no query string" rule still rejects it.
 */

const ID_PATTERN = /^[a-f0-9]{64}$/;

function stripApiPrefix(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/") ? pathname.slice(4) || "/" : pathname;
}

export function canonicalUrl(request, { allowIdParam = false } = {}) {
  const url = new URL(request.url);
  let pathname = stripApiPrefix(url.pathname);
  let search = url.search;
  if (allowIdParam) {
    const keys = [...url.searchParams.keys()];
    const id = url.searchParams.get("id");
    if (keys.length === 1 && keys[0] === "id" && typeof id === "string" && ID_PATTERN.test(id)) {
      const base = pathname.replace(/\/+$/, "");
      if (!base.endsWith(`/${id}`)) pathname = `${base}/${id}`;
      search = "";
    }
  }
  return `${url.origin}${pathname}${search}`;
}

export function withCanonicalPath(request, options) {
  return new Request(canonicalUrl(request, options), request);
}
