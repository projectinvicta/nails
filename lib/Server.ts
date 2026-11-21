import fs from 'node:fs';
import https, { type Server as HttpsServer } from 'node:https';
import { type Server as HttpServer } from 'node:http';

import { type Request, type Response } from 'express';
import { type Application } from 'express-ws';
import expressApp from './application.js';
import type Router from './Router.js';
import { type Config, type RuntimeConfig } from './types.js';

const DEFAULT_WATCH_FILE_DELAY = 5000;

export type HealthCheckFn = () => boolean | Promise<boolean>;

export default class Server {
  private static activeServerByApp = new WeakMap<Application, Server>();

  public config: Config;
  public application: Application;
  public httpServer?: HttpServer;
  public httpsServer?: HttpsServer;
  public healthy: boolean = true;
  public isInitialized: boolean = false;

  private healthCheck?: HealthCheckFn;
  private initialLameDuckMode: boolean = false;
  private watchedFilePath?: string;
  private watchFileListener?: (curr: fs.Stats, prev: fs.Stats) => void;

  get lameDuckMode(): boolean {
    return Boolean(this.config.runtime?.lameDuckMode);
  }

  set lameDuckMode(value: boolean) {
    if (!this.config.runtime) {
      this.config.runtime = {};
    }
    this.config.runtime.lameDuckMode = value;
  }

  constructor(
    config: Config,
    application: Application = expressApp,
    healthCheck?: HealthCheckFn
  ) {
    this.config = config;
    if (!this.config.runtime) {
      this.config.runtime = {};
    }
    this.initialLameDuckMode = Boolean(this.config.runtime.lameDuckMode);
    this.application = application;
    this.healthCheck = healthCheck;
  }

  private registerHealthzEndpoint(): void {
    const alreadyRegistered = Server.activeServerByApp.has(this.application);
    Server.activeServerByApp.set(this.application, this);
    if (!alreadyRegistered) {
      const app = this.application;
      app.get('/healthz', (req: Request, res: Response) => {
        const activeServer = Server.activeServerByApp.get(app);
        if (activeServer) {
          void activeServer.handleHealthz(req, res);
        } else {
          res.status(503).json({ status: 'unhealthy', lameDuckMode: false });
        }
      });
    }
  }

  async isHealthy(): Promise<boolean> {
    if (!this.isInitialized || !this.healthy) {
      return false;
    }
    if (this.healthCheck) {
      try {
        return Boolean(await this.healthCheck());
      } catch (error) {
        console.error('Health check failed:', error);
        return false;
      }
    }
    return true;
  }

  async handleHealthz(_req: Request, res: Response): Promise<void> {
    try {
      if (this.lameDuckMode) {
        res.status(503).json({ status: 'lame_duck', lameDuckMode: true });
        return;
      }
      const healthy = await this.isHealthy();
      if (!healthy) {
        res.status(503).json({ status: 'unhealthy', lameDuckMode: false });
        return;
      }
      res.status(200).json({ status: 'ok', lameDuckMode: false });
    } catch (error) {
      console.error('Health check error:', error);
      res.status(503).json({ status: 'unhealthy', lameDuckMode: this.lameDuckMode });
    }
  }

  evaluateWatchFile(watchFile?: string): void {
    const filePath = watchFile ?? this.config.runtime?.WATCH_FILE;
    if (!filePath) return;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<RuntimeConfig>;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.error(`Watch file must contain a JSON object: ${filePath}`);
        return;
      }
      this.lameDuckMode = 'lameDuckMode' in parsed
        ? Boolean(parsed.lameDuckMode)
        : this.initialLameDuckMode;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        console.warn(`Watch file not found: ${filePath}`);
        this.lameDuckMode = this.initialLameDuckMode;
      } else {
        console.error(`Failed to evaluate watch file ${filePath}:`, error);
      }
    }
  }

  private initializeRuntimeWatchFile(): void {
    this.stopWatchingRuntimeFile();
    const watchFile = this.config.runtime?.WATCH_FILE;
    if (!watchFile) return;

    this.evaluateWatchFile(watchFile);

    const delay = this.config.runtime?.WATCH_FILE_DELAY ?? DEFAULT_WATCH_FILE_DELAY;
    const listener = () => {
      this.evaluateWatchFile(watchFile);
    };
    this.watchedFilePath = watchFile;
    this.watchFileListener = listener;
    fs.watchFile(watchFile, { persistent: false, interval: delay }, listener);
  }

  stopWatchingRuntimeFile(): void {
    if (this.watchedFilePath && this.watchFileListener) {
      fs.unwatchFile(this.watchedFilePath, this.watchFileListener);
      this.watchedFilePath = undefined;
      this.watchFileListener = undefined;
    }
  }

  async start(router: Router): Promise<void> {
    this.registerHealthzEndpoint();
    this.initializeRuntimeWatchFile();
    // TODO: Use logging middleware.
    // Use the router middleware.
    this.application.use(router.expressRouter);
    const host = this.config.service.HOST || 'localhost';
    const port = this.config.service.PORT || 3000;

    const startHttp = 'ENABLE_HTTP' in this.config.service && !!this.config.service.ENABLE_HTTP;
    const startHttps = !!this.config.service.ENABLE_HTTPS;

    if (!startHttp && !startHttps) {
      console.error("Either ENABLE_HTTPS or ENABLE_HTTP must be set for nails to start");
    }

    let atLeastOneServerStarted = false;
    return new Promise<void>((resolve) => {
      if (atLeastOneServerStarted) return resolve();
      const serverStartedCallback = () => {
        console.log("Started");
        atLeastOneServerStarted = true;
        resolve();
      };

      if (startHttp) {
        console.log("starting nails HTTP server. listening to ", host + ':' + port);
        if (this.httpServer) {
          console.warn("Attempted to recreate http server");
        } else {
          this.httpServer = this.application.listen(port, host, serverStartedCallback);
          console.log("Done starting HTTP server");
        }
      }
      if (startHttps) {
        if (this.httpsServer) {
          console.warn("Attempted to recreate HTTPS server");
        } else {
          console.log(`starting nails HTTPS server. Listening to ${host}:${this.config.service.SSL_PORT}`);
          this.httpsServer = https.createServer({
            key: this.config.service.PRIVATE_KEY,
            cert: this.config.service.CERTIFICATE
          }, this.application).listen(this.config.service.SSL_PORT, serverStartedCallback);
        }
      }
      // TODO: Set a startup timeout and reject the promise so it does not hang forever;
    });
  }

  async stop(): Promise<void> {
    this.stopWatchingRuntimeFile();
    const closePromises: Promise<void>[] = [];
    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = undefined;
      closePromises.push(new Promise((resolve) => server.close(() => resolve())));
    }
    if (this.httpsServer) {
      const server = this.httpsServer;
      this.httpsServer = undefined;
      closePromises.push(new Promise((resolve) => server.close(() => resolve())));
    }
    await Promise.all(closePromises);
  }
}
