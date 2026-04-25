import { init, destroy } from './linearead'

let isCurrentlyActive = false

const selectors = [
  '.mw-parser-output p',
  'article p',
  'main p',
  '[role="main"] p',
  '.content p',
  '.post-content p',
  '.article-body p',
  '#content p',
  'section p'
].join(', ')

const isExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id

if (isExtension) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'toggle') {
      isCurrentlyActive = !isCurrentlyActive
      if (isCurrentlyActive) {
        init(selectors)
      } else {
        destroy()
      }
      sendResponse({ state: isCurrentlyActive })
    }
    return true
  })
} else {
  init('article p')
}
