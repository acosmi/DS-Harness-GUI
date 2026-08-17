import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const workflowDirectory = resolve(root, '.github/workflows')
const automationWorkflow = 'automation-pull-request.yml'

describe('automation pull-request workflow', () => {
  it('opens one draft pull request for automation branches without branch mutation or merge authority', () => {
    const workflow = loadWorkflow(automationWorkflow)
    expect(workflow.on).toEqual({ push: { branches: ['codex/automation/**'] } })
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' })
    expect(workflow.concurrency).toEqual({
      group: 'automation-pull-request-${{ github.ref }}',
      'cancel-in-progress': true,
    })

    const open = workflowJob(workflow, 'open')
    if (!Array.isArray(open.steps)) throw new TypeError('automation workflow must define steps')
    const script = open.steps
      .filter(isRecord)
      .map(step => step.run)
      .find((run): run is string => typeof run === 'string')
    if (script === undefined) throw new TypeError('automation workflow must define a command step')

    const ghCommands = Array.from(
      script.matchAll(/^\s*gh ([a-z-]+ [a-z-]+)(?:\s|\\)/gm),
      match => match[1],
    )
    expect(ghCommands).toEqual(['pr list', 'pr create'])
    expect(script).toContain('--draft')
    expect(script).toContain('Open pull request already exists')
    expect(script).not.toMatch(/^\s*git(?:\s|$)/m)
  })

  it('keeps pull-request write permission isolated to the proposal workflow', () => {
    const writers = readdirSync(workflowDirectory)
      .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
      .filter(file => requestsPullRequestWrite(loadWorkflow(file)))
      .sort()

    expect(writers).toEqual([automationWorkflow])
  })
})

function loadWorkflow(file: string): Record<string, unknown> {
  const value: unknown = yaml.load(readFileSync(resolve(workflowDirectory, file), 'utf8'))
  if (!isRecord(value)) throw new TypeError(`${file} must contain a workflow object`)
  return value
}

function workflowJob(workflow: Record<string, unknown>, name: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[name])) {
    throw new TypeError(`workflow must define the ${name} job`)
  }
  return workflow.jobs[name]
}

function requestsPullRequestWrite(workflow: Record<string, unknown>): boolean {
  if (hasPullRequestWrite(workflow.permissions)) return true
  if (!isRecord(workflow.jobs)) return false
  return Object.values(workflow.jobs).some(job => isRecord(job) && hasPullRequestWrite(job.permissions))
}

function hasPullRequestWrite(value: unknown): boolean {
  return isRecord(value) && value['pull-requests'] === 'write'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
