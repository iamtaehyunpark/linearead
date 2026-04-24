// Linearead — sliding focus text engine.
//
// Model:
// - Focus line is being consumed from left to right (marker sweeps right-to-left)
// - Consumed text goes UP to the buffer area, stacking downward from row 0
// - Focus line re-fills at full width from the advanced cursor
//   → words from the next line naturally move UP into the focus line
// - Lines below focus re-flow (they lose starting words pulled up)
// - Gap row separates buffer from paragraph

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
  width: number
}

// ---------------------------------------------------------------------------
// syncPool — from editorial-engine
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
// Constants
// ---------------------------------------------------------------------------

const GAP_ROWS = 1  // empty gap between buffer and paragraph

// ---------------------------------------------------------------------------
// Build projection
// ---------------------------------------------------------------------------

function buildProjection(
  prepared: PreparedTextWithSegments,
  originalLines: LayoutLine[],
  containerWidth: number,
  lineHeight: number,
  pixelOffset: number,
  focusLineIdx: number,
  consumedLines: string[],
): PositionedLine[] {
  const lines: PositionedLine[] = []

  const origFocus = originalLines[focusLineIdx]
  if (!origFocus) return lines

  // --- Step 1: Compute displaced text (consumed portion of focus line) ---
  // Consumed text is laid out with width = pixelOffset, limited to the
  // original focus line's cursor range.
  const displacedLines: { text: string; width: number }[] = []
  let consumedCursor: LayoutCursor = origFocus.start

  if (pixelOffset > 1) {
    // Find how much text has been consumed (fits in pixelOffset width)
    const consumed = layoutNextLine(prepared, origFocus.start, pixelOffset)
    if (consumed !== null) {
      consumedCursor = consumed.end
      // Display consumed text in buffer at full width (one line)
      displacedLines.push({ text: consumed.text, width: consumed.width })
    }
  }

  // --- Step 2: Position ALL buffer lines (accumulated + in-progress) ---
  // Previously consumed lines first
  let bufferRow = 0
  for (let c = 0; c < consumedLines.length; c++) {
    lines.push({
      x: 0,
      y: Math.round(bufferRow * lineHeight),
      text: consumedLines[c]!,
      width: 0,
    })
    bufferRow++
  }
  // Current in-progress displaced text
  for (let d = 0; d < displacedLines.length; d++) {
    lines.push({
      x: 0,
      y: Math.round(bufferRow * lineHeight),
      text: displacedLines[d]!.text,
      width: displacedLines[d]!.width,
    })
    bufferRow++
  }

  // --- Step 3: Gap row + paragraph offset ---
  const bufferHeight = Math.max(1, bufferRow) * lineHeight
  const textY = bufferHeight + GAP_ROWS * lineHeight

  // --- Step 4: Focus line + below, re-laid from consumed cursor at full width ---
  let cursor: LayoutCursor = pixelOffset > 1 ? consumedCursor : origFocus.start
  let lineTop = textY
  const maxLines = originalLines.length - focusLineIdx + 5

  for (let i = 0; i < maxLines; i++) {
    const line = layoutNextLine(prepared, cursor, containerWidth)
    if (line === null) break

    lines.push({
      x: 0,
      y: Math.round(lineTop),
      text: line.text,
      width: line.width,
    })

    cursor = line.end
    lineTop += lineHeight
  }

  return { lines, textY } as any
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

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
  velocity: number
  focusLineIdx: number
  locked: boolean
  scrollSessionEnded: boolean
  scrollEndTimer: number
  animating: boolean
  active: boolean
}

const blocks: Block[] = []
let scheduledRaf: number | null = null
let lastTime = 0

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export async function init(selector: string = 'article p'): Promise<void> {
  await document.fonts.ready
  const targets = document.querySelectorAll<HTMLElement>(selector)
  for (let i = 0; i < targets.length; i++) {
    augment(targets[i]!)
  }
}

