# Architecture Opinion: Linearead's Use of Pretext

## Executive Summary

The current linearead implementation works, but it **fundamentally misaligns with Pretext's design philosophy**. Rather than treating Pretext as a sophisticated **streaming cursor-based layout engine**, the code treats it as a simple "measure all lines upfront" library. This creates unnecessary architectural complexity, memory overhead, and animation friction.

**The verdict:** Linearead is fighting against Pretext instead of flowing with it.

---

## The Core Misalignment

### What Pretext Is Actually Designed For

Pretext is built around a **cursor-based streaming model** for exactly the use case linearead implements:

```typescript
// Pretext's intended pattern (from README)
let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }
while (true) {
  const range = layoutNextLineRange(prepared, cursor, width)
  if (range === null) break
  // Process one line at a time
  cursor = range.end
}
```

This design allows:
- **Lazy materialization** — only build line text when rendering
- **Dynamic width changes** — each line can have different container widths
- **Streaming rendering** — process lines as you need them
- **Minimal allocations** — no massive intermediate arrays

### What Linearead Actually Does

```typescript
// Current linearead pattern
const result = layoutWithLines(prepared, containerWidth, lineHeight)
// ↑ Materializes ALL lines into an array upfront
// ↑ Creates full text strings for every single line
// ↑ Allocates consumedLines, originalLines, pool arrays in parallel
```

Then it reimplements cursor tracking manually:
- `consumedLines` — what Pretext's cursor already tracks
- `focusLineIdx` — what Pretext's cursor index already is
- `pixelOffset` / `targetOffset` — animation state that doesn't belong in layout

**Result:** Linearead maintains three parallel tracking systems (Pretext's cursor, linearead's state, animation state) when one would suffice.

---

## Specific Problems

### 1. **Memory Overhead**

Current approach allocates:
```typescript
originalLines: LayoutLine[]           // All line strings materialized
consumedLines: string[]               // Duplicates of what's been consumed
pool: HTMLSpanElement[]               // DOM elements
marker: HTMLDivElement                // Marker element
stage: HTMLDivElement                 // Stage container
```

For a 1000-line article, this means:
- Pretext internally holds segment data
- `layoutWithLines()` materializes 1000 `LayoutLine` objects with full text strings
- Linearead separately tracks which lines are "consumed"
- All 1000 DOM spans exist simultaneously

**With streaming cursors**, you'd only hold:
- Current line being displayed
- Next line being precomputed
- Minimal DOM nodes (actual visible text + next prefetch)

### 2. **Animation Logic is Tangled in Layout**

The `tick()` function does layout + animation together:

```typescript
function tick(): void {
  // ...
  b.pixelOffset = b.targetOffset
  projectText(b)  // ← This recalculates layout
  b.animating = false
}
```

But `pixelOffset` and `targetOffset` are **animation concerns**, not layout concerns. Pretext doesn't care about animation states. By mixing them, linearead:
- Recalculates layout every frame (expensive)
- Couples animation to layout recalculation
- Makes the state machine harder to reason about

**Better separation:** Layout (Pretext cursors) and animation (easing/timing) should be orthogonal.

### 3. **Manual Scroll Offset Arithmetic**

```typescript
if (b.pixelOffset > 0) {
  const consumed = layoutNextLine(b.prepared, origFocus.start, b.pixelOffset)
  if (consumed) {
    lines.push({ x: 0, y: Math.round(currentRow * b.lineHeight), text: consumed.text })
    consumedCursor = consumed.end
    consumedWidth = consumed.width
    // ...
  }
}
```

This is recreating what Pretext's cursor system already does. The code manually steps through the text measuring pixel offsets, when **Pretext's cursor IS designed for exactly this**.

### 4. **Redundant State Management**

Three systems track "where are we in the text":

| System | Tracks |
|--------|--------|
| **Pretext cursor** | `{ segmentIndex, graphemeIndex }` |
| **Linearead blocks** | `focusLineIdx`, `pixelOffset` |
| **Linearead rendering** | `consumedLines`, `targetOffset` |

When scrolling, all three need to stay in sync:

```typescript
if (e.deltaX < 0 && block.targetOffset <= 0 && block.focusLineIdx > 0) {
  block.consumedLines.pop()        // ← Manual tracking
  block.focusLineIdx--             // ← Manual tracking
  block.targetOffset = prevLine.width  // ← Manual state
  block.pixelOffset = prevLine.width   // ← Manual state
}
```

This is the classic "multiple sources of truth" anti-pattern. With a single cursor-based model, **one update propagates everywhere**.

---

## How It Should Be Structured

### Proposed Cursor-Based Architecture

