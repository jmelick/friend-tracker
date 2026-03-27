import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/friend-tracker/',  // ← Change this to match your GitHub repo name
})
