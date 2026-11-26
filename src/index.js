
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405
      });
    }

    if (url.pathname === "/") {
      return Response.json({
        project: "NASA Space Weather Ingestion",
        status: "running",
        message: "Cloudflare Worker is deployed successfully.",
        next_step: "NASA API integration"
      });
    }

    return new Response("Not Found", {
      status: 404
    });
  }
};
