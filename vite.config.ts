import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  build: {
    target: ['es2019', 'safari13'],
  },
  plugins: [react()],
})
