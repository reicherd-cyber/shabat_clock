import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist' },
  server: {
    proxy: { '/api': 'http://localhost:3001' },
    // src/ivrCode.js re-exports the server's services/ivrCode.js, outside this package.
    fs: { allow: ['..', '../..'] },
  },
});
