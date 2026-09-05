#!/usr/bin/env node
import { execFileSync } from 'node:child_process'

const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '')
const server = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '')
const repo = process.env.GITHUB_REPOSITORY
const token = process.env.RELEASE_TOKEN
const tag = process.env.TAG
const version = process.env.VERSION
const image = process.env.IMAGE
const prerelease = process.env.PRERELEASE === 'true'

for (const [name, value] of Object.entries({ repo, token, tag, version })) {
  if (!value) {
    console.error(`publish-release: ${name} is not set`)
    process.exit(1)
  }
}

const onGithub = api.includes('api.github.com')
const headers = {
  Authorization: onGithub ? `Bearer ${token}` : `token ${token}`,
  Accept: 'application/json',
}

const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const already = await fetch(`${api}/repos/${repo}/releases/tags/${tag}`, { headers })
if (already.ok) {
  console.log(`Release ${tag} already exists, nothing to do`)
  process.exit(0)
}

const previous = git('describe', '--tags', '--abbrev=0', `${tag}^`)
const range = previous ? `${previous}..${tag}` : tag
const log = git('log', '--no-merges', '--pretty=format:- %s', range)

const parts = []
if (image) parts.push(['```sh', `docker pull ${image}:${version}`, '```'].join('\n'))
if (log) parts.push(`## What changed\n\n${log}`)
if (previous) parts.push(`**Full changelog**: ${server}/${repo}/compare/${previous}...${tag}`)

const made = await fetch(`${api}/repos/${repo}/releases`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tag_name: tag,
    name: tag,
    body: parts.join('\n\n'),
    draft: false,
    prerelease,
  }),
})

if (!made.ok) {
  console.error(`publish-release: ${api} refused with ${made.status}`)
  console.error((await made.text()).slice(0, 500))
  process.exit(1)
}

console.log(`Released ${tag} on ${new URL(api).host}${prerelease ? ' as a prerelease' : ''}`)
