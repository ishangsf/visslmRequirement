import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outputPath = join(projectRoot, 'out', '.smoke-knowledge.mjs')

const testCode = String.raw`
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as XLSX from 'xlsx'
import { AppDatabase } from './src/main/database.ts'
import { KnowledgeService } from './src/main/knowledge.ts'

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const crc32 = (bytes) => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const makeZip = (entries) => {
  const local = []
  const central = []
  let offset = 0
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(value, 'utf8')
    const crc = crc32(data)
    const header = Buffer.alloc(30 + nameBytes.length)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(header, 30)
    local.push(header, data)

    const directory = Buffer.alloc(46 + nameBytes.length)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0x0800, 8)
    directory.writeUInt16LE(0, 10)
    directory.writeUInt32LE(crc, 16)
    directory.writeUInt32LE(data.length, 20)
    directory.writeUInt32LE(data.length, 24)
    directory.writeUInt16LE(nameBytes.length, 28)
    directory.writeUInt32LE(offset, 42)
    nameBytes.copy(directory, 46)
    central.push(directory)
    offset += header.length + data.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length ?? Object.keys(entries).length, 8)
  end.writeUInt16LE(entries.length ?? Object.keys(entries).length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

const makeDocx = () => makeZip({
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX evidence</w:t></w:r></w:p></w:body></w:document>'
})

const makePdf = () => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 46 >>\nstream\nBT /F1 12 Tf 20 150 Td (PDF evidence) Tj ET\nendstream'
  ]
  const parts = [Buffer.from('%PDF-1.4\n', 'ascii')]
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.concat(parts).length)
    parts.push(Buffer.from((index + 1) + ' 0 obj\n' + objects[index] + '\nendobj\n', 'ascii'))
  }
  const xrefOffset = Buffer.concat(parts).length
  const xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' +
    offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n'
  parts.push(Buffer.from(xref, 'ascii'))
  return Buffer.concat(parts)
}

const main = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-knowledge-smoke-'))
  const dbPath = join(directory, 'knowledge.db')
  const files = {
    txt: join(directory, 'notes.txt'),
    docx: join(directory, 'report.docx'),
    xlsx: join(directory, 'table.xlsx'),
    pdf: join(directory, 'report.pdf'),
    bad: join(directory, 'broken.docx'),
    empty: join(directory, 'empty.txt')
  }
  let db = null
  try {
    await writeFile(files.txt, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('TXT evidence\nwith BOM')]))
    await writeFile(files.docx, makeDocx())
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['Metric', 'Value'],
      ['Excel evidence', 42]
    ]), 'Metrics')
    await writeFile(files.xlsx, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
    await writeFile(files.pdf, makePdf())

    db = new AppDatabase(dbPath, join(directory, 'assets'))
    const service = new KnowledgeService(db)
    await service.initialize()
    const upload = await service.processFiles([files.txt, files.docx, files.xlsx, files.pdf])
    assert(upload.acceptedCount === 4 && upload.failedCount === 0, 'all supported fixtures should be indexed')
    assert(upload.documents.every((document) => document.status === 'ready'), 'supported fixtures should be ready')

    const page = db.listKnowledgeDocuments({ page: 1, pageSize: 20 })
    assert(page.total === 4, 'document list should contain four fixtures')
    const details = await Promise.all(page.rows.map((document) => db.getKnowledgeDocument(document.id)))
    const txt = details.find((document) => document?.extension === '.txt')
    const docx = details.find((document) => document?.extension === '.docx')
    const xlsx = details.find((document) => document?.extension === '.xlsx')
    const pdf = details.find((document) => document?.extension === '.pdf')
    assert(txt?.chunks[0]?.content.includes('TXT evidence'), 'BOM text should be decoded')
    assert(docx?.chunks[0]?.content.includes('DOCX evidence'), 'DOCX should be parsed')
    assert(xlsx?.chunks[0]?.sheetName === 'Metrics' && xlsx.chunks[0].location.includes('Metrics'), 'worksheet metadata should be preserved')
    assert(pdf?.chunks[0]?.pageNumber === 1 && pdf.chunks[0].location.includes('1'), 'PDF page metadata should be preserved')

    const duplicate = await service.processFiles([files.txt])
    assert(duplicate.acceptedCount === 0 && duplicate.skippedCount === 1, 'duplicate uploads should be skipped by SHA-256')
    const pdfHits = await service.search('PDF evidence')
    assert(pdfHits.some((hit) => hit.source.sourceType === 'document' && hit.source.fileName === 'report.pdf'), 'vector search should rank PDF evidence')

    await writeFile(files.bad, Buffer.from('not a docx'))
    const failed = await service.processFiles([files.bad])
    assert(failed.failedCount === 1 && failed.documents[0]?.status === 'failed', 'invalid documents should retain failure reason')
    await writeFile(files.bad, makeDocx())
    const replacement = await service.processFiles([files.bad])
    assert(replacement.documents[0]?.status === 'ready' && replacement.documents[0]?.chunkCount > 0, 'corrected documents should be re-uploadable')

    await writeFile(files.empty, Buffer.alloc(0))
    const empty = await service.processFiles([files.empty])
    assert(empty.failedCount === 1 && empty.documents[0]?.errorMessage, 'empty text files should retain a failure reason')

    db.upsertRecord({
      uid: 'record-1',
      projectId: 'project-1',
      nodeType: 'Task',
      itemId: 'TASK-1',
      parentId: '',
      name: 'Collected record',
      lastModifyTime: new Date().toISOString(),
      raw: { content: 'record evidence' },
      normalizedText: 'record evidence'
    })
    await service.syncRecordIndex()
    const recordHits = await service.search('record evidence')
    assert(recordHits.some((hit) => hit.source.sourceType === 'record'), 'collected records should be searchable')
    db.deleteData(['record-1'])
    await service.syncRecordIndex()
    assert(!db.listKnowledgeIndexedRecordUids().includes('record-1'), 'deleted records should remove their index')

    const deletedId = txt.id
    const originalPath = txt.filePath
    assert(db.deleteKnowledgeDocument(deletedId).deleted, 'document metadata should be deletable')
    assert((await readFile(originalPath)).length > 0, 'deleting metadata must not delete the original file')
    assert(db.getKnowledgeDocument(deletedId) === null, 'deleted document should not have detail metadata')
    const rebuilt = await service.rebuildIndex()
    assert(rebuilt.ok && rebuilt.chunkCount > 0, 'index rebuild should persist vectors')
    db.close()
    db = null
    console.log('knowledge smoke passed')
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
`

try {
  await build({
    stdin: {
      contents: testCode,
      resolveDir: projectRoot,
      sourcefile: 'smoke-knowledge-entry.mjs',
      loader: 'js'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: outputPath,
    logLevel: 'warning'
  })
  if (process.env.VISSLM_KNOWLEDGE_REAL_MODEL !== '1') {
    process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK = '1'
  }
  await import(`${pathToFileURL(outputPath).href}?run=${Date.now()}`)
} finally {
  await rm(outputPath, { force: true })
}
