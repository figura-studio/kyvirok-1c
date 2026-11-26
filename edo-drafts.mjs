import { createHash } from 'node:crypto'
import { mkdir, open, readFile, realpath, lstat, writeFile, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { z } from 'zod'

const uuid = z.uuid().transform(s => s.toLowerCase())
const account = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const edoDraftInput = { account,
  fileName: z.string().min(5).max(180).regex(/^[^\\/:*?"<>|\x00-\x1f]+\.xml$/i),
  recipientBoxId: uuid }
const titleSchema = z.object({ TypeNamedId: z.enum(['UniversalTransferDocument', 'Invoice']),
  Function: z.string().min(1).max(100), Version: z.string().min(1).max(100), TitleIndex: z.literal(0) })

// Defense in depth: this transport cannot be used as a generic send/sign API.
export function validateDraftBody(value) {
  return z.strictObject({ FromBoxId: uuid, ToBoxId: uuid, IsDraft: z.literal(true),
    LockDraft: z.literal(false), StrictDraftValidation: z.literal(true),
    DocumentAttachments: z.array(z.strictObject({
      TypeNamedId: z.enum(['UniversalTransferDocument', 'Invoice']), Function: z.string().min(1).max(100),
      Version: z.string().min(1).max(100),
      SignedContent: z.strictObject({ Content: z.string().min(1).max(180000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }),
    })).length(1),
  }).refine(v => v.FromBoxId !== v.ToBoxId).parse(value)
}

async function localXml(directory, fileName) {
  const root = await realpath(directory), path = join(root, fileName)
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || dirname(await realpath(path)) !== root) throw new Error('XML должен быть обычным файлом непосредственно в разрешённом каталоге.')
  const file = await open(path, 'r')
  let bytes
  try {
    const stat = await file.stat()
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('XML был заменён во время открытия.')
    if (!stat.isFile() || stat.size < 1 || stat.size > 128 * 1024) throw new Error('Размер XML должен быть от 1 байта до 128 КБ.')
    bytes = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < bytes.length) {
      const part = await file.read(bytes, size, bytes.length - size, null)
      if (!part.bytesRead) break
      size += part.bytesRead
    }
    if (size !== stat.size || dirname(await realpath(path)) !== root) throw new Error('Файл изменился во время чтения.')
    bytes = bytes.subarray(0, size)
  } finally { await file.close() }
  const prefix = bytes.subarray(0, 200).toString('ascii')
  const encoding = prefix.match(/encoding\s*=\s*["']([^"']+)["']/i)?.[1].toLowerCase() ?? 'utf-8'
  if (!['utf-8', 'utf8', 'windows-1251'].includes(encoding)) throw new Error('Поддерживаются XML UTF-8 и Windows-1251.')
  let xml
  try { xml = new TextDecoder(encoding, { fatal: true }).decode(bytes) } catch { throw new Error('Некорректная кодировка XML.') }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Некорректный XML; DTD и объявления сущностей запрещены.')
  const parsed = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false }).parse(xml)
  const document = parsed?.Файл?.Документ, invoice = document?.СвСчФакт
  if (!invoice || Array.isArray(document) || Array.isArray(invoice)) throw new Error('Ожидается один XML титула продавца УПД/счёта-фактуры (Файл/Документ/СвСчФакт). PDF и произвольные XML не поддерживаются.')
  function party(node) {
    const identity = node?.ИдСв?.СвЮЛУч ?? node?.ИдСв?.СвИП
    const inn = identity?.['@_ИННЮЛ'] ?? identity?.['@_ИННФЛ']
    if (!/^\d{10}(\d{2})?$/.test(inn ?? '')) throw new Error('Не найден однозначный ИНН продавца/покупателя в XML.')
    return { inn, kpp: identity['@_КПП'], name: identity['@_НаимОрг'] }
  }
  return { bytes, xml, sha256: sha256(bytes), path, seller: party(invoice.СвПрод), buyer: party(invoice.СвПокуп),
    number: invoice['@_НомерДок'], date: invoice['@_ДатаДок'] }
}

