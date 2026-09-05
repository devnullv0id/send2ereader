import { existsSync, readFileSync } from 'node:fs'

export interface ContainerCheck {
  inContainer: boolean
  evidence: string
}

export function detectContainer(): ContainerCheck {
  if (existsSync('/.dockerenv')) return { inContainer: true, evidence: '/.dockerenv' }
  if (existsSync('/run/.containerenv')) {
    return { inContainer: true, evidence: '/run/.containerenv' }
  }

  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf8')
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
