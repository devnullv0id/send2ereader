import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { config } from '../src/config.js'

const staticDir = config.staticDir

const PAGES: [page: string, scripts: string[]][] = [
  ['settings.html', ['auth.js', 'history.js', 'cells.js', 'settings.js']],
  ['send.html', ['auth.js', 'history.js', 'send.js', 'cells.js', 'send-page.js']],
  ['convert.html', ['auth.js', 'history.js', 'send.js', 'convert.js']],
  ['history.html', ['auth.js', 'history.js', 'history-page.js']],
  ['waiting.html', ['auth.js', 'history.js', 'waiting.js']],
  ['login.html', ['auth.js', 'history.js', 'cells.js', 'signin.js']],
  ['register.html', ['auth.js', 'history.js', 'signin.js']],
  ['forgot.html', ['auth.js', 'history.js', 'signin.js']],
  ['reset.html', ['auth.js', 'history.js', 'signin.js']],
  ['setup.html', ['auth.js', 'history.js', 'signin.js']],
  ['linked.html', ['auth.js', 'history.js', 'signin.js']],
  ['setup-wizard.html', ['auth.js', 'history.js', 'setup-wizard.js']],
  ['extensions.html', ['auth.js', 'history.js', 'extensions.js']],
]

function sandboxFor(html: string) {
  const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]))

  const el = (id: string): Record<string, unknown> => ({
    id,
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    className: '',
    title: '',
    type: '',
    tagName: 'DIV',
    dataset: {},
    style: { setProperty() {} },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    content: { firstElementChild: { cloneNode: () => el('clone') } },
    parentElement: { querySelector: () => el('sibling') },
    addEventListener() {},
    removeAttribute() {},
    setAttribute() {},
    focus() {},
    reset() {},
    checkValidity: () => true,
    querySelector: () => el('child'),
    querySelectorAll: () => [],
    replaceChildren() {},
    append() {},
    remove() {},
    childNodes: [],
    children: [],
    firstChild: null,
  })

  const document = {
    addEventListener() {},
    getElementById: (id: string) => (ids.has(id) ? el(id) : null),
    querySelector: () => el('q'),
    querySelectorAll: () => [],
    createElement: () => el('created'),
    body: el('body'),
  }

  const storage = { getItem: () => null, setItem() {}, removeItem() {} }

  let boot: ((page: unknown) => unknown) | null = null
  const registered: string[] = []

  const sandbox: Record<string, unknown> = {
    onPage(names: string | string[], init: (page: unknown) => unknown) {
      registered.push(...[names].flat())
      boot = init
    },
    document,
    localStorage: storage,
    window: {
      location: { pathname: '/', search: '', hash: '', href: '', origin: 'http://x', host: 'x' },
      localStorage: storage,
      addEventListener() {},
    },
    history: { replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, settings: [], extensions: [], stages: [] }),
    }),
    setTimeout,
    setInterval: () => 0,
    clearInterval() {},
    clearTimeout() {},
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    URL,
    Blob: class {},
    FormData: class {
      append() {}
    },
    AbortController: class {
      signal = null
      abort() {}
    },
    Node: { TEXT_NODE: 3 },
  }
  sandbox.globalThis = sandbox
  return { sandbox, getBoot: () => boot, getRegistered: () => registered }
}

const scopeStub = {
  alive: true,
  on() {},
  every: () => 0,
  after: () => 0,
  frame() {},
  leave() {},
}

describe('every page script survives being booted', () => {
  it.each(PAGES)('%s', async (page, scripts) => {
    const html = readFileSync(join(staticDir, page), 'utf8')
    const { sandbox, getBoot, getRegistered } = sandboxFor(html)
    const context = vm.createContext(sandbox)

    for (const script of scripts) {
      const source = readFileSync(join(staticDir, script), 'utf8')
      expect(() => vm.runInContext(source, context, { filename: script }), script).not.toThrow()
    }

    const name = /<body[^>]*\sdata-page="([\w-]+)"/.exec(html)?.[1]
    expect(name, `${page} carries no data-page`).toBeTruthy()
    expect(getRegistered(), `${page} is not the name its script answers to`).toContain(name)

    const boot = getBoot()
    expect(boot, `${page} registered no page setup`).toBeTruthy()
    await expect((async () => boot?.(scopeStub))()).resolves.not.toThrow()
  })
})
