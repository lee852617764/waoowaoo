import { execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import mysql from 'mysql2/promise'
import Redis from 'ioredis'
import { loadTestEnv } from './env'
import { runGlobalTeardown } from './global-teardown'

function parseDbUrl(dbUrl: string) {
  const url = new URL(dbUrl)
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  }
}

async function waitForMysql(maxAttempts = 180) {
  const db = parseDbUrl(process.env.DATABASE_URL || '')

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const conn = await mysql.createConnection({
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.database,
        connectTimeout: 5_000,
      })
      // Ping alone can succeed while the server is still finishing startup; this is closer to “ready for schema ops”.
      await conn.query('SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = ?', [db.database])
      await conn.end()
      return
    } catch {
      await sleep(1_000)
    }
  }

  throw new Error('MySQL test service did not become ready in time')
}

async function runPrismaDbPushWithRetry(maxAttempts = 12, delayMs = 2_000) {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      execSync('npx prisma db push --skip-generate --schema prisma/schema.prisma', {
        cwd: process.cwd(),
        stdio: 'inherit',
      })
      return
    } catch (err) {
      lastError = err
      if (attempt < maxAttempts) {
        await sleep(delayMs)
      }
    }
  }
  throw lastError
}

async function waitForRedis(maxAttempts = 60) {
  const redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || '6380'),
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  })

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (redis.status !== 'ready') {
          await redis.connect()
        }
        const pong = await redis.ping()
        if (pong === 'PONG') return
      } catch {
        await sleep(1_000)
      }
    }
  } finally {
    redis.disconnect()
  }

  throw new Error('Redis test service did not become ready in time')
}

export default async function globalSetup() {
  loadTestEnv()

  const shouldBootstrap = process.env.BILLING_TEST_BOOTSTRAP === '1' || process.env.SYSTEM_TEST_BOOTSTRAP === '1'
  if (!shouldBootstrap) {
    return async () => {}
  }

  execSync('docker compose -f docker-compose.test.yml down -v --remove-orphans', {
    cwd: process.cwd(),
    stdio: 'inherit',
  })

  try {
    execSync('docker compose -f docker-compose.test.yml up -d --remove-orphans --wait', {
      cwd: process.cwd(),
      stdio: 'inherit',
    })
  } catch {
    execSync('docker compose -f docker-compose.test.yml up -d --remove-orphans', {
      cwd: process.cwd(),
      stdio: 'inherit',
    })
  }

  await waitForMysql()
  await waitForRedis()

  await runPrismaDbPushWithRetry()

  return async () => {
    await runGlobalTeardown()
  }
}
