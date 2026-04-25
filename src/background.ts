// Background script for Linearead extension

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return

  chrome.tabs.sendMessage(tab.id, { action: 'toggle' }, (response) => {
    if (chrome.runtime.lastError) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        files: ['content.js']
      }).then(() => {
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id!, { action: 'toggle' }, (resp) => {
            if (resp && resp.state !== undefined) {
              chrome.action.setBadgeText({ text: resp.state ? 'ON' : '', tabId: tab.id })
            }
          })
        }, 100)
      }).catch(() => {})
      return
    }
    
    if (response && response.state !== undefined) {
      chrome.action.setBadgeText({
        text: response.state ? 'ON' : '',
        tabId: tab.id
      })
    }
  })
})
