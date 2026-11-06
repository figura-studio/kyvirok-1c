#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ConnectionPool, FileConnectionSource, registerDataTools, registerSchemaTools,
  resolveDataDir, resolveLimits, toolResult } from './dist/upstream.mjs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { makeReviews, policySchema } from './changes.mjs'

export function buildServer(pool, policy) {
  const server = new McpServer({ name: 'kyvirok-1c', version: '0.1.0' })
  registerSchemaTools(server, pool, resolveLimits())
  registerDataTools(server, pool, resolveLimits())
  const reviews = makeReviews(pool, policy)
  server.registerTool('preview_change', {
    title: 'Показать изменения в 1С',
    description: 'Prepare creation or editing of one catalog item or draft document. Discover fields with describe_entity. A table field replaces ALL its rows. Show the returned changes to the manager.',
    inputSchema: {
      connection: z.string().min(1), entitySet: z.string().min(1),
      operation: z.enum(['create', 'update']), key: z.uuid().optional(),
      fields: z.record(z.string(), z.json()),
    },
  }, async (args) => toolResult(() => reviews.preview(args)))
  server.registerTool('apply_reviewed_change', {
    title: 'Записать проверенные изменения в 1С',
    description: 'Request explicit human approval for the immutable preview. Decline or cancel skips the write. Never automatically re-create a plan after an unknown write outcome.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: { reviewId: z.uuid() },
  }, async ({ reviewId }) => toolResult(() => reviews.apply(reviewId, async (message) => {
    const capability = server.server.getClientCapabilities()?.elicitation
    if (!capability || ('url' in capability && !('form' in capability))) {
      throw new Error('Для записи клиент MCP должен поддерживать форму подтверждения.')
    }
    const result = await server.server.elicitInput({
      mode: 'form', message, requestedSchema: {
        type: 'object', properties: {
          confirm: { type: 'boolean', title: 'Записать именно эти изменения в 1С', default: false },
        }, required: ['confirm'],
      },
    })
    return result.action === 'accept' && result.content?.confirm === true
  })))
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const dataDir = process.env.ONEC_MCP_DATA_DIR ? resolveDataDir() : join(dirname(resolveDataDir()), 'kyvirok-1c')
  const file = process.env.KYVIROK_1C_POLICY || (existsSync(join(dataDir, 'write-policy.json')) ? join(dataDir, 'write-policy.json') : '')
  if (file && !isAbsolute(file)) throw new Error('KYVIROK_1C_POLICY должен содержать абсолютный путь.')
  const policy = policySchema.parse(file ? JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {})
  class LocalSource extends FileConnectionSource {
    secretPath(name) {
      return process.platform === 'win32' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)
        ? join(dataDir, name + '.dpapi') : null
    }
    async secretSource(name) {
      const path = this.secretPath(name)
      return path && existsSync(path) ? 'Windows DPAPI' : super.secretSource(name)
    }
    async getSecret(name) {
      const path = this.secretPath(name)
      if (!path || !existsSync(path)) return super.getSecret(name)
      const script = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' +
        '$s = ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim()); ' +
        '[Console]::Write([Net.NetworkCredential]::new("", $s).Password)'
      return execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {
        input: readFileSync(path), encoding: 'utf8', windowsHide: true, timeout: 10000, stdio:['pipe','pipe','ignore'],
      })
    }
  }
  const pool = new ConnectionPool(new LocalSource({ dataDir }))
  await buildServer(pool, policy).connect(new StdioServerTransport())
}
