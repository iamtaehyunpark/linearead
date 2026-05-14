// Linearead — minimal "One Gap" text reader.

import {
  prepareWithSegments,
  layoutNextLine,
  layoutNextLineRange,
  type LayoutCursor,
  type LayoutLineRange,
  type PreparedTextWithSegments,
} from '@chenglou/pretext'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PositionedLine = { x: number; y: number; text: string }

type Block = {
  source: HTMLElement
  stage: HTMLDivElement
  pool: HTMLSpanElement[]
  marker: HTMLDivElement
  prepared: PreparedTextWithSegments
  font: string
  lineHeight: number
  containerWidth: number
  color: string

  // Single source of truth: start cursor of each line seen so far.
  // Grows lazily as the user scrolls forward.
  // Invariant: cursorHistory.length >= displayLineIdx + 1
  cursorHistory: LayoutCursor[]
  displayLineIdx: number
  // Cached range for the focus line — shared between advance-check and marker.
  // Only width + cursors needed; no string allocated.
  focusLineRange: LayoutLineRange | null

  // Animation state — orthogonal to layout
  pixelOffset: number
  targetOffset: number

  locked: boolean
  scrollSessionEnded: boolean
  scrollEndTimer: number
  animating: boolean
  active: boolean

  wheelHandler: (e: WheelEvent) => void
  enterHandler: () => void
  leaveHandler: () => void
  originalStyles: { color: string; position: string; minHeight: string }
}

const blocks: Block[] = []
let scheduledRaf: number | null = null

// ---------------------------------------------------------------------------
// syncPool
// ---------------------------------------------------------------------------

function syncPool(
  pool: HTMLSpanElement[],
  count: number,
  parent: HTMLElement,
  create: () => HTMLSpanElement,
): void {
  while (pool.length < count) {
    const el = create()
    parent.appendChild(el)
    pool.push(el)
  }
  for (let i = 0; i < pool.length; i++) {
    pool[i]!.style.display = i < count ? '' : 'none'
  }
}

// ---------------------------------------------------------------------------
// buildProjection
// ---------------------------------------------------------------------------

