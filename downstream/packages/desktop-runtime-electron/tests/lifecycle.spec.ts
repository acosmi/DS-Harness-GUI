import { describe, expect, it } from 'vitest'
import {
  canFocusExistingWindow,
  desktopActivateAction,
  shouldPromptRendererRestart,
} from '../src/lifecycle.ts'

describe('desktop window teardown policy', () => {
  it('ignores activate after teardown starts so Dock reopen cannot rebuild IPC', () => {
    expect(desktopActivateAction(true, false)).toBe('ignore')
    expect(desktopActivateAction(true, true)).toBe('ignore')
  })

  it('shows a live window and opens a replacement only while the application is running', () => {
    expect(desktopActivateAction(false, true)).toBe('show')
    expect(desktopActivateAction(false, false)).toBe('open')
  })

  it('focuses a second instance only when a live window exists outside teardown', () => {
    expect(canFocusExistingWindow(false, true)).toBe(true)
    expect(canFocusExistingWindow(false, false)).toBe(false)
    expect(canFocusExistingWindow(true, true)).toBe(false)
  })

  it('skips the renderer-restart dialog during teardown and on a clean renderer exit', () => {
    expect(shouldPromptRendererRestart(true, 'crashed')).toBe(false)
    expect(shouldPromptRendererRestart(false, 'clean-exit')).toBe(false)
    expect(shouldPromptRendererRestart(false, 'crashed')).toBe(true)
  })
})
