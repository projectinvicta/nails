import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chai, describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { default as chaiHttp, request } from 'chai-http';
import Nails from '../lib/Nails.ts';

chai.use(chaiHttp);

const makeHealthzRequest = (app) => {
  return new Promise((resolve, reject) => {
    request.execute(app)
      .get('/healthz')
      .end((err, res) => {
        if (err && !res) return reject(err);
        resolve(res);
      });
  });
};

const createBaseConfig = (runtime = {}, port = 3456) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nails-healthz-app-'));
  const controllersDir = path.join(tmpRoot, 'controllers');
  const modelsDir = path.join(tmpRoot, 'models');
  const viewsDir = path.join(tmpRoot, 'views');
  const publicDir = path.join(tmpRoot, 'public');
  fs.mkdirSync(controllersDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.mkdirSync(viewsDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });

  return {
    tmpRoot,
    config: {
      service: {
        APP_ROOT: tmpRoot,
        PUBLIC_ROOT: publicDir,
        CONTROLLERS_ROOT: controllersDir,
        VIEWS_ROOT: viewsDir,
        MODELS_ROOT: modelsDir,
        SERVER_ROOT: tmpRoot,
        ENABLE_HTTP: true,
        HOST: '127.0.0.1',
        PORT: port,
        ENABLE_HTTPS: false,
        SSL_PORT: 0,
        PRIVATE_KEY: Buffer.alloc(0),
        CERTIFICATE: Buffer.alloc(0),
      },
      routes: [
        ['get', '/:catchall', { controller: 'home' }],
      ],
      mimes: {},
      db: {
        address: 'sqlite:///:memory:',
        options: { logging: false },
      },
      runtime,
    },
  };
};

const waitForCondition = async (predicate, timeoutMs = 2000, intervalMs = 25) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
};

