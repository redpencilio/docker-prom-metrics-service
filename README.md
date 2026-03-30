# docker-prom-metrics

A microservice that scrapes Docker container stats and writes them as a [Prometheus text file](https://prometheus.io/docs/instrumenting/exposition_formats/). Designed to be picked up by a Prometheus node_exporter [textfile collector](https://github.com/prometheus/node_exporter#textfile-collector).

## Getting started

Add the service to your `docker-compose.yml`:

```yaml
services:
  docker-metrics:
    image: redpencil/docker-prom-metrics
    volumes:
      - ./data/docker-metrics:/data
      - /var/run/docker.sock:/var/run/docker.sock
```

The service immediately starts scraping all containers on the Docker host and writes metrics to `/data/docker-metrics.prom` every 15 seconds.

## How-to guides

### Pick up metrics with node_exporter

node_exporter's textfile collector reads all `.prom` files from a directory. Mount the same volume into your node_exporter container and point it at that directory:

```yaml
services:
  node-exporter:
    image: prom/node-exporter
    volumes:
      - ./data/docker-metrics:/data/docker-metrics:ro
    command:
      - --collector.textfile.directory=/data/docker-metrics
```

Prometheus will then scrape the container metrics alongside the standard node metrics from the same node_exporter target.

## Reference

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PROM_FILE` | `/data/docker-metrics.prom` | Path where the Prometheus text file is written |
| `SCRAPE_INTERVAL` | `15` | Seconds between scrapes |
| `BATCH_SIZE` | `100` | Number of containers scraped in parallel per batch |

### Metrics

All per-container metrics carry the labels `name`, `image`, `id`. If the container belongs to a Docker Compose project, `docker_compose_project` and `docker_compose_service` are added as well.

Stats-based metrics (CPU, memory, network, block I/O, PIDs, OOM kill count) are only emitted for running containers. Identity and state metrics are emitted for all containers.

| Metric | Type | Description |
|---|---|---|
| `docker_container_up` | gauge | 1 if the container is running, 0 otherwise |
| `docker_container_cpu_percent` | gauge | CPU usage percentage across all cores |
| `docker_container_memory_usage_bytes` | gauge | Memory usage in bytes (RSS, cache excluded) |
| `docker_container_memory_limit_bytes` | gauge | Memory limit configured for the container |
| `docker_container_memory_percent` | gauge | Memory usage as a percentage of the limit |
| `docker_container_net_rx_bytes_total` | counter | Total bytes received over the network |
| `docker_container_net_tx_bytes_total` | counter | Total bytes transmitted over the network |
| `docker_container_blk_read_bytes_total` | counter | Total bytes read from block devices |
| `docker_container_blk_write_bytes_total` | counter | Total bytes written to block devices |
| `docker_container_restart_count` | counter | Number of times the container has been restarted |
| `docker_container_oom_killed` | gauge | 1 if the container was last stopped due to an OOM kill |
| `docker_container_oom_kills_total` | counter | Number of OOM kill events (running containers only) |
| `docker_container_pids` | gauge | Number of processes inside the container |
| `docker_container_scrape_duration_seconds` | gauge | Time taken to scrape this container |
| `docker_prom_metrics_scrape_timestamp_seconds` | gauge | Unix timestamp of the last successful scrape |

### API endpoints

| Endpoint | Description |
|---|---|
| `GET /metrics` | Returns the current contents of the Prometheus text file. Returns 503 with an empty body if the file has not been written yet. |

## Discussion

### Why build a custom metrics service?

Tools like [cAdvisor](https://github.com/google/cadvisor) are comprehensive but heavy. They pull in a large dependency tree, expose dozens of metrics per container, and rely on a specific label convention (`container_label_*`) that makes it harder to write reusable Prometheus rules and Grafana dashboards.

This service is intentionally minimal: it reads from the Docker socket directly using [dockerode](https://github.com/apocas/dockerode), exposes a small fixed set of metrics, and writes a single text file. The flat, predictable metric names (`docker_container_*`) require no label manipulation in recording rules or dashboard queries. The result is a service that is easy to reason about and easy to extend.
