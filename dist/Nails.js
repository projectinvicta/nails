import fs from 'node:fs';
import path from 'node:path';
import { Model, Sequelize } from 'sequelize';
import expressApp from './application.js';
import Router from './Router.js';
import Server from './Server.js';
import Controller from './Controller.js';
export default class Nails {
    static Controller = Controller;
    static instance;
    static get sequelize() {
        return this.instance.sequelize;
    }
    static get initialized() {
        return this.instance.initialized;
    }
    static get config() {
        return this.instance.config;
    }
    static get application() {
        return this.instance.application;
    }
    static get server() {
        return this.instance.server;
    }
    static get httpServer() {
        return this.instance.httpServer;
    }
    static get httpsServer() {
        return this.instance.httpsServer;
    }
    static get lameDuckMode() {
        return this.instance.lameDuckMode;
    }
    static set lameDuckMode(value) {
        this.instance.lameDuckMode = value;
    }
    modelFinalizations = [];
    modelMigrations = [];
    get httpServer() {
        return this.server.httpServer;
    }
    get httpsServer() {
        return this.server.httpsServer;
    }
    get lameDuckMode() {
        return this.server.lameDuckMode;
    }
    set lameDuckMode(value) {
        this.server.lameDuckMode = value;
    }
    get healthy() {
        return this.server.healthy;
    }
    set healthy(value) {
        this.server.healthy = value;
    }
    constructor(appConfig) {
        Nails.instance = this;
        this.config = appConfig;
        this.application = expressApp;
        this.Models = {};
        this.Controller = Controller;
        this.sequelize = this.config.db.options
            ? new Sequelize(this.config.db.address, this.config.db.options)
            : new Sequelize(this.config.db.address);
        this.router = new Router([]);
        this.server = new Server(this.config, this.application, async () => {
            if (this.sequelize) {
                await this.sequelize.authenticate();
            }
            return true;
        });
        this.initialized = this.configure();
    }
    async configure() {
        expressApp.set('nails_config', { config: this.config });
        expressApp.set('view engine', 'ejs');
        expressApp.set('views', this.config.service.VIEWS_ROOT);
        expressApp.set("public_root", this.config.service.PUBLIC_ROOT);
        console.log("Initializing Router...");
        // this.router = new Router( app_config.routes || [] );
        console.log("Application Router initialized");
        // init models
        try {
            await this.sequelize.authenticate();
            console.log('Connection has been established successfully.');
        }
        catch (error) {
            console.error('Unable to connect to the database:', error);
        }
        await this.initializeModels();
        this.router.addRoute(Server.EVALUATE_HEALTHZ_ROUTE);
        Controller.setRouter(this.router);
        await this.initializeControllers();
        this.router.addRoutes(this.config.routes);
        this.server.isInitialized = true;
    }
    async initializeModels() {
        await this.loadModels(this.config.service.MODELS_ROOT);
        await Promise.all(this.modelFinalizations.map((finalization) => finalization()));
        // TODO: Implement a migration strategy
        await this.sequelize.sync({ alter: { drop: false } });
    }
    async startServer() {
        await this.initialized;
        console.log("CONFIGURATION COMPLETE");
        return this.server.start(this.router);
    }
    async loadModels(absolutePath) {
        if (!fs.existsSync(absolutePath))
            return console.log('Cannot initialize. Path not found.', absolutePath);
        if (!fs.statSync(absolutePath).isFile()) {
            const directory_contents = fs.readdirSync(absolutePath);
            for (const rel_path of directory_contents) {
                await this.loadModels(path.join(absolutePath, rel_path));
            }
            ;
            return;
        }
        console.log('attempting to import Model:', absolutePath);
        // We just need to import each model once so the generateSuperclass
        // method is called at least once for each model.
        const modelModule = await import(absolutePath);
        // TODO: make sure the name isn't constantly "model"
        const modelClass = modelModule.default;
        if (!(modelClass.prototype instanceof Model)) {
            const errorMessage = `Default export is not a sequelize Model: ${absolutePath}`;
            console.error(errorMessage);
            throw errorMessage;
        }
        this.Models[modelClass.name] = modelClass;
        const schema = modelModule.schema;
        const options = modelModule.options;
        const defer = modelModule.defer;
        const afterInitialize = modelModule.afterInitialize;
        if (modelModule.finalize) {
            this.modelFinalizations.push(modelModule.finalize);
        }
        if (modelModule.afterInitializeAll) {
            this.modelFinalizations.push(modelModule.afterInitializeAll);
        }
        this.modelMigrations.push(modelModule.migrate);
        modelClass.init(schema, { sequelize: this.sequelize, ...options });
        if (modelClass && modelClass.name) {
            console.log('imported model:', modelClass.name);
            if (defer) {
                await defer();
            }
            if (afterInitialize) {
                await afterInitialize();
            }
            await modelClass.sync();
        }
        else
            console.warn("No model found at:", absolutePath);
    }
    async initializeControllers(directory) {
        if (!directory)
            directory = this.config.service.CONTROLLERS_ROOT;
        console.log('attempting to import:', directory);
        if (!fs.existsSync(directory))
            return console.error('Cannot initialize. Path not found.', directory);
        if (fs.statSync(directory).isFile()) {
            let subclass = (await import(directory)).default;
            if (!(Controller.isPrototypeOf(subclass)))
                return console.error(`Non-Controller export "${subclass.name}: ${typeof subclass}" found: ${directory}`);
            const controller = new subclass();
            controller._registerControllerRoutes();
            return controller;
        }
        for (const rel_path of fs.readdirSync(directory)) {
            await this.initializeControllers(path.join(directory, rel_path));
        }
    }
}
// const sequelize = new Sequelize();
//# sourceMappingURL=Nails.js.map