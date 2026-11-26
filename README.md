
# NASA Space Weather Ingestion Pipeline

A cloud-based data engineering project that collects NASA space-weather data, performs basic data validation and cleaning, and stores the results in different cloud storage systems.

## Planned architecture

- **Data source:** NASA API
- **Cloud processing:** Cloudflare Workers
- **Relational database:** Cloudflare D1
- **NoSQL storage:** Cloudflare KV
- **Data warehouse:** Google BigQuery

## Project objective

Build an automated cloud-based data ingestion pipeline without running data processing locally.
