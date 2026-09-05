import { existsSync, readFileSync } from 'node:fs'

export interface ContainerCheck {
  inContainer: boolean
  evidence: string
}

export interface ContainerProbes {
  exists: (path: string) => boolean
  read: (path: string) => string
}

const onThisMachine: ContainerProbes = {
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
}

export function detectContainer(probes: ContainerProbes = onThisMachine): ContainerCheck {
  if (probes.exists('/.dockerenv')) return { inContainer: true, evidence: '/.dockerenv' }
  if (probes.exists('/run/.containerenv')) {
    return { inContainer: true, evidence: '/run/.containerenv' }
  }

  try {
    const cgroup = probes.read('/proc/1/cgroup')
    for (const marker of ['docker', 'containerd', 'kubepods', 'podman']) {
      if (cgroup.includes(marker)) return { inContainer: true, evidence: `cgroup:${marker}` }
    }
  } catch {}

  return { inContainer: false, evidence: '' }
}

export function requestRestart(): void {
  process.kill(process.pid, 'SIGTERM')
}

export const restarter = {
  canRestart: detectContainer().inContainer,
  restart: requestRestart,
}