```typescript
type Block = {
  prepared: PreparedTextWithSegments
  containerWidth: number
  lineHeight: number
  
  // Single source of truth: current position in text
  displayCursor: LayoutCursor
  
  // Animation only
  targetPixelOffset: number
  currentPixelOffset: number
  animating: boolean
}

function projectText(b: Block): void {
  // Render from displayCursor onward
  let cursor = { ...b.displayCursor }
  const lines: PositionedLine[] = []
  let y = 0
  
  // Account for partial line offset
  if (b.currentPixelOffset > 0) {
    const partial = layoutNextLine(b.prepared, cursor, b.currentPixelOffset)
    if (partial) {
      lines.push({ x: 0, y, text: partial.text })
      cursor = partial.end
      y += b.lineHeight
    }
  }
  
  // Stream remaining lines
  while (cursor.segmentIndex < b.prepared.segments.length) {
    const line = layoutNextLine(b.prepared, cursor, b.containerWidth)
    if (!line) break
    lines.push({ x: 0, y, text: line.text })
    cursor = line.end
    y += b.lineHeight
  }
  
  // Render lines to DOM (unchanged)
  syncPool(b.pool, lines.length, b.stage, ...)
  // ...
}

function wheelHandler(e: WheelEvent): void {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
  e.preventDefault()
  
  block.targetPixelOffset += e.deltaX
  
  // Update display cursor based on accumulated offset
  let cursor = b.displayCursor
  let accumulated = 0
  
  while (accumulated + b.currentPixelOffset < b.targetPixelOffset && 
         cursor.segmentIndex < b.prepared.segments.length) {
    const line = layoutNextLine(b.prepared, cursor, b.containerWidth)
    if (!line) break
    accumulated += line.width
    cursor = line.end
  }
  
  b.displayCursor = cursor
  b.currentPixelOffset = b.targetPixelOffset - accumulated
}
```

**Benefits:**
- `displayCursor` is the single source of truth
- Animation logic (`targetPixelOffset`, `currentPixelOffset`) is separate
- Layout queries use Pretext's native cursor API
- No parallel state tracking
- DOM rendering is completely decoupled

---

## Why This Matters

### Performance

**Current approach** (worst case for long articles):
- Allocate ~3KB per line (LayoutLine object + text string)
- 1000 lines = 3MB in memory just for line data
- Every wheel event triggers full `projectText()` recalculation
- Materializing line text repeatedly for non-visible lines

**Proposed approach**:
- Only materialize visible lines (~5-10 lines at a time)
- Cursor arithmetic is ~0.0002ms (Pretext's own measurement)
- Single cursor update per scroll event
- Memory footprint dominated by DOM nodes (proportional to visible lines)

### Maintainability

**Current approach:**
- 3+ places where scroll position is tracked
- Animation logic mixed with layout logic
- Mental model requires understanding offset vs. line index vs. accumulated width vs. animation state

**Proposed approach:**
- Animation and layout are orthogonal concerns
- One cursor represents position
- State machine is simple: "where in the text" vs. "how fast are we moving there"

### Pretext Alignment

**Current approach:**
- Ignores 80% of Pretext's API
- Uses only high-level `layoutWithLines()` (which is marked "not for hot path")
- Duplicates cursor arithmetic that Pretext already does

**Proposed approach:**
- Leverages Pretext's core design (streaming cursors)
- Uses low-level APIs intended for this exact pattern
- Pretext's architecture becomes an asset rather than a constraint

---

## The Broader Lesson

This is a common pattern: **importing a well-designed library and then reimplementing its core abstraction**.

Pretext solves text layout as a **stateful traversal problem** (cursors). Linearead treats it as a **stateless batch problem** (all-at-once materialization) and then rebuilds state management manually.

The disconnect happens when developers think:
- "I need to render lines" → use `layoutWithLines()` ✗
- "I need to stream lines one at a time" → use `layoutNextLine()` with cursors ✓

Linearead is doing the former when the latter is more natural.

---

## Recommendations

### Short Term
- Profile memory usage and scroll performance on long articles
- If performance is acceptable, this is lower priority
- Document why `layoutWithLines()` is used over cursors

### Medium Term
- Refactor state management: consolidate into a single cursor
- Separate animation logic from layout logic
- Remove `consumedLines` and `focusLineIdx` redundancy

### Long Term
- Consider whether this "one gap reader" pattern generalizes
- Could it become a Pretext-native demo or helper?
- Would a `useLinearead()` hook abstraction be useful for other projects?

---

## Conclusion

Linearead is a creative proof-of-concept that demonstrates Pretext's capabilities. But the current implementation **works despite its architecture, not because of it**. By aligning more closely with Pretext's cursor-based model, the code would become:

- **Simpler** — fewer state variables
- **Faster** — less memory, less computation per frame
- **Clearer** — animation and layout concerns separated
- **More maintainable** — closer to how Pretext is designed to be used

The library isn't the problem. **The gap is between what linearead is doing and what Pretext is built to support.**
