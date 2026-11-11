/*
 * Printed charts must fit the paper (#605).
 *
 * ECharts draws at the width the chart had on screen and pins that width inline
 * on its own wrapper. A4 at the print stylesheet's 12mm margins is about 700 CSS
 * pixels wide, so a chart drawn for a 1200 or 1920 window ran off the page and
 * lost its last bar and axis labels. Scaling alone would fit it, but would shrink
 * a wide window's labels until they could not be read.
 *
 * So a wide chart is redrawn at about paper width just before the print, and its
 * SVG gets a viewBox for the print, which is what lets the print stylesheet scale
 * it into whatever column it lands in. Without one the SVG is clipped, not scaled.
 * Both are undone afterwards.
 */
import { onBeforeUnmount, onMounted, type Ref } from 'vue'

/** About A4 less the 12mm margins and a card's padding, in CSS pixels. */
export const PRINT_CHART_WIDTH_PX = 640

/** The part of vue-echarts' exposed API this needs. */
export interface PrintFitChart {
  getWidth: () => number
  getHeight: () => number
  resize: (opts?: { width?: number | 'auto'; animation?: { duration: number } }) => void
  /** The live ECharts instance; undefined until it has initialised. */
  chart?: { getZr: () => { flush: () => void } }
  /** The element the chart renders into. */
  root?: HTMLElement
}

/** Separate from the lifecycle wiring so a test can drive a print without a browser. */
export function createChartPrintFit(getChart: () => PrintFitChart | null | undefined) {
  let resized = false
  let scaled: Element | null = null
  return {
    beforePrint() {
      const chart = getChart()
      if (!chart) return
      try {
        const width = chart.getWidth()
        const target = Math.min(width, PRINT_CHART_WIDTH_PX)
        if (width > target) {
          chart.resize({ width: target, animation: { duration: 0 } })
          resized = true
          // ECharts repaints on the next animation frame, and the print takes its
          // snapshot before one comes: without this the page gets the new box with
          // the old drawing, still clipped.
          chart.chart?.getZr().flush()
        }
        const svg = chart.root?.querySelector('svg')
        if (svg) {
          svg.setAttribute('viewBox', `0 0 ${target} ${chart.getHeight()}`)
          scaled = svg
        }
      } catch {
        // vue-echarts throws until the chart has initialised. Print what is there.
      }
    },
    afterPrint() {
      scaled?.removeAttribute('viewBox')
      scaled = null
      if (!resized) return
      resized = false
      try {
        // 'auto', not resize(): a width given once is kept until it is cleared,
        // and the chart would then stop following its container.
        getChart()?.resize({ width: 'auto' })
      } catch {
        // The chart went away during the print dialog: nothing to restore.
      }
    },
  }
}

export function useChartPrintFit(chart: Ref<PrintFitChart | null | undefined>) {
  const fit = createChartPrintFit(() => chart.value)
  onMounted(() => {
    window.addEventListener('beforeprint', fit.beforePrint)
    window.addEventListener('afterprint', fit.afterPrint)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('beforeprint', fit.beforePrint)
    window.removeEventListener('afterprint', fit.afterPrint)
  })
}
