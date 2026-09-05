'use strict'

function attachCodeCells(root, options) {
  const length = options.length
  const pattern = options.numeric ? /[^0-9]/g : /[^A-Z0-9]/g
  const upper = options.numeric !== true

  const row = document.createElement('div')
  row.className = 'key-cells__row'
  const cells = []
  for (let i = 0; i < length; i++) {
    const cell = document.createElement('div')
    cell.className = 'key-cell'
    const caret = document.createElement('span')
    caret.className = 'key-cell__caret'
    cell.append(caret)
    cells.push(cell)
    row.append(cell)
  }

  const field = document.createElement('input')
  field.className = 'key-cells__input'
  field.inputMode = options.numeric ? 'numeric' : 'latin'
  field.autocomplete = options.autocomplete || 'off'
  field.spellcheck = false
  field.maxLength = length
  if (!options.numeric) field.autocapitalize = 'characters'
  if (options.label) field.setAttribute('aria-label', options.label)

  root.classList.add('key-cells')
  root.replaceChildren(row, field)

  let value = ''

  function paint() {
    cells.forEach((cell, i) => {
      const ch = value[i] || ''
      for (const node of [...cell.childNodes]) {
        if (node.nodeType === Node.TEXT_NODE) node.remove()
      }
      if (ch) cell.append(ch)
      cell.classList.toggle('is-filled', Boolean(ch))
      cell.classList.toggle('is-next', i === value.length)
    })
  }

  field.addEventListener('input', () => {
    const cleaned = (upper ? field.value.toUpperCase() : field.value)
      .replace(pattern, '')
      .slice(0, length)
    field.value = cleaned
    value = cleaned
    paint()
    options.onInput?.(value)
    if (value.length === length) options.onComplete?.(value)
  })

  field.addEventListener('focus', () => root.classList.add('is-focused'))
  field.addEventListener('blur', () => root.classList.remove('is-focused'))
  root.addEventListener('click', () => field.focus())

  paint()

  return {
    field,
    get value() {
      return value
    },
    clear() {
      value = ''
      field.value = ''
      paint()
    },
    focus() {
      field.focus()
    },
    markBad(bad) {
      root.classList.toggle('is-bad', Boolean(bad))
    },
  }
}
