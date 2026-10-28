const backend = "https://railgate-console.33fazirana.workers.dev";
const paths =
  /^\/console-api\/(?:health|workspaces|session|export|agents|keys(?:\/[a-f0-9-]{36}\/revoke)?|rules|payments\/[a-f0-9-]{36}\/decision|v1\/payments(?:\/[a-f0-9-]{36})?)$/;
/** Separate, narrowly scoped demo gateway. No owner/payment-backend credentials are forwarded. */
export function createConsoleGateway(fetcher: typeof fetch = fetch) {
  return async (request: Request) => {
    const url = new URL(request.url);
    if (!paths.test(url.pathname))
      return Response.json({ error: "Endpoint not found" }, { status: 404 });
    if (!["GET", "HEAD", "POST"].includes(request.method))
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: { Allow: "GET, HEAD, POST" } },
      );
    const headers = new Headers();
    for (const name of ["authorization", "content-type", "origin", "accept"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("rg_console="));
    if (cookie) headers.set("cookie", cookie);
    const target = new URL(url.pathname, backend);
    try {
      const body =
        request.method === "POST" ? await request.arrayBuffer() : undefined;
      if (body && body.byteLength > 16384)
        return Response.json(
          { error: "Request exceeds 16 KiB" },
          { status: 413 },
        );
      const result = await fetcher(target, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
      });
      const safe = new Headers({
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      for (const name of [
        "content-type",
        "set-cookie",
        "content-disposition",
        "allow",
      ]) {
        const value = result.headers.get(name);
        if (value) safe.set(name, value);
      }
      return new Response(request.method === "HEAD" ? null : result.body, {
        status: result.status,
        headers: safe,
      });
    } catch {
      return Response.json(
        {
          error:
            "Demo service temporarily unavailable. Retry with the same idempotency key.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  };
}