// ---------------------------------------------------------------------------
// Augment one element
// ---------------------------------------------------------------------------

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

  source.style.color = 'transparent'
  source.style.position = 'relative'

  // Stage — we'll set height dynamically
  const stage = document.createElement('div')
  stage.style.position = 'absolute'
  stage.style.top = '0'
  stage.style.left = '0'
  stage.style.width = `${containerWidth}px`
  stage.style.pointerEvents = 'none'
  source.appendChild(stage)

  const pool: HTMLSpanElement[] = []

  // Marker
  const marker = document.createElement('div')
  marker.style.position = 'absolute'
  marker.style.width = '2px'
  marker.style.height = `${lineHeight}px`
  marker.style.background = 'rgba(59,130,246,0.5)'
  marker.style.borderRadius = '1px'
  marker.style.display = 'none'
  marker.style.pointerEvents = 'none'
  stage.appendChild(marker)

  const block: Block = {
    source, stage, pool, marker, prepared,
    originalLines: result.lines,
    font, lineHeight, containerWidth, color,
    consumedLines: [],
    pixelOffset: 0,
    targetOffset: 0,
    velocity: 0,
    focusLineIdx: 0,
    locked: false,
    scrollSessionEnded: false,
    scrollEndTimer: 0,
    animating: false,
    active: false,
  }

  blocks.push(block)
  projectText(block)

  source.addEventListener('pointerenter', () => { block.active = true })
  source.addEventListener('pointerleave', () => { block.active = false })
  source.addEventListener('wheel', (e: WheelEvent) => {
    if (!block.active) return
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    e.preventDefault()

    // Detect scroll session: reset timer on every wheel event
    clearTimeout(block.scrollEndTimer)
    block.scrollEndTimer = window.setTimeout(() => {
      block.scrollSessionEnded = true
    }, 150)

    // Only block FORWARD scrolling while locked. Backward always allowed.
    const isForward = e.deltaX > 0
    if (block.locked && isForward) {
      if (block.scrollSessionEnded) {
        block.locked = false
        block.scrollSessionEnded = false
      } else {
        return  // still locked, ignore forward scroll
      }
    }

    block.targetOffset += e.deltaX * 1.0
    if (block.targetOffset < 0) block.targetOffset = 0
    const maxOff = block.containerWidth - 20
    if (block.targetOffset > maxOff) block.targetOffset = maxOff

    if (!block.animating) {
      block.animating = true
      scheduleRender()
    }
  }, { passive: false })
}

// ---------------------------------------------------------------------------
// Project text
// ---------------------------------------------------------------------------

function projectText(b: Block): void {
  // Snap: consumed the entire original focus line
  const origFocus = b.originalLines[b.focusLineIdx]
  if (origFocus && b.pixelOffset >= origFocus.width && b.focusLineIdx < b.originalLines.length - 1) {
    // Push completed line to buffer
    b.consumedLines.push(origFocus.text)
    b.pixelOffset = 0
    b.targetOffset = 0
    b.focusLineIdx++
    b.velocity = 0
    b.locked = true
    b.animating = false
    // Scroll page down by one lineHeight so focus line stays at the same eye level
    window.scrollBy(0, b.lineHeight)
  }

  const result = buildProjection(
    b.prepared, b.originalLines, b.containerWidth,
    b.lineHeight, b.pixelOffset, b.focusLineIdx,
    b.consumedLines,
  ) as unknown as { lines: PositionedLine[]; textY: number }

  const { lines, textY } = result

  // Update source padding to make room for buffer + gap
  b.source.style.paddingTop = `${textY}px`

  // Update stage height
  const lastLine = lines[lines.length - 1]
  const stageHeight = lastLine ? lastLine.y + b.lineHeight + 10 : textY + 100
  b.stage.style.height = `${stageHeight}px`

  // syncPool
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
    el.style.left = `${line.x}px`
    el.style.top = `${line.y}px`
  }

  // Marker on the focus line, sweeping from right to left
  if (b.pixelOffset > 0 && origFocus) {
    const focusY = textY
    b.marker.style.left = `${origFocus.width - b.pixelOffset}px`
    b.marker.style.top = `${focusY}px`
    b.marker.style.display = ''
  } else {
    b.marker.style.display = 'none'
  }
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function scheduleRender(): void {
  if (scheduledRaf !== null) return
  lastTime = performance.now()
  scheduledRaf = requestAnimationFrame(tick)
}

function tick(now: number): void {
  scheduledRaf = null
  const dt = Math.min((now - lastTime) / 1000, 0.05)
  lastTime = now
  let anyActive = false

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    if (!b.animating) continue

    if (b.locked) {
      b.velocity = 0
      b.animating = false
      continue
    }

    const diff = b.targetOffset - b.pixelOffset
    b.velocity += (diff * 20 - b.velocity * 5) * dt
    b.pixelOffset += b.velocity * dt
    if (b.pixelOffset < 0) b.pixelOffset = 0

    if (Math.abs(diff) < 0.5 && Math.abs(b.velocity) < 0.5) {
      b.pixelOffset = b.targetOffset
      b.velocity = 0
      b.animating = false
    } else {
      anyActive = true
    }

    projectText(b)
  }

  if (anyActive) {
    scheduledRaf = requestAnimationFrame(tick)
  }
}
