import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../golf_hcp_tracker'

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let refreshing = false

  const dispatchUpdateAvailable = (registration: ServiceWorkerRegistration) => {
    const updateSW = async (reloadPage = true) => {
      if (!registration.waiting) {
        await registration.update()
      }
      if (registration.waiting) {
        if (reloadPage) {
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (refreshing) return
            refreshing = true
            window.location.reload()
          }, { once: true })
        }
        registration.waiting.postMessage({ type: 'SKIP_WAITING' })
      }
    }

    window.dispatchEvent(new CustomEvent('pwa:update-available', {
      detail: { updateSW },
    }))
  }

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js')

      if (registration.waiting && navigator.serviceWorker.controller) {
        dispatchUpdateAvailable(registration)
      }

      registration.addEventListener('updatefound', () => {
        const worker = registration.installing
        if (!worker) return

        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            dispatchUpdateAvailable(registration)
          }
        })
      })
    } catch (error) {
      console.error('Service worker registration failed', error)
    }
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
