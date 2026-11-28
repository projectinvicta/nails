import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import expressApp from './application.js';
const DEFAULT_WATCH_FILE_DELAY = 5000;
export default class Server {
    static activeServerByApp = new WeakMap();
    static EVALUATE_HEALTHZ_ROUTE = [
        'get',
        '/healthz',
        {
            action: ({ request, response }) => {
                const activeServer = Server.activeServerByApp.get(request.app);
                if (activeServer) {
                    return activeServer.handleHealthz(request, response);
                }
                response.sendStatus(503);
            },
        },
    ];
    config;
    application;
    httpServer;
    httpsServer;
    healthy = true;
    isInitialized = false;
    healthCheck;
    initialLameDuckMode = false;
    watchedFilePath;
    watchFileListener;
    get lameDuckMode() {
        return Boolean(this.config.runtime?.lameDuckMode);
    }
    set lameDuckMode(value) {
        if (!this.config.runtime) {
            this.config.runtime = {};
        }
        this.config.runtime.lameDuckMode = value;
    }
    constructor(config, application = expressApp, healthCheck) {
        this.config = config;
        if (!this.config.runtime) {
            this.config.runtime = {};
        }
        this.initialLameDuckMode = Boolean(this.config.runtime.lameDuckMode);
        this.application = application;
        this.healthCheck = healthCheck;
        Server.activeServerByApp.set(this.application, this);
    }
    async isHealthy() {
        if (!this.isInitialized || !this.healthy) {
            return false;
        }
        if (this.healthCheck) {
            try {
                return Boolean(await this.healthCheck());
            }
            catch (error) {
                console.error('Health check failed:', error);
                return false;
            }
        }
        return true;
    }
    async handleHealthz(_req, res) {
        try {
            if (this.lameDuckMode) {
                res.sendStatus(503);
                return;
            }
            const healthy = await this.isHealthy();
            if (!healthy) {
                res.sendStatus(503);
                return;
            }
            res.sendStatus(200);
        }
        catch (error) {
            console.error('Health check error:', error);
            res.sendStatus(503);
        }
    }
    evaluateWatchFile(watchFile) {
        const filePath = watchFile ?? this.config.runtime?.WATCH_FILE;
        if (!filePath)
            return;
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                console.error(`Watch file must contain a JSON object: ${filePath}`);
                return;
            }
            this.lameDuckMode = 'lameDuckMode' in parsed
                ? Boolean(parsed.lameDuckMode)
                : this.initialLameDuckMode;
        }
        catch (error) {
            if (error?.code === 'ENOENT') {
                console.warn(`Watch file not found: ${filePath}`);
                this.lameDuckMode = this.initialLameDuckMode;
            }
            else {
                console.error(`Failed to evaluate watch file ${filePath}:`, error);
            }
        }
    }
    initializeRuntimeWatchFile() {
        this.stopWatchingRuntimeFile();
        const watchFile = this.config.runtime?.WATCH_FILE;
        if (!watchFile)
            return;
        const defaults = {
            lameDuckMode: this.initialLameDuckMode,
        };
        try {
            fs.mkdirSync(path.dirname(watchFile), { recursive: true });
            fs.writeFileSync(watchFile, JSON.stringify(defaults, null, 2), 'utf-8');
        }
        catch (error) {
            console.error(`Failed to write watch file ${watchFile}:`, error);
        }
        this.evaluateWatchFile(watchFile);
        const delay = this.config.runtime?.WATCH_FILE_DELAY ?? DEFAULT_WATCH_FILE_DELAY;
        const listener = () => {
            this.evaluateWatchFile(watchFile);
        };
        this.watchedFilePath = watchFile;
        this.watchFileListener = listener;
        fs.watchFile(watchFile, { persistent: false, interval: delay }, listener);
    }
    stopWatchingRuntimeFile() {
        if (this.watchedFilePath && this.watchFileListener) {
            fs.unwatchFile(this.watchedFilePath, this.watchFileListener);
            this.watchedFilePath = undefined;
            this.watchFileListener = undefined;
        }
    }
    async start(router) {
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
        return new Promise((resolve) => {
            if (atLeastOneServerStarted)
                return resolve();
            const serverStartedCallback = () => {
                console.log("Started");
                atLeastOneServerStarted = true;
                resolve();
            };
            if (startHttp) {
                console.log("starting nails HTTP server. listening to ", host + ':' + port);
                if (this.httpServer) {
                    console.warn("Attempted to recreate http server");
                }
                else {
                    this.httpServer = this.application.listen(port, host, serverStartedCallback);
                    console.log("Done starting HTTP server");
                }
            }
            if (startHttps) {
                if (this.httpsServer) {
                    console.warn("Attempted to recreate HTTPS server");
                }
                else {
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
    async stop() {
        this.stopWatchingRuntimeFile();
        const closePromises = [];
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
//# sourceMappingURL=Server.js.map