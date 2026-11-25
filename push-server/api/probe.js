export const config = { runtime: "edge" };

export default function handler(request) {
  return new Response(JSON.stringify({
    method: request.method,
    url: request.url,
    matchedPath: request.headers.get("x-matched-path") || null,
    hasBody: Boolean(request.body),
  }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
