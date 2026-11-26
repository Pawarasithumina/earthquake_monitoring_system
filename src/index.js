
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Allow GET requests only
    if (request.method !== "GET") {
      return Response.json(
        {
          project: "Earthquake Monitoring System",
          status: "error",
          message: "Method Not Allowed"
        },
        { status: 405 }
      );
    }

    // Main health-check endpoint
    if (url.pathname === "/") {
      return Response.json({
        project: "Earthquake Monitoring System",
        description:
          "A cloud-based earthquake data ingestion and monitoring system.",
        status: "running",
        platform: "Cloudflare Workers",
        data_source: "USGS Earthquake API",
        storage: {
          relational_database: "Cloudflare D1",
          nosql_database: "Cloudflare KV"
        },
        endpoints: {
          health: "/health",
          api: "USGS Earthquake API"
        },
        message: "Earthquake Monitoring System is running successfully."
      });
    }

    // Health-check endpoint
    if (url.pathname === "/health") {
      return Response.json({
        status: "healthy",
        worker: "earthquake-monitoring-system",
        timestamp: new Date().toISOString()
      });
    }

    // Handle unknown routes
    return Response.json(
      {
        project: "Earthquake Monitoring System",
        status: "error",
        message: "Endpoint not found."
      },
      { status: 404 }
    );
  }
};
