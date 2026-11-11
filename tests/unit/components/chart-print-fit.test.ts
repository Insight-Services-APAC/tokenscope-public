// @vitest-environment happy-dom
/*
 * Printed charts fit the paper (#605): a wide chart is redrawn at paper width
 * before the print, its SVG scales through a viewBox, and both are undone after.
 */
import { describe, it, expect, vi } from 'vitest'
import { createChartPrintFit, PRINT_CHART_WIDTH_PX } from '../../../app/components/reporting/charts/useChartPrintFit'

function chartOf(width: number, height = 300) {
  const flush = vi.fn()
  const root = document.createElement('div')
  root.innerHTML = '<div><svg></svg></div>'
  return {
    getWidth: vi.fn(() => width),
    getHeight: vi.fn(() => height),
    resize: vi.fn(),
    flush,
    chart: { getZr: () => ({ flush }) },
    root,
    svg: root.querySelector('svg')!,
  }
}

describe('createChartPrintFit', () => {
  it('redraws a screen-width chart at paper width with no animation', () => {
    const chart = chartOf(1100)
    createChartPrintFit(() => chart).beforePrint()
    expect(chart.resize).toHaveBeenCalledExactlyOnceWith({ width: PRINT_CHART_WIDTH_PX, animation: { duration: 0 } })
  })

  it('paints the resized chart before the print takes its snapshot', () => {
    const chart = chartOf(1100)
    createChartPrintFit(() => chart).beforePrint()
    expect(chart.flush).toHaveBeenCalledOnce()
    expect(chart.resize.mock.invocationCallOrder[0]).toBeLessThan(chart.flush.mock.invocationCallOrder[0]!)
  })

  it('gives the SVG a viewBox of the drawn size, so it scales instead of clipping', () => {
    const chart = chartOf(1100, 260)
    createChartPrintFit(() => chart).beforePrint()
    expect(chart.svg.getAttribute('viewBox')).toBe(`0 0 ${PRINT_CHART_WIDTH_PX} 260`)
  })

  it('clears the stored width after the print, so the chart follows its container again', () => {
    const chart = chartOf(1100)
    const fit = createChartPrintFit(() => chart)
    fit.beforePrint()
    fit.afterPrint()
    expect(chart.resize).toHaveBeenLastCalledWith({ width: 'auto' })
    expect(chart.svg.hasAttribute('viewBox')).toBe(false)
  })

  it('does not redraw a narrow chart, but still lets it scale, and removes that after', () => {
    const chart = chartOf(500, 200)
    const fit = createChartPrintFit(() => chart)
    fit.beforePrint()
    expect(chart.svg.getAttribute('viewBox')).toBe('0 0 500 200')
    fit.afterPrint()
    expect(chart.resize).not.toHaveBeenCalled()
    expect(chart.svg.hasAttribute('viewBox')).toBe(false)
  })

  it('restores only once for one print', () => {
    const chart = chartOf(1100)
    const fit = createChartPrintFit(() => chart)
    fit.beforePrint()
    fit.afterPrint()
    fit.afterPrint()
    expect(chart.resize).toHaveBeenCalledTimes(2)
  })

  it('does nothing when there is no chart, as in the empty state', () => {
    const fit = createChartPrintFit(() => null)
    expect(() => {
      fit.beforePrint()
      fit.afterPrint()
    }).not.toThrow()
  })

  it('still prints when the chart has not initialised', () => {
    const chart = { getWidth: () => { throw new Error('not ready') }, getHeight: () => 0, resize: vi.fn() }
    const fit = createChartPrintFit(() => chart)
    expect(() => fit.beforePrint()).not.toThrow()
    fit.afterPrint()
    expect(chart.resize).not.toHaveBeenCalled()
  })
})
