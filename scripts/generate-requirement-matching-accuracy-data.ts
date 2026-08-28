import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import {
  buildRequirementMatchingAccuracyDataset,
  validateRequirementMatchingAccuracyDataset
} from './requirement-matching-accuracy'

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const output = resolve(argument('--output') ?? 'test-data/requirement-matching/v1.5/accuracy-dataset.json')
const dataset = buildRequirementMatchingAccuracyDataset()
const validation = validateRequirementMatchingAccuracyDataset(dataset)
if (!validation.ok) throw new Error(`Generated dataset is invalid: ${validation.errors.join('; ')}`)

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8')
const persisted = JSON.parse(await readFile(output, 'utf8'))
const persistedValidation = validateRequirementMatchingAccuracyDataset(persisted)
if (!persistedValidation.ok) throw new Error(`Persisted dataset is invalid: ${persistedValidation.errors.join('; ')}`)

console.log(JSON.stringify({
  ok: true,
  output,
  datasetVersion: dataset.datasetVersion,
  seed: dataset.seed,
  queryCount: dataset.queries.length,
  candidateCount: dataset.candidates.length,
  labelCount: dataset.labels.length,
  snapshotHash: dataset.snapshotHash
}))
