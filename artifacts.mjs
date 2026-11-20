import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const extensions = { 'application/pdf': '.pdf', 'application/xml': '.xml', 'text/xml': '.xml',
  'text/csv': '.csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/pkcs7-signature': '.p7s' }

export function makeArtifacts(directory) {
  if (!isAbsolute(directory)) throw new Error('Каталог результатов должен иметь абсолютный путь.')
  const known = new Map()
  let total = 0
  return {
    async save(info, bytes) {
      if (!extensions[info.mimeType] || info.size !== bytes.length ||
          createHash('sha256').update(bytes).digest('hex') !== info.sha256) throw new Error('Неверные данные файла.')
      if (total + bytes.length > 100 * 1024 * 1024) throw new Error('Достигнут лимит файлов сеанса (100 МБ).')
      const id = randomUUID()
      const localPath = join(directory, id + extensions[info.mimeType])
      await mkdir(directory, { recursive: true })
      await writeFile(localPath, bytes, { flag: 'wx', mode: 0o600 })
      total += bytes.length
      const uri = 'kyvirok-1c://artifacts/' + id
      const artifact = { ...info, uri, localPath }
      known.set(id, artifact)
      return artifact
    },
    async read(id) {
      const artifact = known.get(id)
      if (!artifact) throw new Error('Файл отсутствует в текущем сеансе.')
      const bytes = await readFile(artifact.localPath)
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Сохранённый файл изменился.')
      return { contents: [{ uri: artifact.uri, mimeType: artifact.mimeType, blob: bytes.toString('base64') }] }
    },
  }
}
