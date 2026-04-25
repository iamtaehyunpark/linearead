// Linearead — minimal "One Gap" text reader.

import {
  prepareWithSegments,
  layoutNextLine,
  layoutWithLines,
  type LayoutCursor,
  type PreparedTextWithSegments,
  type LayoutLine,
} from '@chenglou/pretext'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PositionedLine = {
  x: number
  y: number
  text: string
}

type Block = {
  source: HTMLElement
  stage: HTMLDivElement
  pool: HTMLSpanElement[]
  marker: HTMLDivElement
  prepared: PreparedTextWithSegments
  originalLines: LayoutLine[]
  font: string
  lineHeight: number
  containerWidth: number
  color: string
  consumedLines: string[]

  pixelOffset: number
  targetOffset: number
  focusLineIdx: number
  locked: boolean
  scrollSessionEnded: boolean
  scrollEndTimer: number
  animating: boolean
  active: boolean

  // Cleanup references
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
    const element = create()
    parent.appendChild(element)
    pool.push(element)
  }
  for (let index = 0; index < pool.length; index++) {
    pool[index]!.style.display = index < count ? '' : 'none'
  }
}

// ---------------------------------------------------------------------------
// Build projection
// ---------------------------------------------------------------------------

function buildProjection(b: Block): { lines: PositionedLine[]; gapY: number; consumedWidth: number } {
  const lines: PositionedLine[] = []
  let currentRow = 0
  let consumedWidth = 0

  for (const text of b.consumedLines) {
    lines.push({ x: 0, y: Math.round(currentRow * b.lineHeight), text })
    currentRow++
  }

  const origFocus = b.originalLines[b.focusLineIdx]
  if (!origFocus) return { lines, gapY: currentRow * b.lineHeight, consumedWidth: 0 }

  let consumedCursor: LayoutCursor = origFocus.start
  if (b.pixelOffset > 0) {
    const consumed = layoutNextLine(b.prepared, origFocus.start, b.pixelOffset)
    if (consumed) {
      lines.push({ x: 0, y: Math.round(currentRow * b.lineHeight), text: consumed.text })
      consumedCursor = consumed.end
      consumedWidth = consumed.width
      currentRow++
    }
  }

  const gapY = currentRow * b.lineHeight
  currentRow++

  let cursor = consumedCursor
  while (cursor.segmentIndex < b.prepared.segments.length) {
    const line = layoutNextLine(b.prepared, cursor, b.containerWidth)
    if (!line) break
    lines.push({ x: 0, y: Math.round(currentRow * b.lineHeight), text: line.text })
    cursor = line.end
    currentRow++
  }

  return { lines, gapY, consumedWidth }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function init(selector: string = 'article p'): Promise<void> {
  if (blocks.length > 0) return // Already active
  await document.fonts.ready
  const targets = document.querySelectorAll<HTMLElement>(selector)
  for (let i = 0; i < targets.length; i++) {
    augment(targets[i]!)
  }
}

export function destroy(): void {
  while (blocks.length > 0) {
    const b = blocks.pop()!
    // Restore styles
    b.source.style.color = b.originalStyles.color
    b.source.style.position = b.originalStyles.position
    b.source.style.minHeight = b.originalStyles.minHeight
    // Remove listeners
    b.source.removeEventListener('wheel', b.wheelHandler)
    b.source.removeEventListener('pointerenter', b.enterHandler)
    b.source.removeEventListener('pointerleave', b.leaveHandler)
    // Remove stage
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
  const result = layoutWithLines(prepared, containerWidth, lineHeight)
  if (result.lines.length === 0) return

  const originalStyles = {
    color: source.style.color,
    position: source.style.position,
    minHeight: source.style.minHeight
  }

  source.style.color = 'transparent'
  source.style.position = 'relative'

  const stage = document.createElement('div')
  stage.style.position = 'absolute'
  stage.style.top = '0'
  stage.style.left = '0'
  stage.style.width = `${containerWidth}px`
  stage.style.pointerEvents = 'none'
  stage.style.zIndex = '9999'
  source.appendChild(stage)

  const marker = document.createElement('div')
  marker.style.position = 'absolute'
  marker.style.width = '0'
  marker.style.height = '0'
  marker.style.borderLeft = '4px solid transparent'
  marker.style.borderRight = '4px solid transparent'
  marker.style.borderTop = '7px solid black'
  marker.style.display = 'none'
  marker.style.pointerEvents = 'none'
  marker.style.zIndex = '10000'
  stage.appendChild(marker)

  let block: Block

  const wheelHandler = (e: WheelEvent) => {
    if (!block || !block.active) return
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    e.preventDefault()

    clearTimeout(block.scrollEndTimer)
    block.scrollEndTimer = window.setTimeout(() => {
      block.scrollSessionEnded = true
    }, 20)

    if (block.locked) {
      if (block.scrollSessionEnded) {
        block.locked = false
        block.scrollSessionEnded = false
      } else {
        return
      }
    }

    block.targetOffset += e.deltaX
    if (block.targetOffset < 0) block.targetOffset = 0
    if (block.targetOffset > block.containerWidth) block.targetOffset = block.containerWidth

    if (e.deltaX < 0 && block.targetOffset <= 0 && block.focusLineIdx > 0) {
      block.consumedLines.pop()
      block.focusLineIdx--
      const prevLine = block.originalLines[block.focusLineIdx]!
      block.targetOffset = prevLine.width
      block.pixelOffset = prevLine.width
      block.locked = true
      block.scrollSessionEnded = false
    }

    if (!block.animating) {
      block.animating = true
      scheduleRender()
    }
  }

  const enterHandler = () => { if (block) block.active = true }
  const leaveHandler = () => { if (block) block.active = false }

  block = {
    source, stage, pool: [], marker, prepared,
    originalLines: result.lines,
    font, lineHeight, containerWidth, color,
    consumedLines: [],
    pixelOffset: 0,
    targetOffset: 0,
    focusLineIdx: 0,
    locked: false,
    scrollSessionEnded: false,
    scrollEndTimer: 0,
    animating: false,
    active: false,
    wheelHandler, enterHandler, leaveHandler, originalStyles
  }

  blocks.push(block)
  projectText(block)

  source.addEventListener('pointerenter', enterHandler)
  source.addEventListener('pointerleave', leaveHandler)
  source.addEventListener('wheel', wheelHandler, { passive: false })
}

function projectText(b: Block): void {
  const origFocus = b.originalLines[b.focusLineIdx]
  if (origFocus && b.pixelOffset >= origFocus.width && b.focusLineIdx < b.originalLines.length - 1) {
    b.consumedLines.push(origFocus.text)
    b.pixelOffset = 0
    b.targetOffset = 0
    b.focusLineIdx++
    b.locked = true
    b.scrollSessionEnded = false
    b.animating = false
  }

  const { lines, gapY, consumedWidth } = buildProjection(b)
  const lastLine = lines[lines.length - 1]
  const stageHeight = lastLine ? lastLine.y + b.lineHeight + 20 : 500
  b.stage.style.height = `${stageHeight}px`
  b.source.style.minHeight = `${stageHeight}px`

  syncPool(b.pool, lines.length, b.stage, () => {
    const el = document.createElement('span')
    el.style.position = 'absolute'
    el.style.whiteSpace = 'pre'
    el.style.font = b.font
    el.style.lineHeight = `${b.lineHeight}px`
    el.style.color = b.color
    return el
  })

  for (let i = 0; i < lines.length; i++) {
    const el = b.pool[i]!
    const line = lines[i]!
    el.textContent = line.text
    el.style.left = `0px`
    el.style.top = `${line.y}px`
  }

  if (b.pixelOffset > 0 && origFocus) {
    b.marker.style.left = `${origFocus.width - consumedWidth - 5}px`
    b.marker.style.top = `${gapY + b.lineHeight}px`
    b.marker.style.display = ''
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
    if (b.locked) {
      b.animating = false
      continue
    }
    b.pixelOffset = b.targetOffset
    projectText(b)
    b.animating = false
  }
}
