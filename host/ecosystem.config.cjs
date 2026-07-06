module.exports = {
  apps: [
    {
      name: 'onami-host',
      script: './server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        ONAMI_HOST_BIND: process.env.ONAMI_HOST_BIND || '127.0.0.1',
        ONAMI_HOST_PORT: process.env.ONAMI_HOST_PORT || '41730',
        ONAMI_HOST_DATA_DIR: process.env.ONAMI_HOST_DATA_DIR || './data',
        ONAMI_HOST_CORS_ORIGIN: process.env.ONAMI_HOST_CORS_ORIGIN || '*',
      },
      max_restarts: 10,
      restart_delay: 2000,
      time: true,
    },
  ],
}
