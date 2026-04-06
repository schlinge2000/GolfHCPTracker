import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../golf_hcp_tracker'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
