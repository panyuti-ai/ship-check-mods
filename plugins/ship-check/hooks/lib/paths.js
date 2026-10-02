// Path helpers. Everything is normalized to forward slashes with a lower-case drive letter,
// so a Windows path and its Git Bash spelling (/c/Users/me) compare equal.

export function normalizePath(p) {
  if (typeof p !== 'string' || p === '') return ''
  let s = p.replace(/\\/g, '/')
  // Git Bash spells C:\Users as /c/Users
  const bash = /^\/([a-zA-Z])(\/|$)/.exec(s)
  if (bash) s = bash[1] + ':/' + s.slice(3)
  const drive = /^([a-zA-Z]):(\/|$)/.exec(s)
  let prefix = ''
  if (drive) {
    prefix = drive[1].toLowerCase() + ':'
    s = s.slice(2)
  }
  const absolute = s.startsWith('/')
  const out = []
  for (const part of s.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  return prefix + (absolute || prefix ? '/' : '') + out.join('/')
}

export function isAbsolute(p) {
  return typeof p === 'string' && (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\'))
}

// Resolves `rel` against `base`. Returns null for spellings we cannot resolve (~, $VAR, -).
export function resolveDir(base, rel) {
  if (typeof rel !== 'string' || rel === '') return null
  if (rel.startsWith('~') || rel.includes('$') || rel === '-') return null
  if (isAbsolute(rel)) return normalizePath(rel)
  if (!base) return null
  return normalizePath(base + '/' + rel)
}

export function isUnder(child, parent) {
  if (!child || !parent) return false
  if (child === parent) return true
  const p = parent.endsWith('/') ? parent : parent + '/'
  return child.startsWith(p)
}

export function relativeTo(child, parent) {
  if (child === parent) return ''
  return child.startsWith(parent + '/') ? child.slice(parent.length + 1) : child
}

// A short spelling of a project location for the UI.
export function displayLocation(location, cwd) {
  if (!location) return 'unknown location'
  if (cwd && location === cwd) return '.'
  if (cwd && isUnder(location, cwd)) return './' + relativeTo(location, cwd)
  return location
}
