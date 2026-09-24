import { app } from 'mu';
import Dockerode from 'dockerode';
import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync } from 'fs';

const PROM_FILE = process.env.PROM_FILE || '/data/docker-metrics.prom';
const SCRAPE_INTERVAL = parseInt(process.env.SCRAPE_INTERVAL || '15') * 1000;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100');

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

console.log('Starting docker-prom-metrics service');
console.log(`  prom file       : ${PROM_FILE}`);
console.log(`  scrape interval : ${SCRAPE_INTERVAL / 1000}s`);
console.log(`  batch size      : ${BATCH_SIZE}`);

mkdirSync(PROM_FILE.split('/').slice(0, -1).join('/') || '.', { recursive: true });

try {
  await docker.ping();
  console.log('Connected to Docker daemon');
} catch (err) {
  console.log(`Cannot connect to Docker: ${err.message}`);
  process.exit(1);
}

app.get('/metrics', (_req, res) => {
  if (existsSync(PROM_FILE)) {
    const content = readFileSync(PROM_FILE, 'utf8');
    res.set('Content-Type', 'text/plain; charset=utf-8').send(content);
  } else {
    res.status(503).send();
  }
});

const prop = (key) => (container) => container[key];
const numberProp = (key) => (container) => container[key]?.toFixed(4);

const METRICS_DATA = [
  {
    name: 'docker_container_up',
    type: 'gauge',
    description: '1 if the container is running, 0 otherwise',
    metric: prop('up'),
  },
  {
    name: 'docker_container_cpu_percent',
    type: 'gauge',
    description: 'CPU usage percentage across all cores',
    metric: numberProp('cpuPct'),
  },
  {
    name: 'docker_container_memory_usage_bytes',
    type: 'gauge',
    description: 'Memory usage in bytes (RSS, cache excluded)',
    metric: prop('memUsage'),
  },
  {
    name: 'docker_container_memory_limit_bytes',
    type: 'gauge',
    description: 'Memory limit configured for the container',
    metric: prop('memLimit'),
  },
  {
    name: 'docker_container_memory_percent',
    type: 'gauge',
    description: 'Memory usage as a percentage of the limit',
    metric: numberProp('memPct'),
  },
  {
    name: 'docker_container_net_rx_bytes_total',
    type: 'counter',
    description: 'Total bytes received over the network',
    metric: prop('netRx'),
  },
  {
    name: 'docker_container_net_tx_bytes_total',
    type: 'counter',
    description: 'Total bytes transmitted over the network',
    metric: prop('netTx'),
  },
  {
    name: 'docker_container_blk_read_bytes_total',
    type: 'counter',
    description: 'Total bytes read from block devices',
    metric: prop('blkRd'),
  },
  {
    name: 'docker_container_blk_write_bytes_total',
    type: 'counter',
    description: 'Total bytes written to block devices',
    metric: prop('blkWr'),
  },
  {
    name: 'docker_container_restart_count',
    type: 'counter',
    description: 'Number of times the container has been restarted',
    metric: prop('restarts'),
  },
  {
    name: 'docker_container_oom_killed',
    type: 'gauge',
    description: '1 if the container was last stopped due to an OOM kill',
    metric: prop('oomKilled'),
  },
  {
    name: 'docker_container_oom_kills_total',
    type: 'counter',
    description: 'Number of OOM kill events',
    metric: prop('oomKills'),
  },
  {
    name: 'docker_container_pids',
    type: 'gauge',
    description: 'Number of processes inside the container',
    metric: prop('pids'),
  },
  {
    name: 'docker_container_scrape_duration_seconds',
    type: 'gauge',
    description: 'Time taken to scrape this container',
    metric: numberProp('duration'),
  },
];

try {
  await scrapeAll();
} catch (err) {
  console.log(`Initial scrape failed: ${err.message}`);
}

setInterval(async () => {
  try {
    await scrapeAll();
  } catch (err) {
    console.log(`Scrape failed: ${err.message}`);
  }
}, SCRAPE_INTERVAL);

async function scrapeAll() {
  const containers = await docker.listContainers({ all: true });

  const containerMetrics = [];
  for (let i = 0; i < containers.length; i += BATCH_SIZE) {
    const batch = containers.slice(i, i + BATCH_SIZE);
    containerMetrics.push(...await Promise.all(batch.map(scrapeContainer)));
  }
  const dockerVersionInfo = await docker.version();
  writePromFile(containerMetrics, dockerVersionInfo);

  console.log(`Scraped ${containers.length} containers`);
}

