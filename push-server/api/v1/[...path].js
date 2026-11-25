export const config = { runtime: "edge" };

/** Temporary routing diagnostic: reports what a catch-all edge function receives. */
export default function handler(request) {
  const url = new URL(request.url);
  const headerNames = ["x-matched-path", "x-vercel-original-path", "x-forwarded-uri", "x-vercel-deployment-url", "x-invoke-path", "x-real-url"];
  const headers = {};
  for (const name of headerNames) headers[name] = request.headers.get(name);
  return new Response(JSON.stringify({ method: request.method, url: request.url, pathname: url.pathname, search: url.search, headers }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