export function makeEdoDrafts(state, queue, directory, secret, factory) {
  function settings(name) {
    account.parse(name); state.assertCurrent()
    const config = Object.hasOwn(state.policy, name) && state.policy[name]
    if (!config?.operations.includes('draft.create') || !config.importDirectory) throw new Error('Импорт черновиков выключен. Нужны draft.create и importDirectory в edo-policy.json.')
    return config
  }
  function receiptPath(name, id) { account.parse(name); uuid.parse(id); return join(directory, name + '-' + id + '.json') }
  async function readReceipt(name, id) {
    try { return JSON.parse(await readFile(receiptPath(name, id), 'utf8')) }
    catch (e) { if (e.code === 'ENOENT') return null; throw new Error('Журнал импорта недоступен. Не повторяйте операцию.') }
  }
  async function box(request, id, party) {
    const value = await request('/GetBox', { boxId: id })
    if (value.BoxIdGuid?.toLowerCase() !== id || value.Organization?.Inn !== party.inn ||
      (party.kpp && value.Organization?.Kpp !== party.kpp)) throw new Error('Ящик Диадока не совпадает с ИНН/КПП стороны в XML.')
    return { boxId: id, name: value.Organization?.FullName ?? value.Title, inn: value.Organization.Inn, kpp: value.Organization.Kpp }
  }
  return {
    async preview(args) {
      const input = z.strictObject(edoDraftInput).parse(args), config = settings(input.account)
      if (input.recipientBoxId === config.boxId) throw new Error('Ящики отправителя и получателя должны отличаться.')
      const file = await localXml(config.importDirectory, input.fileName)
      // Read party identities only. XML bytes leave the computer only AFTER human approval.
      const request = factory(() => secret(input.account))
      const sender = await box(request, config.boxId, file.seller)
      const recipient = await box(request, input.recipientBoxId, file.buyer)
      const fingerprint = sha256(JSON.stringify([config.boxId, input.recipientBoxId, file.sha256]))
      const operationId = [fingerprint.slice(0,8),fingerprint.slice(8,12),'4'+fingerprint.slice(13,16),'8'+fingerprint.slice(17,20),fingerprint.slice(20,32)].join('-')
      if (await readReceipt(input.account, operationId)) throw new Error('Этот XML уже пытались импортировать. Используйте get_edo_draft_receipt с operationId ' + operationId + ' и проверьте кабинет; автоматический дубль запрещён.')
      const check = async () => {
        const current = settings(input.account)
        if (current.boxId !== config.boxId || current.importDirectory !== config.importDirectory ||
          (await localXml(current.importDirectory, input.fileName)).sha256 !== file.sha256) throw new Error('XML или настройки изменились. Нужен новый предпросмотр.')
      }
      return queue.add({ review: { операция: 'Загрузить XML в Диадок как неподписанный черновик',
        account: input.account, operationId, sender, recipient, number: file.number, date: file.date,
        file: { name: input.fileName, localPath: file.path, bytes: file.bytes.length, sha256: file.sha256 },
        xml: file.xml,
        эффекты: ['Передать показанный XML оператору для распознавания и сохранения черновика.',
          'Подпись и отправка контрагенту не выполняются. Сотрудник проверяет и завершает их в кабинете Диадока.'] },
      check, execute: async assertFresh => {
        await check()
        await box(request, config.boxId, file.seller); await box(request, input.recipientBoxId, file.buyer)
        state.assertCurrent(); assertFresh()
        const detected = await request('/DetectDocumentTitles', { boxId: config.boxId }, file.bytes)
        const titles = detected.DocumentTitles
        if (!Array.isArray(titles) || titles.length !== 1 || !titleSchema.safeParse(titles[0]).success) throw new Error('Диадок не распознал единственный титул продавца УПД/счёта-фактуры. Черновик не создавался.')
        const title = titleSchema.parse(titles[0])
        const body = validateDraftBody({ FromBoxId: config.boxId, ToBoxId: input.recipientBoxId,
          IsDraft: true, LockDraft: false, StrictDraftValidation: true,
          DocumentAttachments: [{ TypeNamedId: title.TypeNamedId, Function: title.Function, Version: title.Version,
            SignedContent: { Content: file.bytes.toString('base64') } }] })
        await check(); assertFresh()
        await mkdir(directory, { recursive: true })
        const path = receiptPath(input.account, operationId)
        const receipt = { account: input.account, operationId, sha256: file.sha256, fileName: input.fileName,
          sender, recipient, state: 'unknown', attemptedAt: new Date().toISOString(),
          cabinetUrl: 'https://diadoc.kontur.ru/', signingPerformed: false, sendingPerformed: false }
        // Exclusive durable reservation precedes the POST. A crash/timeout can never trigger an automatic duplicate.
        let journal
        try { journal = await open(path, 'wx', 0o600) }
        catch (error) {
          if (error.code === 'EEXIST') throw new Error('Импорт уже зарегистрирован. Проверьте get_edo_draft_receipt; повторная загрузка запрещена.')
          throw new Error('Не удалось сохранить журнал импорта. XML в черновик не загружался.')
        }
        try { await journal.writeFile(JSON.stringify(receipt)); await journal.sync() } finally { await journal.close() }
        let response
        try {
          state.assertCurrent(); assertFresh()
          response = await request('/V3/PostMessage', { operationId }, body)
          const draft = response.MessageType === 'Draft' || response.MessageType === 2 ||
            (response.MessageType === undefined && response.IsDraft === true)
          if (!draft || !uuid.safeParse(response.MessageId).success || response.FromBoxId?.toLowerCase() !== config.boxId ||
            response.ToBoxId?.toLowerCase() !== input.recipientBoxId) throw new Error('Неподтверждённый ответ на создание черновика.')
          receipt.state = 'created'; receipt.messageId = response.MessageId.toLowerCase()
          receipt.entityIds = (response.Entities ?? []).map(e => e.EntityId).filter(id => uuid.safeParse(id).success)
          await writeFile(path + '.tmp', JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
          await rename(path + '.tmp', path)
        } catch {
          receipt.state = 'unknown'
          return { summary: 'Результат создания черновика не подтверждён. Не повторяйте загрузку. Проверьте черновики в кабинете по файлу, номеру и operationId.', data: receipt }
        }
        return { summary: 'Диадок подтвердил создание неподписанного черновика. Откройте кабинет, проверьте документ; подпись и отправку выполняет человек.', data: receipt }
      } })
    },
    async receipt({ account: name, operationId }) {
      settings(name)
      const saved = await readReceipt(name, operationId)
      if (!saved) throw new Error('Записи в локальном журнале нет. Это не доказывает отсутствия черновика в Диадоке.')
      return { summary: 'Локальная квитанция импорта, не текущий статус документа в Диадоке. Повторная загрузка не выполняется.', data: saved }
    },
  }
}
