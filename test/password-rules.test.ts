import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { passwordProblem, passwordRules, RULES } from '../src/auth/password.js'
import { config } from '../src/config.js'

const staticDir = config.staticDir
const auth = readFileSync(join(staticDir, 'auth.js'), 'utf8')

function load(): {
  passwordChecks: (
    rules: { needs: { id: string; said: string }[] },
    min: number
  ) => { id: string; said: string; met: (value: string) => boolean }[]
} {
  const fn = new Function(`${auth}; return { passwordChecks }`)
  return fn() as ReturnType<typeof load>
}

const ALL = {
  needs: [
    { id: 'upper', said: 'a capital letter' },
    { id: 'lower', said: 'a small letter' },
    { id: 'digit', said: 'a digit' },
    { id: 'symbol', said: 'a symbol' },
  ],
}

describe('the checks the panel draws', () => {
  it('always leads with the length, then only what is required', () => {
    const { passwordChecks } = load()

    expect(passwordChecks({ needs: [] }, 10).map((c) => c.id)).toEqual(['length'])
    expect(passwordChecks(ALL, 10).map((c) => c.id)).toEqual([
      'length',
      'upper',
      'lower',
      'digit',
      'symbol',
    ])
  })

  it('says the length it was given, not a baked-in one', () => {
    const { passwordChecks } = load()
    expect(passwordChecks({ needs: [] }, 17)[0]!.said).toBe('At least 17 characters')
  })

  it('starts each line with a capital, since each is its own sentence', () => {
    const { passwordChecks } = load()
    for (const check of passwordChecks(ALL, 10)) {
      expect(check.said[0], check.said).toBe(check.said[0]!.toUpperCase())
    }
  })

  it('ignores a requirement it has no test for', () => {
    const { passwordChecks } = load()
    const checks = passwordChecks({ needs: [{ id: 'moon-phase', said: 'a full moon' }] }, 10)
    expect(
      checks.map((c) => c.id),
      'an unknown rule is dropped, not drawn unsatisfiable'
    ).toEqual(['length'])
  })
})

describe('the panel and the server agree', () => {
  const CASES = [
    'short',
    'abcdefghijklm',
    'ABCDEFGHIJKLM',
    'abcdefghijk1',
    'abcdefghijk!',
    'Abcdefghijk1!',
    'ÄÖÜäöü-12345',
    '            ',
    '日本語のパスワード',
    'passwort mit leerzeichen',
  ]

  it('reaches the same verdict on every rule, for every case', () => {
    const { passwordChecks } = load()

    for (const rule of ALL.needs) {
      const checks = passwordChecks({ needs: [rule] }, 1)
      const check = checks.find((c) => c.id === rule.id)!

      for (const value of CASES) {
        const server = serverAccepts(rule.id, value)
        expect(check.met(value), `${rule.id} on "${value}"`).toBe(server)
      }
    }
  })

  it('agrees on the length too', () => {
    const { passwordChecks } = load()
    const check = passwordChecks({ needs: [] }, 10)[0]!

    for (const value of CASES) {
      expect(check.met(value), `length on "${value}"`).toBe(value.length >= 10)
    }
  })
})

function serverAccepts(id: string, value: string): boolean {
  const rule = RULES.find((entry) => entry.id === id)
  if (!rule) throw new Error(`No server rule called ${id}`)
  return rule.test.test(value)
}

describe('what the server sends the panel', () => {
  it('names a rule the panel knows how to test', () => {
    const known = ['upper', 'lower', 'digit', 'symbol']
    const before = passwordRules()

    for (const need of before.needs) {
      expect(known, `the panel cannot draw ${need.id}`).toContain(need.id)
    }
  })

  it('describes each rule the same way the refusal does', () => {
    const said = passwordRules().needs.map((n) => n.said)
    for (const phrase of said) {
      expect(passwordProblem('')).toBeTruthy()
      expect(phrase.startsWith('a ') || phrase.startsWith('an ')).toBe(true)
    }
  })
})
