import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // The federation demo runs two dev server instances (--mode a / --mode b)
  // from this same client/ directory at once. They'd otherwise share one
  // dep-optimization cache, and each instance invalidating it as it starts
  // causes "504 Outdated Optimize Dep" errors in the other.
  cacheDir: mode === 'a' || mode === 'b' ? `node_modules/.vite-${mode}` : 'node_modules/.vite',
}))
