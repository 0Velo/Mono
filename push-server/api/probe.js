export const config = { runtime: "edge" };

/** Temporary routing diagnostic: reports what the edge function actually receives. */
export default function handler(request) {
  return new Response(JSON.stringify({
    method: request.method,
    url: request.url,
    matchedPath: request.headers.get("x-matched-path") || null,
    originalPath: request.headers.get("x-vercel-original-path") || null
  }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
