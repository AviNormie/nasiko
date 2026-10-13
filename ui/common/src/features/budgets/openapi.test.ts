// @vitest-environment node
// The UI's zod schemas accept every example in docs/requirements/budgets.openapi.yaml (plan feat-budget-burn #44), so
// the backend's machine-readable contract and the UI's parser can't drift apart unnoticed.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { z } from 'zod'
import {
  alertListSchema,
  atRiskListSchema,
  breakdownResponseSchema,
  budgetErrorBodySchema,
  budgetListSchema,
  budgetResponseSchema,
  budgetSettingsSchema,
  burnResponseSchema,
  capabilitiesSchema,
  changesResponseSchema,
  createBudgetBodySchema,
  hoursResponseSchema,
  priceListSchema,
  statusListSchema,
  traceListSchema,
  unbudgetedListSchema,
  updateBudgetBodySchema,
  versionListSchema,
} from './types'

type Json = Record<string, unknown>
const doc = parse(readFileSync('docs/requirements/budgets.openapi.yaml', 'utf8')) as Json
const resolve = (v: unknown): unknown => {
  if (!v || typeof v !== 'object' || !('$ref' in v)) return v
  return String((v as { $ref: string }).$ref)
    .slice(2)
    .split('/')
    .reduce<unknown>((o, k) => (o as Json)[k], doc)
}

/** The success schema of each operation (2xx), and the request body's where the route takes one. */
const RESPONSES: Record<string, z.ZodType> = {
  budgetsCapabilities: capabilitiesSchema,
  listBudgets: budgetListSchema,
  createBudget: budgetResponseSchema,
  getBudget: budgetResponseSchema,
  updateBudget: budgetResponseSchema,
  listBudgetVersions: versionListSchema,
  getBudgetSettings: budgetSettingsSchema,
  updateBudgetSettings: budgetSettingsSchema,
  getBurn: burnResponseSchema,
  getBurnBreakdown: breakdownResponseSchema,
  getBurnChanges: changesResponseSchema,
  getBurnHours: hoursResponseSchema,
  getBurnTraces: traceListSchema,
  getBudgetStatus: statusListSchema,
  getAtRisk: atRiskListSchema,
  getUnbudgeted: unbudgetedListSchema,
  getBudgetAlerts: alertListSchema,
  getModelPrices: priceListSchema,
}
const BODIES: Record<string, z.ZodType> = {
  createBudget: createBudgetBodySchema,
  updateBudget: updateBudgetBodySchema,
}

type Case = [name: string, schema: z.ZodType, value: unknown]
const cases: Case[] = []
const operations: string[] = []
for (const [path, item] of Object.entries(doc.paths as Json))
  for (const [method, raw] of Object.entries(item as Json)) {
    const op = raw as Json
    if (!op.operationId) continue
    const id = String(op.operationId)
    // Operations with a JSON success body (DELETE answers 204 with none).
    if (
      Object.entries(op.responses as Json).some(
        ([st, r]) => st.startsWith('2') && (resolve(r) as Json).content,
      )
    )
      operations.push(id)
    const examplesOf = (content: unknown) => {
      const json = (content as Json | undefined)?.['application/json'] as Json | undefined
      if (!json) return []
      const out: [string, unknown][] = []
      if ('example' in json) out.push(['example', json.example])
      for (const [k, e] of Object.entries((json.examples as Json | undefined) ?? {}))
        out.push([k, (resolve(e) as Json).value])
      return out
    }
    const body = resolve((op.requestBody as Json | undefined) ?? null) as Json | null
    for (const [k, v] of body ? examplesOf(body.content) : [])
      cases.push([`${method.toUpperCase()} ${path} body ${k}`, BODIES[id]!, v])
    for (const [status, r] of Object.entries(op.responses as Json)) {
      const res = resolve(r) as Json
      const schema = status.startsWith('2') ? RESPONSES[id] : budgetErrorBodySchema
      for (const [k, v] of examplesOf(res.content))
        cases.push([`${method.toUpperCase()} ${path} ${status} ${k}`, schema!, v])
    }
  }

describe('budgets.openapi.yaml examples parse with the UI zod schemas', () => {
  it('every operation has a schema', () => {
    expect(operations.filter((id) => !RESPONSES[id])).toEqual([])
    expect(cases.length).toBeGreaterThan(40)
  })

  it.each(cases)('%s', (_name, schema, value) => {
    const r = schema.safeParse(value)
    expect(r.success ? [] : r.error.issues).toEqual([])
  })
})