describe('RuntimeConfig, WATCH_FILE, and /healthz', () => {
  let activeNails = null;
  let cleanupDirs = [];
  let nextPort = 34560;

  beforeEach(() => {
    activeNails = null;
    cleanupDirs = [];
  });

  afterEach(async () => {
    if (activeNails) {
      await activeNails.server.stop();
      if (activeNails.sequelize) {
        await activeNails.sequelize.close();
      }
    }
    for (const dir of cleanupDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 200 OK (minimal plain text) on /healthz when healthy and not in lame duck mode (even with catchall route and HTML view)', async () => {
    const { tmpRoot, config } = createBaseConfig({}, nextPort++);
    cleanupDirs.push(tmpRoot);

    // Add a real HomeController + EJS view to ensure /healthz never renders HTML
    fs.mkdirSync(path.join(tmpRoot, 'views', 'home'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'views', 'home', 'index.ejs'), '<html><body>Home Page</body></html>');
    const controllerPath = path.resolve(import.meta.dirname, '../lib/Controller.ts');
    fs.writeFileSync(
      path.join(tmpRoot, 'controllers', 'home_controller.js'),
      `import Controller from ${JSON.stringify(controllerPath)};\nexport default class HomeController extends Controller { index() { return {}; } }\n`
    );

    activeNails = new Nails(config);
    await activeNails.startServer();

    const res = await makeHealthzRequest(activeNails.application);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toBe('OK');
  });

  it('returns 503 on /healthz when static runtime.lameDuckMode is true', async () => {
    const { tmpRoot, config } = createBaseConfig({ lameDuckMode: true }, nextPort++);
    cleanupDirs.push(tmpRoot);

    activeNails = new Nails(config);
    await activeNails.startServer();

    expect(activeNails.lameDuckMode).toBe(true);
    const res = await makeHealthzRequest(activeNails.application);
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toBe('Service Unavailable');
  });

  it('rewrites an existing WATCH_FILE with defaults on startServer()', async () => {
    const { tmpRoot, config } = createBaseConfig({}, nextPort++);
    cleanupDirs.push(tmpRoot);

    const watchFile = path.join(tmpRoot, 'runtime.json');
    fs.writeFileSync(watchFile, JSON.stringify({ lameDuckMode: true, staleKey: 'old' }));
    config.runtime = { WATCH_FILE: watchFile, WATCH_FILE_DELAY: 50 };

    activeNails = new Nails(config);
    await activeNails.startServer();

    expect(JSON.parse(fs.readFileSync(watchFile, 'utf-8'))).toEqual({ lameDuckMode: false });
    expect(activeNails.lameDuckMode).toBe(false);
    expect(activeNails.config.runtime.lameDuckMode).toBe(false);

    const res = await makeHealthzRequest(activeNails.application);
    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
  });

  it('rewrites WATCH_FILE with configured default lameDuckMode on startServer()', async () => {
    const { tmpRoot, config } = createBaseConfig({}, nextPort++);
    cleanupDirs.push(tmpRoot);

    const watchFile = path.join(tmpRoot, 'runtime.json');
    fs.writeFileSync(watchFile, JSON.stringify({ lameDuckMode: false }));
    config.runtime = { WATCH_FILE: watchFile, WATCH_FILE_DELAY: 50, lameDuckMode: true };

    activeNails = new Nails(config);
    await activeNails.startServer();

    expect(JSON.parse(fs.readFileSync(watchFile, 'utf-8'))).toEqual({ lameDuckMode: true });
    expect(activeNails.lameDuckMode).toBe(true);

    const res = await makeHealthzRequest(activeNails.application);
    expect(res.status).toBe(503);
    expect(res.text).toBe('Service Unavailable');
  });

  it('dynamically updates lameDuckMode and /healthz when WATCH_FILE changes', async () => {
    const { tmpRoot, config } = createBaseConfig({}, nextPort++);
    cleanupDirs.push(tmpRoot);

    const watchFile = path.join(tmpRoot, 'runtime.json');
    fs.writeFileSync(watchFile, JSON.stringify({ lameDuckMode: false }));
    config.runtime = { WATCH_FILE: watchFile, WATCH_FILE_DELAY: 50 };

    activeNails = new Nails(config);
    await activeNails.startServer();

    let res = await makeHealthzRequest(activeNails.application);
    expect(res.status).toBe(200);

    // Wait briefly so fs.watchFile's initial stat completes before modifying
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(watchFile, JSON.stringify({ lameDuckMode: true }));

    await waitForCondition(() => activeNails.lameDuckMode === true);
    res = await makeHealthzRequest(activeNails.application);
    expect(res.status).toBe(503);

    // Toggle back to false
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(watchFile, JSON.stringify({ lameDuckMode: false }));

    await waitForCondition(() => activeNails.lameDuckMode === false);
    res = await makeHealthzRequest(activeNails.application);
    expect(res.status).toBe(200);
  });

  it('creates WATCH_FILE with defaults if specified but missing, and reacts to updates and deletion', async () => {
    const { tmpRoot, config } = createBaseConfig({}, nextPort++);
    cleanupDirs.push(tmpRoot);

    const watchFile = path.join(tmpRoot, 'nested', 'does-not-exist-yet.json');
    config.runtime = { WATCH_FILE: watchFile, WATCH_FILE_DELAY: 50 };

    activeNails = new Nails(config);
    await activeNails.startServer();

    expect(fs.existsSync(watchFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(watchFile, 'utf-8'))).toEqual({ lameDuckMode: false });

    let res = await makeHealthzRequest(activeNails.application);
    expect(res.status).toBe(200);

    // Update the created file with lameDuckMode: true
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(watchFile, JSON.stringify({ lameDuckMode: true }));

    await waitForCondition(() => activeNails.lameDuckMode === true);
    res = await makeHealthzRequest(activeNails.application);
    expect(res.status).toBe(503);

    // Delete the file -> returns to initial lameDuckMode (false)
    await new Promise((r) => setTimeout(r, 100));
    fs.unlinkSync(watchFile);

    await waitForCondition(() => activeNails.lameDuckMode === false);
    res = await makeHealthzRequest(activeNails.application);
    expect(res.status).toBe(200);
  });

  it('preserves current lameDuckMode and does not crash on invalid JSON in WATCH_FILE', async () => {
    const { tmpRoot, config } = createBaseConfig({}, nextPort++);
    cleanupDirs.push(tmpRoot);

    const watchFile = path.join(tmpRoot, 'runtime.json');
    config.runtime = { WATCH_FILE: watchFile, WATCH_FILE_DELAY: 50 };

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      activeNails = new Nails(config);
      await activeNails.startServer();

      fs.writeFileSync(watchFile, JSON.stringify({ lameDuckMode: true }));
      activeNails.server.evaluateWatchFile();
      expect(activeNails.lameDuckMode).toBe(true);

      fs.writeFileSync(watchFile, '{ invalid json');
      activeNails.server.evaluateWatchFile();

      expect(activeNails.lameDuckMode).toBe(true);
      const res = await makeHealthzRequest(activeNails.application);
      expect(res.status).toBe(503);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns 503 on /healthz when service is marked unhealthy', async () => {
    const { tmpRoot, config } = createBaseConfig({}, nextPort++);
    cleanupDirs.push(tmpRoot);

    activeNails = new Nails(config);
    await activeNails.startServer();

    activeNails.healthy = false;
    const res = await makeHealthzRequest(activeNails.application);
    expect(res.status).toBe(503);
    expect(res.text).toBe('Service Unavailable');

    activeNails.healthy = true;
    const res2 = await makeHealthzRequest(activeNails.application);
    expect(res2.status).toBe(200);
    expect(res2.text).toBe('OK');
  });

  it('returns 503 on /healthz when database health check fails', async () => {
    const { tmpRoot, config } = createBaseConfig({}, nextPort++);
    cleanupDirs.push(tmpRoot);

    activeNails = new Nails(config);
    await activeNails.startServer();

    const authSpy = vi.spyOn(activeNails.sequelize, 'authenticate')
      .mockRejectedValueOnce(new Error('DB connection lost'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await makeHealthzRequest(activeNails.application);
      expect(res.status).toBe(503);
      expect(res.text).toBe('Service Unavailable');
    } finally {
      authSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const resHealthy = await makeHealthzRequest(activeNails.application);
    expect(resHealthy.status).toBe(200);
    expect(resHealthy.text).toBe('OK');
  });

  it('returns 503 on /healthz before initialization completes', async () => {
    const { tmpRoot, config } = createBaseConfig({}, nextPort++);
    cleanupDirs.push(tmpRoot);

    let releaseInit;
    const gate = new Promise((resolve) => {
      releaseInit = resolve;
    });

    const originalInitControllers = Nails.prototype.initializeControllers;
    const initControllersSpy = vi.spyOn(Nails.prototype, 'initializeControllers').mockImplementation(async function (...args) {
      await gate;
      return originalInitControllers.apply(this, args);
    });

    try {
      activeNails = new Nails(config);
      await activeNails.server.start(activeNails.router);

      // While configure() is blocked on gate, /healthz must return 503
      const earlyRes = await makeHealthzRequest(activeNails.application);
      expect(earlyRes.status).toBe(503);
      expect(earlyRes.text).toBe('Service Unavailable');

      releaseInit();
      await activeNails.initialized;

      const readyRes = await makeHealthzRequest(activeNails.application);
      expect(readyRes.status).toBe(200);
      expect(readyRes.text).toBe('OK');
    } finally {
      initControllersSpy.mockRestore();
    }
  });

  it('gives EVALUATE_HEALTHZ_ROUTE precedence over controller routes defining /healthz', async () => {
    const { tmpRoot, config } = createBaseConfig({}, nextPort++);
    cleanupDirs.push(tmpRoot);

    const controllerPath = path.resolve(import.meta.dirname, '../lib/Controller.ts');
    fs.writeFileSync(
      path.join(tmpRoot, 'controllers', 'override_controller.js'),
      `import Controller from ${JSON.stringify(controllerPath)};\nexport default class OverrideController extends Controller {\n  routes = [['get', '/healthz', { action: 'healthz' }]];\n  healthz(_params, _req, res) { res.status(200).type('text/html').send('<html>Override</html>'); }\n}\n`
    );

    activeNails = new Nails(config);
    await activeNails.startServer();

    const res = await makeHealthzRequest(activeNails.application);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toBe('OK');
  });
});