async function scrapeContainer(containerInfo) {
  const t0 = Date.now();
  const running = containerInfo.State === 'running';
  const baseMetrics = {
    name: (containerInfo.Names[0] || '').replace(/^\//, ''),
    id: containerInfo.Id.slice(0, 12),
    image: containerInfo.Image || containerInfo.ImageID?.slice(0, 12) || 'unknown',
    up: running ? 1 : 0,
    duration: (Date.now() - t0) / 1000,
  };

  try {
    const containerHandle = docker.getContainer(containerInfo.Id);
    const inspect = await inspectContainer(containerHandle);

    const inspectLabels = inspect.Config?.Labels || {};
    const metrics = {
      ...baseMetrics,
      restarts: inspect?.RestartCount || 0,
      oomKilled: inspect?.State?.OOMKilled ? 1 : 0,
      composeProject: inspectLabels['com.docker.compose.project'],
      composeService: inspectLabels['com.docker.compose.service'],
      composeVersion: inspectLabels['com.docker.compose.version'],
      duration: (Date.now() - t0) / 1000,
    };

    if (running) {
      const stats = await getStats(containerHandle);

      const memStats = stats.memory_stats || {};
      const memCache = memStats.stats?.cache || 0;
      const memUsage = Math.max(0, (memStats.usage || 0) - memCache);
      const memLimit = memStats.limit || 0;
      const [netRx, netTx] = netIO(stats);
      const [blkRd, blkWr] = blkIO(stats);

      Object.assign(metrics, {
        cpuPct: cpuPercent(stats),
        memUsage,
        memLimit,
        memPct: memLimit ? (memUsage / memLimit) * 100 : 0,
        netRx, netTx,
        blkRd, blkWr,
        oomKills: stats.memory_stats?.stats?.oom_kill || 0,
        pids: stats.pids_stats?.current || 0,
      });
    }

    return metrics;
  } catch (err) {
    console.log(`Failed scraping ${containerInfo.Id}: ${err.message}`);
    return baseMetrics;
  }
}

function metricLabels(container) {
  const labels = [
    `name="${container.name}"`,
    `image="${container.image.split('@')[0]}"`,
    `id="${container.id}"`,
  ];
  if (container.composeProject)
    labels.push(`docker_compose_project="${container.composeProject}"`);
  if (container.composeService)
    labels.push(`docker_compose_service="${container.composeService}"`);
  return `{${labels.join(',')}}`;
}

function writePromFile(containers, dockerVersionInfo) {
  const lines = ['# Produced by docker-prom-metrics', ''];

  for (const metric of METRICS_DATA) {
    lines.push(...metricHeaders(metric));
  }
  lines.push('');

  const projectComposeVersions = new Map();
  for (const container of containers) {
    if (container.composeProject && container.composeVersion) {
      projectComposeVersions.set(container.composeProject, container.composeVersion);
    }
    const labels = metricLabels(container);
    for (const { name, metric } of METRICS_DATA) {
      const value = metric(container);
      if (value !== undefined)
        lines.push(`${name}${labels} ${value}`);
    }
    lines.push('');
  }

  // Docker Compose Versions per Project
  if (projectComposeVersions.size > 0) {
    lines.push(
      ...metricHeaders({
        name: 'docker_compose_version_info',
        description: 'Docker Compose version used to deploy projects',
        type: 'gauge',
      })
    );
    for (const [project, version] of projectComposeVersions.entries()) {
      lines.push(`docker_compose_version_info{docker_compose_project="${project}",version="${version}"} 1`);
    }
    lines.push('');
  }

  // Docker Engine and API Version (global for host)
  if (dockerVersionInfo?.Version) {
    lines.push(
      ...metricHeaders({
        name: 'docker_version_info',
        description: 'Docker Engine and Api version',
        type: 'gauge',
      })
    );
    lines.push(
      `docker_version_info{version="${dockerVersionInfo.Version}",api_version="${dockerVersionInfo.ApiVersion}"} 1`
    );
    lines.push('');
  }

  lines.push(`docker_prom_metrics_scrape_timestamp_seconds ${(Date.now() / 1000).toFixed(3)}`);
  lines.push('');

  const promMetrics = lines.join('\n');
  const tmp = PROM_FILE + '.tmp';
  writeFileSync(tmp, promMetrics, 'utf8');
  renameSync(tmp, PROM_FILE);
}

// gives HELP and TYPE lines for given params
function metricHeaders({ name, description, type }) {
  return [`# HELP ${name} ${description}`, `# TYPE ${name} ${type}`];
}

// Docker stats helpers

function cpuPercent(stats) {
  try {
    const cpu = stats.cpu_stats;
    const pcpu = stats.precpu_stats;
    const delta = cpu.cpu_usage.total_usage - pcpu.cpu_usage.total_usage;
    const sysDelta = cpu.system_cpu_usage - pcpu.system_cpu_usage;
    const numCpus = cpu.online_cpus || (cpu.cpu_usage.percpu_usage || [1]).length;
    if (sysDelta > 0 && delta >= 0) return (delta / sysDelta) * numCpus * 100;
  } catch (_) {}
  return 0;
}

function netIO(stats) {
  let rx = 0, tx = 0;
  try {
    for (const iface of Object.values(stats.networks || {})) {
      rx += iface.rx_bytes || 0;
      tx += iface.tx_bytes || 0;
    }
  } catch (_) {}
  return [rx, tx];
}

function blkIO(stats) {
  let rd = 0, wr = 0;
  try {
    for (const entry of stats.blkio_stats?.io_service_bytes_recursive || []) {
      if (entry.op?.toLowerCase() === 'read')  rd += entry.value || 0;
      if (entry.op?.toLowerCase() === 'write') wr += entry.value || 0;
    }
  } catch (_) {}
  return [rd, wr];
}

// Dockerode promise wrappers

async function getStats(container) {
  return new Promise((resolve, reject) => {
    container.stats({ stream: false }, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

async function inspectContainer(container) {
  return new Promise((resolve, reject) => {
    container.inspect((err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}
