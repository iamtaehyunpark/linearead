# Linearead Chrome Extension

A high-performance "Sliding Focus" text reader that eliminates the cognitive load of the "Return Sweep." Linearead keeps your gaze fixed at a stable eye level by reflowing text dynamically around a moving blank row (the Gap).

## Features

- **The One Gap Model**: A single blank row separates read text from unread text.
- **Dynamic Reflow**: Text moves upward into the buffer as you swipe horizontally, eliminating the need for your eyes to travel back to the left margin.
- **Smart Injection**: Works on any website (Wikipedia, news sites, blogs) by clicking the extension icon. No page refresh required after installation.
- **Status Indicator**: An "ON" badge appears on the extension icon when the reader is active in the current tab.
- **Strict Marker**: A small black triangle tracks your exact reading position.
- **Zero-Latency**: Built on [`@chenglou/pretext`](https://github.com/chenglou/pretext) for sub-pixel accurate layout without layout thrashing.

## Installation (Developer Mode)

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Build the extension:
   ```bash
   npm run build
   ```
3. Open Google Chrome and navigate to `chrome://extensions`.
4. Enable **Developer mode** (top right toggle).
5. Click **Load unpacked** and select the `dist` folder in the project directory.

## Usage

- **Toggle**: Click the Linearead extension icon in your browser bar to turn the reader on or off for the current page.
- **Reading**: Swipe horizontally (using your trackpad or mouse wheel) over any paragraph to slide the text.

## Standalone Demo

For local development and testing, you can run:
```bash
npm run dev
```
This will open the demo page (`index.html`) where Linearead is always initialized by default.
