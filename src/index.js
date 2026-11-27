
const USGS_API =
  "https://earthquake.usgs.gov/fdsnws/event/1/query";

const DAYS_TO_FETCH = 30;
const MAX_EVENTS = 20000;
const KV_CHUNK_SIZE = 500;
const D1_BATCH_SIZE = 100;

const RAW_PREFIX = "earthquakes/raw/part-";
const MANIFEST_KEY = "earthquakes/raw/manifest";

function jsonResponse(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

function validateFeature(feature, ingestionTime) {
  const properties = feature?.properties;
  const coordinates = feature?.geometry?.coordinates;

  if (!feature?.id || !properties) {
    return null;
  }

  if (
    !Array.isArray(coordinates) ||
    coordinates.length < 2
  ) {
    return null;
  }

  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  const depth = coordinates[2] == null
    ? null
    : Number(coordinates[2]);

  const eventTime = Number(properties.time);

  if (
    !Number.isFinite(eventTime) ||
    eventTime <= 0 ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90 ||
    (depth !== null && !Number.isFinite(depth))
  ) {
    return null;
  }

  let magnitude = null;

  if (
    properties.mag !== null &&
    properties.mag !== undefined
  ) {
    magnitude = Number(properties.mag);

    if (!Number.isFinite(magnitude)) {
      magnitude = null;
    }
  }

  return {
    event_id: String(feature.id),
    magnitude,
    place:
      typeof properties.place === "string"
        ? properties.place.trim()
        : null,
    event_time: new Date(eventTime).toISOString(),
    depth_km: depth,
    longitude,
    latitude,
    event_url:
      typeof properties.url === "string"
        ? properties.url
        : null,
    ingestion_time: ingestionTime
  };
}

async function storeInD1(records, env) {
  const sql = `
    INSERT INTO earthquakes (
      event_id,
      magnitude,
      place,
      event_time,
      depth_km,
      longitude,
      latitude,
      event_url,
      ingestion_time
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)

    ON CONFLICT(event_id) DO UPDATE SET
      magnitude = excluded.magnitude,
      place = excluded.place,
      event_time = excluded.event_time,
      depth_km = excluded.depth_km,
      longitude = excluded.longitude,
      latitude = excluded.latitude,
      event_url = excluded.event_url

    WHERE
      earthquakes.magnitude IS NOT excluded.magnitude
      OR earthquakes.place IS NOT excluded.place
      OR earthquakes.event_time IS NOT excluded.event_time
      OR earthquakes.depth_km IS NOT excluded.depth_km
      OR earthquakes.longitude IS NOT excluded.longitude
      OR earthquakes.latitude IS NOT excluded.latitude
      OR earthquakes.event_url IS NOT excluded.event_url
  `;

  let processed = 0;

  for (
    let i = 0;
    i < records.length;
    i += D1_BATCH_SIZE
  ) {
    const batchRecords = records.slice(
      i,
      i + D1_BATCH_SIZE
    );

    const statements = batchRecords.map((record) =>
      env.DB.prepare(sql).bind(
        record.event_id,
        record.magnitude,
        record.place,
        record.event_time,
        record.depth_km,
        record.longitude,
        record.latitude,
        record.event_url,
        record.ingestion_time
      )
    );

    await env.DB.batch(statements);

    processed += batchRecords.length;
  }

  return processed;
}

async function storeRawData(features, env, fetchedAt) {
  const previousManifest = await env.RAW_DATA.get(
    MANIFEST_KEY,
    "json"
  );

  const chunkCount = Math.ceil(
    features.length / KV_CHUNK_SIZE
  );

  for (
    let i = 0;
    i < features.length;
    i += KV_CHUNK_SIZE
  ) {
    const chunk = features.slice(
      i,
      i + KV_CHUNK_SIZE
    );

    const chunkNumber =
      Math.floor(i / KV_CHUNK_SIZE) + 1;

    const key =
      RAW_PREFIX +
      String(chunkNumber).padStart(4, "0");

    await env.RAW_DATA.put(
      key,
      JSON.stringify({
        fetched_at: fetchedAt,
        features: chunk
      })
    );
  }

  // Remove old chunks if the new snapshot is smaller.
  const previousChunkCount =
    Number(previousManifest?.chunk_count || 0);

  for (
    let i = chunkCount + 1;
    i <= previousChunkCount;
    i++
  ) {
    const oldKey =
      RAW_PREFIX + String(i).padStart(4, "0");

    await env.RAW_DATA.delete(oldKey);
  }

  const manifest = {
    source: "USGS Earthquake API",
    fetched_at: fetchedAt,
    total_features: features.length,
    chunk_count: chunkCount,
    chunk_size: KV_CHUNK_SIZE
  };

  await env.RAW_DATA.put(
    MANIFEST_KEY,
    JSON.stringify(manifest)
  );

  return manifest;
}

async function runIngestion(env) {
  const startedAt = new Date().toISOString();

  const endTime = new Date();
  const startTime = new Date(
    endTime.getTime() -
    DAYS_TO_FETCH * 24 * 60 * 60 * 1000
  );

  const params = new URLSearchParams({
    format: "geojson",
    starttime: startTime.toISOString(),
    endtime: endTime.toISOString(),
    orderby: "time",
    limit: String(MAX_EVENTS),
    eventtype: "earthquake"
  });

  const apiUrl = `${USGS_API}?${params.toString()}`;

  console.log("Starting earthquake ingestion.");

  // 1. Extract data from USGS.
  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/geo+json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `USGS API request failed: HTTP ${response.status}`
    );
  }

  const geojson = await response.json();

  if (!Array.isArray(geojson.features)) {
    throw new Error(
      "Invalid response received from USGS API."
    );
  }

  const features = geojson.features;

  // 2. Validate and clean records.
  const ingestionTime = new Date().toISOString();

  const validRecords = [];
  let invalidCount = 0;

  for (const feature of features) {
    const record = validateFeature(
      feature,
      ingestionTime
    );

    if (record) {
      validRecords.push(record);
    } else {
      invalidCount++;
    }
  }

  // 3. Store original API records in KV.
  const rawManifest = await storeRawData(
    features,
    env,
    ingestionTime
  );

  // 4. Store structured records in D1.
  const storedCount = await storeInD1(
    validRecords,
    env
  );

  const result = {
    status: "success",
    source: "USGS Earthquake API",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    period: {
      start: startTime.toISOString(),
      end: endTime.toISOString(),
      days: DAYS_TO_FETCH
    },
    statistics: {
      fetched: features.length,
      valid: validRecords.length,
      invalid: invalidCount,
      d1_processed: storedCount,
      kv_chunks: rawManifest.chunk_count
    },
    warning:
      features.length === MAX_EVENTS
        ? "The API limit was reached. The dataset may be incomplete."
        : null
  };

  console.log(JSON.stringify(result));

  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Main project information.
    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      return jsonResponse({
        project: "Earthquake Monitoring System",
        status: "running",
        data_source: "USGS Earthquake API",
        storage: [
          "Cloudflare KV",
          "Cloudflare D1"
        ],
        endpoints: [
          "/",
          "/health",
          "/api/stats",
          "/api/warehouse-export",
          "/ingest"
        ]
      });
    }

    // Health check.
    if (
      request.method === "GET" &&
      url.pathname === "/health"
    ) {
      return jsonResponse({
        status: "healthy",
        worker: "earthquake-monitoring-system",
        timestamp: new Date().toISOString()
      });
    }

    // Read basic database statistics.
    if (
      request.method === "GET" &&
      url.pathname === "/api/stats"
    ) {
      try {
        const result = await env.DB.prepare(`
          SELECT
            COUNT(*) AS total_records,
            MAX(event_time) AS latest_event_time,
            MIN(event_time) AS earliest_event_time,
            AVG(magnitude) AS average_magnitude,
            MAX(magnitude) AS maximum_magnitude
          FROM earthquakes
        `).first();

        return jsonResponse({
          status: "success",
          statistics: result
        });
      } catch (error) {
        console.error("D1 statistics error:", error);

        return jsonResponse({
          status: "error",
          message: "Unable to read database statistics."
        }, 500);
      }
    }

    // Secure paginated export endpoint for BigQuery.
    if (
      url.pathname === "/api/warehouse-export"
    ) {
      if (request.method !== "GET") {
        return jsonResponse({
          status: "error",
          message: "Use GET to retrieve warehouse records."
        }, 405);
      }

      if (!env.WAREHOUSE_EXPORT_SECRET) {
        return jsonResponse({
          status: "error",
          message: "Warehouse export is not configured."
        }, 503);
      }

      const authorization =
        request.headers.get("Authorization");

      if (
        authorization !==
        `Bearer ${env.WAREHOUSE_EXPORT_SECRET}`
      ) {
        return jsonResponse({
          status: "error",
          message: "Unauthorized."
        }, 401);
      }

      try {
        const requestedLimit = Number(
          url.searchParams.get("limit") || 500
        );

        const requestedOffset = Number(
          url.searchParams.get("offset") || 0
        );

        if (
          !Number.isInteger(requestedLimit) ||
          requestedLimit < 1 ||
          requestedLimit > 1000 ||
          !Number.isInteger(requestedOffset) ||
          requestedOffset < 0
        ) {
          return jsonResponse({
            status: "error",
            message: "Invalid pagination parameters."
          }, 400);
        }

        const countResult = await env.DB.prepare(`
          SELECT COUNT(*) AS total
          FROM earthquakes
        `).first();

        const records = await env.DB.prepare(`
          SELECT
            event_id,
            magnitude,
            place,
            event_time,
            depth_km,
            longitude,
            latitude,
            event_url,
            ingestion_time
          FROM earthquakes
          ORDER BY event_time ASC, event_id ASC
          LIMIT ? OFFSET ?
        `).bind(
          requestedLimit,
          requestedOffset
        ).all();

        const total = Number(countResult?.total ?? 0);

        return jsonResponse({
          status: "success",
          total_records: total,
          limit: requestedLimit,
          offset: requestedOffset,
          returned_records: records.results.length,
          has_more:
            requestedOffset + records.results.length < total,
          records: records.results
        });

      } catch (error) {
        console.error("Warehouse export error:", error);

        return jsonResponse({
          status: "error",
          message: "Unable to export warehouse records."
        }, 500);
      }
    }

    // Manual ingestion endpoint.
    if (url.pathname === "/ingest") {
      if (request.method !== "POST") {
        return jsonResponse({
          status: "error",
          message: "Use POST to start ingestion."
        }, 405);
      }

      if (!env.INGEST_SECRET) {
        return jsonResponse({
          status: "error",
          message: "INGEST_SECRET is not configured."
        }, 503);
      }

      const authorization =
        request.headers.get("Authorization");

      if (
        authorization !==
        `Bearer ${env.INGEST_SECRET}`
      ) {
        return jsonResponse({
          status: "error",
          message: "Unauthorized."
        }, 401);
      }

      try {
        const result = await runIngestion(env);

        return jsonResponse(result);
      } catch (error) {
        console.error("Ingestion failed:", error);

        return jsonResponse({
          status: "error",
          message: "Earthquake ingestion failed.",
          details: error.message
        }, 500);
      }
    }

    return jsonResponse({
      status: "error",
      message: "Endpoint not found."
    }, 404);
  },

  // Automatic scheduled ingestion.
  async scheduled(controller, env, ctx) {
    try {
      const result = await runIngestion(env);

      console.log(
        "Scheduled ingestion completed:",
        JSON.stringify(result)
      );
    } catch (error) {
      console.error(
        "Scheduled ingestion failed:",
        error.message
      );

      throw error;
    }
  }
};
