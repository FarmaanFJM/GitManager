// Test service. Usage: node service.cjs <port|0> [--child <port>] [--delay ms] [--ignore-term] [--fail code]
const http = require('node:http')
const { spawn } = require('node:child_process')
const args = process.argv.slice(2)
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
if (opt('--fail')) { console.error('boom: something went wrong'); process.exit(Number(opt('--fail'))) }
const port = Number(args[0])
const delay = Number(opt('--delay') ?? 0)
if (args.includes('--ignore-term')) process.on('SIGTERM', () => console.log('ignoring SIGTERM'))
else process.on('SIGTERM', () => { console.log('graceful shutdown'); process.exit(0) })
if (opt('--child')) {
  const c = spawn(process.execPath, [__filename, opt('--child')], { stdio: ['ignore', 'inherit', 'inherit'] })
  console.log(`child pid ${c.pid}`)
}
console.log(`\x1b[32mstarting\x1b[0m pid ${process.pid}`)
setTimeout(() => {
  if (port) http.createServer((q, s) => s.end('ok')).listen(port, '127.0.0.1', () => console.log(`listening on ${port}`))
  else setInterval(() => {}, 1000)
}, delay)
