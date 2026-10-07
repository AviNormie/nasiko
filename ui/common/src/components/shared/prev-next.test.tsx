import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PrevNext } from './prev-next'

function setup(props: Partial<Parameters<typeof PrevNext>[0]> = {}) {
  const onPrev = vi.fn()
  const onNext = vi.fn()
  render(<PrevNext noun="agent" index={1} count={3} onPrev={onPrev} onNext={onNext} {...props} />)
  return { onPrev, onNext }
}

describe('PrevNext', () => {
  it('shows the position and steps with the buttons', async () => {
    const { onPrev, onNext } = setup()
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Previous agent' }))
    await userEvent.click(screen.getByRole('button', { name: 'Next agent' }))
    expect(onPrev).toHaveBeenCalledTimes(1)
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('steps with J and K', async () => {
    const { onPrev, onNext } = setup()
    await userEvent.keyboard('j')
    await userEvent.keyboard('k')
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(onPrev).toHaveBeenCalledTimes(1)
  })

  it('stays focusable but inert at the ends', async () => {
    const { onPrev } = setup({ index: 0 })
    const prev = screen.getByRole('button', { name: 'Previous agent' })
    expect(prev).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(prev)
    await userEvent.keyboard('k')
    expect(onPrev).not.toHaveBeenCalled()
  })

  it('does nothing while blocked, and says why', async () => {
    const { onNext } = setup({ blocked: 'Save first' })
    const next = screen.getByRole('button', { name: 'Next agent' })
    expect(next).toHaveAttribute('aria-disabled', 'true')
    expect(next).toHaveAttribute('title', 'Save first')
    await userEvent.click(next)
    await userEvent.keyboard('j')
    expect(onNext).not.toHaveBeenCalled()
  })
})
