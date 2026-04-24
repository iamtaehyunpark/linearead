# Linearead Reader

A text-reading interface (Library) that minimizes cognitive load and ocular fatigue by eliminating the "Return Sweep" (the large eye movement required to travel from the end of one line to the start of the next). 

It utilizes a Horizontal-Vertical Hybrid Scroll mechanism to keep the user’s gaze fixed at a central "Focus Zone," and uses the `@chenglou/pretext` library for exact text measurement and layout calculation.

## Features

- **Sliding Focus:** Horizontal scrolling slides the current line out to the left while the next line slides in from the right on the same Y-axis. Eye position stays fixed.
- **Pretext Integration:** Zero-latency text layout measurements and rendering.
- **Dual-Axis Control:** Vertical for navigation, Horizontal for sliding-line logic.
- **Hinge Logic:** A snap/hinge effect at the end of each line to control pacing.