function buildProjection(b: Block): { lines: PositionedLine[]; gapY: number; consumedWidth: number } {
  const lines: PositionedLine[] = []
  let row = 0
  let consumedWidth = 0

  // Consumed lines above the gap — stream from cursor history.
  for (let i = 0; i < b.displayLineIdx; i++) {
    const line = layoutNextLine(b.prepared, b.cursorHistory[i]!, b.containerWidth)
    if (!line) break
    lines.push({ x: 0, y: Math.round(row * b.lineHeight), text: line.text })
    row++
  }

  // Partial consumed portion of the focus line (pixelOffset used as maxWidth).
  const focusCursor = b.cursorHistory[b.displayLineIdx]!
  let afterConsumed: LayoutCursor = focusCursor
  if (b.pixelOffset > 0) {
    const consumed = layoutNextLine(b.prepared, focusCursor, b.pixelOffset)
    if (consumed) {
      lines.push({ x: 0, y: Math.round(row * b.lineHeight), text: consumed.text })
      afterConsumed = consumed.end
      consumedWidth = consumed.width
      row++
    }
  }

  const gapY = row * b.lineHeight
  row++ // gap row

  // Stream lines after the gap.
  let cursor = afterConsumed
  while (cursor.segmentIndex < b.prepared.segments.length) {
    const line = layoutNextLine(b.prepared, cursor, b.containerWidth)
    if (!line) break
    lines.push({ x: 0, y: Math.round(row * b.lineHeight), text: line.text })
    cursor = line.end
    row++
  }

  return { lines, gapY, consumedWidth }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function init(selector: string = 'article p'): Promise<void> {
  if (blocks.length > 0) return
  await document.fonts.ready
  const targets = document.querySelectorAll<HTMLElement>(selector)
  for (let i = 0; i < targets.length; i++) augment(targets[i]!)
}

export function destroy(): void {
  while (blocks.length > 0) {
    const b = blocks.pop()!
    b.source.style.color = b.originalStyles.color
    b.source.style.position = b.originalStyles.position
    b.source.style.minHeight = b.originalStyles.minHeight
    b.source.removeEventListener('wheel', b.wheelHandler)
    b.source.removeEventListener('pointerenter', b.enterHandler)
    b.source.removeEventListener('pointerleave', b.leaveHandler)
    b.stage.remove()
    clearTimeout(b.scrollEndTimer)
  }
  if (scheduledRaf !== null) {
    cancelAnimationFrame(scheduledRaf)
    scheduledRaf = null
  }
}

function augment(source: HTMLElement): void {
  const cs = getComputedStyle(source)
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6
  const containerWidth = source.clientWidth
  const color = cs.color

  const rawText = source.innerText
  if (!rawText.trim()) return

  const prepared = prepareWithSegments(rawText, font)
  // Verify renderable content without materializing all lines.
  if (!layoutNextLineRange(prepared, { segmentIndex: 0, graphemeIndex: 0 }, containerWidth)) return

  const originalStyles = {
    color: source.style.color,
    position: source.style.position,
    minHeight: source.style.minHeight,
  }

  source.style.color = 'transparent'
  source.style.position = 'relative'

  const stage = document.createElement('div')
  stage.style.cssText = `position:absolute;top:0;left:0;width:${containerWidth}px;pointer-events:none;z-index:9999`
  source.appendChild(stage)

  const marker = document.createElement('div')
  marker.style.cssText = 'position:absolute;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:7px solid black;display:none;pointer-events:none;z-index:10000'
  stage.appendChild(marker)

  let block: Block

  const wheelHandler = (e: WheelEvent) => {
    if (!block?.active) return
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    e.preventDefault()

    clearTimeout(block.scrollEndTimer)
    block.scrollEndTimer = window.setTimeout(() => { block.scrollSessionEnded = true }, 20)

    if (block.locked) {
      if (block.scrollSessionEnded) { block.locked = false; block.scrollSessionEnded = false }
      else return
    }

    block.targetOffset += e.deltaX
    if (block.targetOffset < 0) block.targetOffset = 0
    if (block.targetOffset > block.containerWidth) block.targetOffset = block.containerWidth

    // Backward: step back one line. layoutNextLineRange — width only, no string.
    if (e.deltaX < 0 && block.targetOffset <= 0 && block.displayLineIdx > 0) {
      block.displayLineIdx--
      const range = layoutNextLineRange(block.prepared, block.cursorHistory[block.displayLineIdx]!, block.containerWidth)
      if (range) {
        block.targetOffset = range.width
        block.pixelOffset = range.width
        block.focusLineRange = range // pre-cache for projectText
      }
      block.locked = true
      block.scrollSessionEnded = false
    }

    if (!block.animating) { block.animating = true; scheduleRender() }
  }

  const enterHandler = () => { if (block) block.active = true }
  const leaveHandler = () => { if (block) block.active = false }

  block = {
    source, stage, pool: [], marker, prepared,
    font, lineHeight, containerWidth, color,
    cursorHistory: [{ segmentIndex: 0, graphemeIndex: 0 }],
    displayLineIdx: 0,
    focusLineRange: null,
    pixelOffset: 0, targetOffset: 0,
    locked: false, scrollSessionEnded: false, scrollEndTimer: 0,
    animating: false, active: false,
    wheelHandler, enterHandler, leaveHandler, originalStyles,
  }

  blocks.push(block)
  projectText(block)

  source.addEventListener('pointerenter', enterHandler)
  source.addEventListener('pointerleave', leaveHandler)
  source.addEventListener('wheel', wheelHandler, { passive: false })
}

function projectText(b: Block): void {
  // layoutNextLineRange: width + cursors only, no string. Cached to avoid
  // computing it twice (advance check + marker position).
  if (!b.focusLineRange) {
    b.focusLineRange = layoutNextLineRange(b.prepared, b.cursorHistory[b.displayLineIdx]!, b.containerWidth)
  }

  // Advance when pixelOffset has consumed the whole focus line.
  if (b.focusLineRange && b.pixelOffset >= b.focusLineRange.width) {
    if (b.displayLineIdx + 1 >= b.cursorHistory.length) {
      b.cursorHistory.push(b.focusLineRange.end)
    }
    b.displayLineIdx++
    b.pixelOffset = 0
    b.targetOffset = 0
    b.locked = true
    b.scrollSessionEnded = false
    b.animating = false
    b.focusLineRange = layoutNextLineRange(b.prepared, b.cursorHistory[b.displayLineIdx]!, b.containerWidth)
  }

  const { lines, gapY, consumedWidth } = buildProjection(b)
  const lastLine = lines[lines.length - 1]
  const stageHeight = lastLine ? lastLine.y + b.lineHeight + 20 : 500
  b.stage.style.height = `${stageHeight}px`
  b.source.style.minHeight = `${stageHeight}px`

  syncPool(b.pool, lines.length, b.stage, () => {
    const el = document.createElement('span')
    el.style.cssText = `position:absolute;white-space:pre;font:${b.font};line-height:${b.lineHeight}px;color:${b.color}`
    return el
  })

  for (let i = 0; i < lines.length; i++) {
    const el = b.pool[i]!
    const line = lines[i]!
    el.textContent = line.text
    el.style.left = '0px'
    el.style.top = `${line.y}px`
  }

  if (b.pixelOffset > 0 && b.focusLineRange) {
    marker: {
      b.marker.style.left = `${b.focusLineRange.width - consumedWidth - 5}px`
      b.marker.style.top = `${gapY + b.lineHeight}px`
      b.marker.style.display = ''
    }
  } else {
    b.marker.style.display = 'none'
  }
}

function scheduleRender(): void {
  if (scheduledRaf !== null) return
  scheduledRaf = requestAnimationFrame(tick)
}

function tick(): void {
  scheduledRaf = null
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    if (!b.animating) continue
    if (b.locked) { b.animating = false; continue }
    b.pixelOffset = b.targetOffset
    projectText(b)
    b.animating = false
  }
}
