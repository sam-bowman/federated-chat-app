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
  server: {
    // Tauri needs a fixed, predictable dev port to point its WebView at
    // (see src-tauri/tauri.conf.json's devUrl) - strictPort means it fails
    // loudly instead of silently shifting to another port if 5173 is
    // taken. The federation demo's second client instance overrides this
    // via its own `--port 5174` CLI flag (which always wins over this
    // config value), so this doesn't conflict with that - and strictPort
    // is a genuine improvement there too, since a silent port shift would
    // otherwise break that script's own hardcoded printed URLs.
    port: 5173,
    strictPort: true,
  },
  // So Tauri's own `cargo`/Rust compiler output in the terminal isn't
  // cleared away by Vite's dev-server banner on every file change.
  clearScreen: false,
}))
