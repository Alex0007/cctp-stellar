import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// The Stellar SDK expects Buffer and a few Node globals in the browser.
export default defineConfig({
  plugins: [nodePolyfills()],
});
