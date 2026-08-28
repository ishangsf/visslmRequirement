import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))

assert.equal(pkg.version, '1.5.0')
assert.equal(lock.version, '1.5.0')
assert.equal(lock.packages[''].version, '1.5.0')
assert.equal(pkg.build.artifactName, 'VISSLM-Agent-Setup-${version}.${ext}')

console.log(JSON.stringify({ ok: true, version: pkg.version }))
