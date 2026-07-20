// PM2 production process manager config for WPA Gateway API (Fastify).
// Env vars come from .env symlink (-> /srv/config/wpa/gateway-api.env).
//
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 logs wpa-gateway
//   pm2 reload wpa-gateway

module.exports = {
  apps: [
    {
      name: 'wpa-gateway',
      script: 'dist/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/wpa-gateway.out.log',
      error_file: './logs/wpa-gateway.error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
