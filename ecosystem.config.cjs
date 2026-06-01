module.exports = {
  apps: [
    {
      name: 'localflow-proxy',
      script: 'index.js',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      env_file: '.env.local',
    },
  ],
}
